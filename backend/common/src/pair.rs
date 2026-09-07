//! 두 데몬(파일 데몬 + 터미널 데몬 termd) 연결 한 쌍을 와이어 한 줄기로 보이게 하는 라우팅·합류
//! (ticket terminal-daemon-split, ws decision/process-topology.md 2026-09-07 개정). 로컬 relay 와
//! 원격 헬퍼(`superlite-daemon --pipe`)가 같은 규칙을 써야 하므로 여기 둔다.
//!
//! 올라가는 방향: 요청 한 줄을 메서드명으로 골라 한쪽에만 쓴다 (attach·ping 은 양쪽). 요청 하나가
//! 소켓 하나로만 가므로 응답 id 는 합류해도 충돌하지 않는다. "중계자는 내용을 해석하지 않는다"
//! 원칙의 유일한 예외가 이 메서드명 분기다.
//!
//! 내려오는 방향: 두 소켓의 프레임(JSON 줄 / 0x00 매직 + 4B BE 길이의 바이너리 payload, 와이어
//! v6)을 프레임 단위로 합류한다 — 바이트 단위로 섞으면 payload 가 깨진다. attach 응답만 특별하다:
//! 양쪽 응답을 모아 **하나만** 내보낸다 (프론트는 id 0 응답 하나의 resumed 로 세션 회수를
//! 판단한다). 둘 다 성공이면 termd 것(터미널 resumed 가 실린다), 어느 쪽이든 에러면 그 에러를
//! 즉시 (데몬은 에러 뒤 연결을 닫는다 — 에러 줄이 EOF 보다 먼저 온다).

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// payload 프레임의 상한 — READ_MAX_BYTES(50MB)보다 넉넉한 방어선. 초과는 프레임
/// 오염(동기화 깨짐)으로 보고 연결을 닫는다.
pub const PAYLOAD_MAX: u32 = 64 * 1024 * 1024;

/// 데몬 IPC 의 프레임 하나 — JSON 줄(Line) 또는 바이너리 payload(Bin, 0x00 매직 + 4B BE 길이 뒤의
/// 본문. 매직·길이는 벗겨져 있다)
pub enum Frame {
    Line(String),
    Bin(Vec<u8>),
}

/// 다음 프레임 — 첫 바이트로 구분한다 (JSON 줄은 항상 '{'). 순차 읽기 전용 — select 안에서
/// 쓰면 취소 시 부분 읽기가 유실돼 프레임 동기가 깨진다 (전용 태스크에서만 호출할 것)
pub async fn read_frame<R: AsyncRead + Unpin>(
    r: &mut BufReader<R>,
) -> std::io::Result<Option<Frame>> {
    let mut first = [0u8; 1];
    if r.read_exact(&mut first).await.is_err() {
        return Ok(None); // EOF — 데몬 연결 종료
    }
    if first[0] == 0x00 {
        let len = r.read_u32().await?;
        if len > PAYLOAD_MAX {
            return Err(std::io::Error::other("payload 길이 초과 — 프레임 오염"));
        }
        let mut buf = vec![0u8; len as usize];
        r.read_exact(&mut buf).await?;
        return Ok(Some(Frame::Bin(buf)));
    }
    let mut line = vec![first[0]];
    r.read_until(b'\n', &mut line).await?;
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    match String::from_utf8(line) {
        Ok(s) => Ok(Some(Frame::Line(s))),
        Err(_) => Err(std::io::Error::other("비 UTF-8 줄 — 프레임 오염")),
    }
}

/// 프레임을 IPC 바이트로 되돌린다 (개행 / 0x00 + 길이 접두)
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, f: &Frame) -> std::io::Result<()> {
    match f {
        Frame::Line(l) => {
            w.write_all(l.as_bytes()).await?;
            w.write_all(b"\n").await
        }
        Frame::Bin(b) => {
            w.write_all(&[0u8]).await?;
            w.write_all(&(b.len() as u32).to_be_bytes()).await?;
            w.write_all(b).await
        }
    }
}

/// termd 가 다루는 메서드 — TERM_WIRE_VERSION 1 의 표면 (attach·ping 은 양쪽 공통이라 제외)
pub fn is_term_method(m: &str) -> bool {
    matches!(
        m,
        "createTerminal"
            | "termWrite"
            | "termResize"
            | "termAck"
            | "disposeTerminal"
            | "adoptTerminal"
            | "frontRequest"
            | "requestReply"
    )
}

/// 요청 한 줄의 목적지
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Files,
    Term,
    Both,
}

