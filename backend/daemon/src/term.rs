//! PTY 터미널 — 생성·입출력·리사이즈·정리.
//! 입력 순서 보장이 필요해 read 루프에서 즉시 처리한다 (전부 논블로킹).
//! 출력은 연결이 아니라 세션의 Sink 로 나간다 — 연결이 끊겨도 리더 스레드는 계속 돌고,
//! 이벤트는 버퍼에 쌓였다가 재접속 시 flush 된다.

use std::collections::{HashMap, VecDeque};
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::err;

pub(crate) struct Term {
    /// 전용 쓰기 스레드로 가는 입력 채널 — pty write 는 블로킹될 수 있어(배압으로 셸이
    /// 출력에서 막히면 입력 큐도 찬다) read 루프에서 직접 쓰면 termAck 까지 막는 데드락
    input: std::sync::mpsc::Sender<String>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    flow: Arc<Flow>,
}

pub(crate) type Terms = Arc<Mutex<HashMap<u64, Term>>>;

// VS Code 터미널 flow control 상수 (terminalProcess) — 단위는 UTF-16 코드유닛
// (프론트 data.length 와 일치시키려고 encode_utf16 으로 센다)
const HIGH_WATERMARK_CHARS: u64 = 100_000;
const LOW_WATERMARK_CHARS: u64 = 5_000;

/// 터미널별 ack 기반 배압 — 미ack 이 high 를 넘으면 리더 스레드가 멈추고,
/// ack 로 low 이하가 되면 재개한다. 느린 회선에서 출력 폭주가 메모리·지연으로
/// 쌓이는 대신 PTY 버퍼(커널)가 셸을 자연히 막게 한다.
pub(crate) struct Flow {
    state: Mutex<FlowState>,
    cv: Condvar,
}

struct FlowState {
    unacked: u64,
    /// kill 시 true — 대기 중인 리더를 깨워 스레드가 read 종료 경로로 빠지게 한다
    dead: bool,
}

impl Flow {
    fn new() -> Arc<Self> {
        Arc::new(Flow { state: Mutex::new(FlowState { unacked: 0, dead: false }), cv: Condvar::new() })
    }

    /// 보낸 만큼 더하고, high 를 넘겼으면 low 이하로 내려올 때까지 대기
    fn add_and_wait(&self, n: u64) {
        let mut s = self.state.lock().unwrap();
        s.unacked += n;
        while s.unacked > HIGH_WATERMARK_CHARS && !s.dead {
            s = self.cv.wait(s).unwrap();
        }
    }

    fn ack(&self, n: u64) {
        let mut s = self.state.lock().unwrap();
        s.unacked = s.unacked.saturating_sub(n);
        if s.unacked <= LOW_WATERMARK_CHARS {
            self.cv.notify_all();
        }
    }

    fn reset(&self) {
        let mut s = self.state.lock().unwrap();
        s.unacked = 0;
        self.cv.notify_all();
    }

    fn kill(&self) {
        let mut s = self.state.lock().unwrap();
        s.dead = true;
        self.cv.notify_all();
    }
}

/// 세션 전 터미널의 배압 카운터 리셋 — 재접속 시 프론트 수신 카운터와 함께 0 에서
/// 재시작한다 (끊기는 순간 유실된 프레임 몫이 미ack 로 영구 누적되는 것을 방지)
pub(crate) fn reset_flow(terms: &Terms) {
    for t in terms.lock().unwrap().values() {
        t.flow.reset();
    }
}

/// 끊김 중 버퍼 상한 — 초과분은 termData 만 오래된 것부터 버린다 (스크롤백 유실과 동일한
/// 성격). termExit 는 보존한다 — 프론트 탭 수명이 termExit 하나에 의존하므로(자가 복구
/// 경로 없음) 유실되면 유령 탭이 남는다. termExit 는 터미널당 1건·수십 바이트라
/// 보존분이 상한을 의미 있게 넘길 수 없다.
const DETACH_BUFFER_MAX: usize = 1 << 20;

/// 터미널 이벤트의 세션 스코프 출구 — 리더 스레드는 연결을 모른다.
pub(crate) enum SinkState {
    Attached(UnboundedSender<String>),
    /// (이벤트 버퍼 — (버려도 되는가, 이벤트), 총 바이트) — 재접속 시 순서대로 flush
    Detached(VecDeque<(bool, String)>, usize),
}

pub(crate) type Sink = Arc<Mutex<SinkState>>;

/// evictable — 버퍼 초과 시 버려도 되는가. termData 만 true (스크롤백 성격),
/// termExit 는 false 로 보존한다.
pub(crate) fn sink_send(sink: &Sink, msg: String, evictable: bool) {
    match &mut *sink.lock().unwrap() {
        SinkState::Attached(tx) => {
            let _ = tx.send(msg); // 실패 = 연결 사망 직후 — 곧 Detached 로 바뀐다, 그 사이 분은 유실
        }
        SinkState::Detached(buf, bytes) => {
            *bytes += msg.len();
            buf.push_back((evictable, msg));
            // 앞(오래된 쪽)부터 evictable 만 골라 버린다 — 보존 항목은 자리·순서 유지.
            // 보존 항목은 소수·소형이라 스캔 비용은 무시할 수준
            let mut i = 0;
            while *bytes > DETACH_BUFFER_MAX && i < buf.len() {
                if buf[i].0 {
                    *bytes -= buf[i].1.len();
                    buf.remove(i);
                } else {
                    i += 1;
                }
            }
        }
    }
}

