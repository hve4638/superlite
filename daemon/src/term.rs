//! PTY 터미널 — 생성·입출력·리사이즈·정리.
//! 입력 순서 보장이 필요해 read 루프에서 즉시 처리한다 (전부 논블로킹).
//! 출력은 연결이 아니라 세션의 Sink 로 나간다 — 연결이 끊겨도 리더 스레드는 계속 돌고,
//! 이벤트는 버퍼에 쌓였다가 재접속 시 flush 된다.

use std::collections::{HashMap, VecDeque};
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::err;

pub(crate) struct Term {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub(crate) type Terms = Arc<Mutex<HashMap<u64, Term>>>;

/// 끊김 중 버퍼 상한 — 초과분은 오래된 것부터 버린다 (스크롤백 유실과 동일한 성격).
/// ponytail: 다른 터미널의 폭주가 termExit 를 밀어낼 수 있다 — flow control 이 출력 자체를
///           고수위에서 멈추면 실질적으로 도달하지 않는 상한이다.
const DETACH_BUFFER_MAX: usize = 1 << 20;

/// 터미널 이벤트의 세션 스코프 출구 — 리더 스레드는 연결을 모른다.
pub(crate) enum SinkState {
    Attached(UnboundedSender<String>),
    /// (이벤트 버퍼, 총 바이트) — 재접속 시 순서대로 flush
    Detached(VecDeque<String>, usize),
}

pub(crate) type Sink = Arc<Mutex<SinkState>>;

pub(crate) fn sink_send(sink: &Sink, msg: String) {
    match &mut *sink.lock().unwrap() {
        SinkState::Attached(tx) => {
            let _ = tx.send(msg); // 실패 = 연결 사망 직후 — 곧 Detached 로 바뀐다, 그 사이 분은 유실
        }
        SinkState::Detached(buf, bytes) => {
            *bytes += msg.len();
            buf.push_back(msg);
            while *bytes > DETACH_BUFFER_MAX {
                match buf.pop_front() {
                    Some(old) => *bytes -= old.len(),
                    None => break,
                }
            }
        }
    }
}

// WHY: portable-pty 의 kill 은 SIGHUP 후 최대 200ms 를 재우며 대기한다 — read 루프/워커를
//      막지 않게 스레드로 보내고, wait 까지 해서 좀비를 남기지 않는다.
pub(crate) fn kill_term(mut t: Term) {
    std::thread::spawn(move || {
        let _ = t.child.kill();
        let _ = t.child.wait();
    });
}

pub(crate) fn handle_term(method: &str, p: &Value, terms: &Terms, sink: &Sink, root: &Path) {
    let id = p["term"].as_u64().unwrap_or(0);
    match method {
        "createTerminal" => {
            // 같은 id 재생성은 무시 — 수락하면 기존 PTY 가 회수 없이 샌다
            if terms.lock().unwrap().contains_key(&id) {
                return;
            }
            let cols = p["cols"].as_u64().unwrap_or(80) as u16;
            let rows = p["rows"].as_u64().unwrap_or(24) as u16;
            if let Err(e) = spawn_term(id, cols, rows, root, terms.clone(), sink.clone()) {
                let msg = json!({"event": "termData", "term": id, "data": format!("pty 생성 실패: {e}\r\n")});
                sink_send(sink, msg.to_string());
                sink_send(sink, json!({"event": "termExit", "term": id}).to_string());
            }
        }
        "termWrite" => {
            if let Some(t) = terms.lock().unwrap().get_mut(&id) {
                // ponytail: 자식이 stdin 을 안 읽으면 pty write 가 블로킹될 수 있다(대량 붙여넣기)
                //           — read 루프 정지를 감수. 문제되면 터미널별 쓰기 스레드로 분리.
                let _ = t.writer.write_all(p["data"].as_str().unwrap_or("").as_bytes());
            }
        }
        "termResize" => {
            if let Some(t) = terms.lock().unwrap().get(&id) {
                let _ = t.master.resize(PtySize {
                    rows: p["rows"].as_u64().unwrap_or(24) as u16,
                    cols: p["cols"].as_u64().unwrap_or(80) as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
        "disposeTerminal" => {
            if let Some(t) = terms.lock().unwrap().remove(&id) {
                kill_term(t);
            }
        }
        _ => unreachable!(),
    }
}

fn spawn_term(
    id: u64,
    cols: u16,
    rows: u16,
    root: &Path,
    terms: Terms,
    sink: Sink,
) -> Result<(), String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(root);
    cmd.env("TERM", "xterm-256color");
    let child = pty.slave.spawn_command(cmd).map_err(err)?;
    let writer = pty.master.take_writer().map_err(err)?;
    let mut reader = pty.master.try_clone_reader().map_err(err)?;
    // WHY: 리더 스레드가 종료 시 맵에서 자기 항목을 지우므로, 스레드 시작 전에 등록해야
    //      즉사한 셸이 맵에 유령으로 남는 race 가 없다
    terms.lock().unwrap().insert(id, Term { writer, master: pty.master, child });
    // WHY: portable-pty 의 reader 는 블로킹 — 전용 스레드에서 읽어 writer 채널로 넘긴다
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new(); // 청크 경계에서 잘린 UTF-8 꼬리
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            let (text, rest) = split_valid_utf8(&carry);
            carry = rest;
            if !text.is_empty() {
                sink_send(&sink, json!({"event": "termData", "term": id, "data": text}).to_string());
            }
        }
        // read 종료 = 셸 자연 종료 또는 세션 회수(kill) — 맵에서 제거해 fd/좀비 누수를 막는다
        if let Some(mut t) = terms.lock().unwrap().remove(&id) {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
        sink_send(&sink, json!({"event": "termExit", "term": id}).to_string());
    });
    Ok(())
}

/// 유효한 UTF-8 프리픽스와 잘린 꼬리를 분리. 진짜 깨진 바이트면 손실 변환으로 전부 내보낸다.
fn split_valid_utf8(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) if e.error_len().is_some() => (String::from_utf8_lossy(bytes).into_owned(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            (std::str::from_utf8(&bytes[..valid]).unwrap().to_string(), bytes[valid..].to_vec())
        }
    }
}