/// 메서드명으로 목적지를 고른다 — attach·ping 은 양쪽, termd 메서드는 Term, 나머지(파싱 실패
/// 포함 — 파일 데몬이 거부한다)는 Files
pub fn route(line: &str) -> Route {
    let v: Value = serde_json::from_str(line).unwrap_or_default();
    match v["method"].as_str().unwrap_or("") {
        "attach" | "ping" => Route::Both,
        m if is_term_method(m) => Route::Term,
        _ => Route::Files,
    }
}

/// 두 데몬 쓰기 반쪽 — send_line 이 route 대로 나눠 쓴다
pub struct PairWriter<W> {
    pub files: W,
    pub term: W,
}

impl<W: AsyncWrite + Unpin> PairWriter<W> {
    pub async fn send_line(&mut self, line: &str) -> std::io::Result<()> {
        let r = route(line);
        if r != Route::Term {
            write_line(&mut self.files, line).await?;
        }
        if r != Route::Files {
            write_line(&mut self.term, line).await?;
        }
        Ok(())
    }
}

async fn write_line<W: AsyncWrite + Unpin>(w: &mut W, s: &str) -> std::io::Result<()> {
    w.write_all(s.as_bytes()).await?;
    w.write_all(b"\n").await
}

#[derive(Clone, Copy)]
enum Side {
    Files,
    Term,
}

/// 합류 스트림의 수신 쪽 — drop 이 읽기 태스크를 abort 해 두 읽기 반쪽을 놓는다.
/// WHY: split 된 소켓은 양쪽 반쪽이 다 drop 돼야 닫힌다. 읽기 태스크가 살아 있으면 relay 가
///      쓰기 반쪽을 버려도 데몬은 EOF 를 못 보고, 세션이 detach 로 안 넘어가 끊김 중 출력이
///      죽은 연결로 새어 나갔다 (check-reconnect 의 detach 버퍼 flush 실패로 드러남)
pub struct Merged {
    rx: mpsc::UnboundedReceiver<Frame>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Merged {
    pub async fn recv(&mut self) -> Option<Frame> {
        self.rx.recv().await
    }
}

impl Drop for Merged {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// 두 읽기 반쪽을 프레임 단위로 합류한 스트림. `attach_id` 는 양쪽에 보낸 attach 요청의 id —
/// 그 id 의 응답을 하나로 접는다. 어느 쪽이든 EOF·오염이면 스트림이 끝난다 (연결 하나가 죽으면
/// 세션 전체를 다시 붙이는 것이 프론트의 재연결 규칙). 채널은 상한 없음 — 배압은 termAck
/// (터미널)·요청 단위(파일) 계층이 이미 담당하고, 종전 relay 도 소켓→WS 사이에 버퍼 상한이 없었다
pub fn spawn_merger<R: AsyncRead + Unpin + Send + 'static>(
    files: R,
    term: R,
    attach_id: Value,
) -> Merged {
    let (tx, rx) = mpsc::unbounded_channel::<Frame>();
    let mut tasks = Vec::new();
    // None = 그쪽 EOF·오염 — 합류 스트림 전체를 끝낸다
    let (mtx, mut mrx) = mpsc::unbounded_channel::<(Side, Option<Frame>)>();
    for (side, r) in [(Side::Files, files), (Side::Term, term)] {
        let mtx = mtx.clone();
        tasks.push(tokio::spawn(async move {
            let mut r = BufReader::new(r);
            while let Ok(Some(f)) = read_frame(&mut r).await {
                if mtx.send((side, Some(f))).is_err() {
                    return;
                }
            }
            let _ = mtx.send((side, None));
        }));
    }
    drop(mtx);
    tasks.push(tokio::spawn(async move {
        let mut pending = Some((attach_id, false, false)); // (id, files 성공 봄, term 성공 프레임)
        let mut term_attach: Option<Frame> = None;
        while let Some((side, f)) = mrx.recv().await {
            let Some(f) = f else { return }; // 한쪽 종료 → tx drop → 수신자가 None 을 본다
            if let Some((id, files_ok, term_ok)) = pending.as_mut() {
                if let Frame::Line(l) = &f {
                    let v: Value = serde_json::from_str(l).unwrap_or_default();
                    if v["id"] == *id {
                        if !v["error"].is_null() {
                            let _ = tx.send(f); // 에러는 즉시 — 그 데몬은 곧 연결을 닫는다
                            pending = None;
                            continue;
                        }
                        match side {
                            Side::Files => *files_ok = true,
                            Side::Term => {
                                *term_ok = true;
                                term_attach = Some(f);
                            }
                        }
                        if *files_ok && *term_ok {
                            if let Some(a) = term_attach.take() {
                                let _ = tx.send(a);
                            }
                            pending = None;
                        }
                        continue;
                    }
                }
            }
            if tx.send(f).is_err() {
                return;
            }
        }
    }));
    Merged { rx, tasks }
}