// WHY: portable-pty 의 kill 은 SIGHUP 후 최대 200ms 를 재우며 대기한다 — read 루프/워커를
//      막지 않게 스레드로 보내고, wait 까지 해서 좀비를 남기지 않는다.
pub(crate) fn kill_term(mut t: Term) {
    t.flow.kill(); // 배압 대기 중인 리더를 깨워야 스레드가 회수된다
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
                sink_send(sink, msg.to_string(), true);
                // code 없는 termExit = 비정상 — 프론트가 탭을 유지해 위 에러 출력을 보여준다
                sink_send(sink, json!({"event": "termExit", "term": id}).to_string(), false);
            }
        }
        "termWrite" => {
            if let Some(t) = terms.lock().unwrap().get(&id) {
                // 채널 send 는 논블로킹 — 실제 pty write 는 전용 스레드가 한다.
                // ponytail: 입력 큐 무한 — 사람 입력·붙여넣기 규모라 상한 없이 둔다
                let _ = t.input.send(p["data"].as_str().unwrap_or("").to_string());
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
        "termAck" => {
            if let Some(t) = terms.lock().unwrap().get(&id) {
                t.flow.ack(p["chars"].as_u64().unwrap_or(0));
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
    #[cfg(unix)]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    // Windows 는 $SHELL 규약이 없다 — ComSpec(cmd.exe)이 대응물. ponytail: PowerShell 선호는 설정 몫
    #[cfg(windows)]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(root);
    // ConPTY 세계엔 TERM 규약이 없다 — 심어두면 Windows 태생 도구들이 오판한다
    #[cfg(unix)]
    cmd.env("TERM", "xterm-256color");
    let child = pty.slave.spawn_command(cmd).map_err(err)?;
    let mut writer = pty.master.take_writer().map_err(err)?;
    let mut reader = pty.master.try_clone_reader().map_err(err)?;
    let flow = Flow::new();
    // 터미널별 쓰기 스레드 — Term drop(dispose·회수) 으로 채널이 닫히면 끝난다.
    // 막힌 write 중이라면 child kill 후 pty 쪽 에러로 풀린다
    let (input, input_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        while let Ok(data) = input_rx.recv() {
            if writer.write_all(data.as_bytes()).is_err() {
                break;
            }
        }
    });
    // WHY: 리더 스레드가 종료 시 맵에서 자기 항목을 지우므로, 스레드 시작 전에 등록해야
    //      즉사한 셸이 맵에 유령으로 남는 race 가 없다
    terms
        .lock()
        .unwrap()
        .insert(id, Term { input, master: pty.master, child, flow: flow.clone() });
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
                // WHY: 배압 단위는 프론트의 data.length(UTF-16)와 같아야 ack 가 상쇄된다
                let chars = text.encode_utf16().count() as u64;
                sink_send(&sink, json!({"event": "termData", "term": id, "data": text}).to_string(), true);
                // 미ack 이 고수위를 넘으면 여기서 멈춘다 — PTY 커널 버퍼가 차면 셸도 멈춘다
                flow.add_and_wait(chars);
            }
        }
        // read 종료 = 셸 자연 종료 또는 세션 회수(kill) — 맵에서 제거해 fd/좀비 누수를 막는다.
        // WHY: if let 스크루티니의 임시 가드는 블록 끝까지 산다 — kill/wait 를 락 밖에서
        let removed = terms.lock().unwrap().remove(&id);
        // 자연 종료면 wait 가 exit code 를 준다 (이미 죽은 프로세스라 kill 은 무해).
        // dispose·회수 경로(맵에 없음)는 code 없이 — 프론트가 어차피 무시하는 termExit 다
        let code = removed.and_then(|mut t| {
            let _ = t.child.kill();
            t.child.wait().ok().map(|s| s.exit_code())
        });
        let mut msg = json!({"event": "termExit", "term": id});
        if let Some(c) = code {
            msg["code"] = json!(c);
        }
        sink_send(&sink, msg.to_string(), false);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 버퍼 초과 eviction 이 termData(evictable)만 버리고 termExit(보존)는 순서 그대로
    /// 남기는지 — 유실되면 프론트에 유령 탭이 남는 회귀를 막는다
    #[test]
    fn eviction_keeps_non_evictable() {
        let sink: Sink = Arc::new(Mutex::new(SinkState::Detached(VecDeque::new(), 0)));
        sink_send(&sink, "old-data".into(), true);
        sink_send(&sink, "exit-1".into(), false);
        let big = "d".repeat(200 * 1024);
        for _ in 0..6 {
            sink_send(&sink, big.clone(), true); // 총 1.2MiB — 상한(1MiB)을 넘긴다
        }
        let guard = sink.lock().unwrap();
        let SinkState::Detached(buf, bytes) = &*guard else { panic!("Detached 여야 한다") };
        assert_eq!(buf.front().unwrap().1, "exit-1", "termExit 는 보존되어야 한다");
        assert!(buf.iter().all(|(_, m)| m != "old-data"), "가장 오래된 termData 는 버려져야 한다");
        assert!(*bytes <= DETACH_BUFFER_MAX);
        assert_eq!(*bytes, buf.iter().map(|(_, m)| m.len()).sum::<usize>(), "바이트 정산 일치");
    }
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
