//! PTY 터미널 — 생성·입출력·리사이즈·정리.
//! 입력 순서 보장이 필요해 read 루프에서 즉시 처리한다 (전부 논블로킹).
//! 출력은 연결이 아니라 세션의 Sink 로 나간다 — 연결이 끊겨도 리더 스레드는 계속 돌고,
//! 이벤트는 버퍼에 쌓였다가 재접속 시 flush 된다.

use std::collections::{HashMap, VecDeque};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    budget: Arc<InputBudget>,
    /// 출력 경로 — 리더·쓰기 스레드가 매 전송마다 읽는다. adopt(세션 간 이동)가 갈아끼운다
    route: Arc<Mutex<Route>>,
    /// tmux 클라이언트면 이 pty 의 슬레이브 tty (detach-client -t 대상). None = plain (SIGHUP).
    /// tmux 는 SIGHUP·master 급종료가 그 pane(셸)까지 죽여서(실측 2026-09-07) detach-client 로 clean
    /// detach 하고, 서버가 그 detach 를 처리한 뒤에야 master 를 닫는다 (tmux::wait_client_gone)
    detach: Option<String>,
    /// 이 pty 의 슬레이브 tty (unix) — plain 셸이면 셸의 tty 그 자체. askpass 요청자가 자기 tty 로
    /// "지금 이 터미널을 보는 세션" 을 찾는 좌표 (owner_of)
    tty: Option<String>,
    /// tmux 방식이면 붙어 있는 tmux 세션 id — pane tty 로 세션 id 를 얻은 요청자와 대조한다
    tmux_id: Option<String>,
    /// 붙은 시각 — 같은 tmux 세션을 여러 세션이 볼 때 가장 늦게 붙은 쪽을 고르는 기준 (터미널 id 는
    /// 프론트가 세션마다 매겨 세션 간 비교가 안 된다)
    attached_at: std::time::Instant,
}

/// 요청자(credential helper·셸 심)의 좌표로 이 세션의 터미널을 찾는다 — tmux 세션 id 가 있으면 그것으로,
/// 아니면 plain 셸의 tty 로. 같은 tmux 세션을 여러 탭이 보면 가장 늦게 붙은 것. 반환은 붙은 시각
pub(crate) fn owner_of(terms: &Terms, tty: &str, tmux_id: Option<&str>) -> Option<std::time::Instant> {
    terms
        .lock()
        .unwrap()
        .values()
        .filter(|t| match tmux_id {
            Some(sid) => t.tmux_id.as_deref() == Some(sid),
            None => t.tmux_id.is_none() && t.tty.as_deref() == Some(tty),
        })
        .map(|t| t.attached_at)
        .max()
}

/// master pty 의 슬레이브 tty 경로 (detach-client -t 대상) — ptsname 은 정적 버퍼라 직렬화한다.
/// unix 전용 (Windows 는 tmux 가 없어 detach 대상도 없다)
#[cfg(unix)]
fn pts_name(fd: std::os::unix::io::RawFd) -> Option<String> {
    use std::sync::Mutex;
    static LK: Mutex<()> = Mutex::new(());
    let _g = LK.lock().unwrap();
    // SAFETY: fd 는 열린 master pty. 반환 포인터는 정적 버퍼 — 락 안에서 즉시 복사한다
    let p = unsafe { libc::ptsname(fd) };
    if p.is_null() {
        return None;
    }
    unsafe { std::ffi::CStr::from_ptr(p) }.to_str().ok().map(str::to_string)
}

pub(crate) type Terms = Arc<Mutex<HashMap<u64, Term>>>;

/// 세션에 살아 있는 터미널 id 목록 (와이어 v22 attach 응답 terms) — 오름차순
pub(crate) fn ids(terms: &Terms) -> Vec<u64> {
    let mut v: Vec<u64> = terms.lock().unwrap().keys().copied().collect();
    v.sort_unstable();
    v
}

/// 터미널 id 로 붙어 있는 tmux 세션 id (와이어 v21 termCwd) — plain 이거나 없는 터미널이면 None
pub(crate) fn tmux_id_of(terms: &Terms, id: u64) -> Option<String> {
    terms.lock().unwrap().get(&id).and_then(|t| t.tmux_id.clone())
}

/// 터미널 이벤트가 나가는 곳 — (이 세션 안의 term id, 세션 sink, 소속 terms 맵).
/// WHY: 스레드가 id·sink 를 값으로 잡으면 터미널을 다른 세션으로 옮길 수 없다 (와이어 v10
///      adoptTerminal — 에디터·터미널 탭을 다른 창의 세션으로 끌어 옮기는 데 필요).
///      한 겹 간접층으로 두고 전송 직전에 읽는다 — 락은 짧고 경합은 사실상 없다
pub(crate) struct Route {
    id: u64,
    sink: Sink,
    terms: Terms,
}

impl Route {
    fn snapshot(r: &Arc<Mutex<Route>>) -> (u64, Sink) {
        let g = r.lock().unwrap();
        (g.id, g.sink.clone())
    }
}

/// 터미널을 다른 세션으로 옮긴다 (와이어 v10 adoptTerminal) — from 의 from_id 를 떼어 to 의
/// to_id 로 붙이고 출력 경로를 to 의 sink 로 돌린다. 배압 카운터는 리셋 — 받는 쪽 연결은
/// 0 에서 세기 시작한다. root 일치 검사는 호출자(main) 몫.
/// 락 순서: from → (놓고) route → (놓고) to. terms 락 아래에서 route 를 잡지 않는다
pub(crate) fn adopt(from: &Terms, from_id: u64, to: &Terms, to_id: u64, to_sink: &Sink) -> Result<(), String> {
    if to.lock().unwrap().contains_key(&to_id) {
        return Err("term id 충돌".into());
    }
    let Some(t) = from.lock().unwrap().remove(&from_id) else {
        return Err("출처 터미널 없음".into());
    };
    {
        let mut r = t.route.lock().unwrap();
        r.id = to_id;
        r.sink = to_sink.clone();
        r.terms = to.clone();
    }
    t.flow.reset();
    to.lock().unwrap().insert(to_id, t);
    Ok(())
}

// VS Code 터미널 flow control 상수 (terminalProcess) — 단위는 UTF-16 코드유닛
// (프론트 data.length 와 일치시키려고 encode_utf16 으로 센다)
const HIGH_WATERMARK_CHARS: u64 = 100_000;
const LOW_WATERMARK_CHARS: u64 = 5_000;

// 입력 큐 안전판(바이트) — 프론트가 입력 배압 창(termInputAck 기반)을 지키면 도달하지
// 않는다. 터미널별 상한은 한 터미널의 폭주를 그 터미널에 가두고(다른 터미널 입력은
// 정상), 전역 상한은 데몬 프로세스 메모리의 마지막 방어선이다.
const TERM_INPUT_MAX_BYTES: usize = 8 * 1024 * 1024;
const GLOBAL_INPUT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// 데몬 전체(세션 불문) 입력 큐 적재량
static GLOBAL_INPUT_BYTES: AtomicUsize = AtomicUsize::new(0);

/// 터미널별 입력 큐 예산 — 상한 검사는 근사면 충분한 안전판이라 원자 카운터로 끝낸다
pub(crate) struct InputBudget {
    bytes: AtomicUsize,
    /// 상한 초과로 폐기 중인가 — 폐기 안내를 에피소드당 한 번만 찍는다 (큐가 비면 해제)
    dropping: AtomicBool,
}

impl InputBudget {
    fn new() -> Arc<Self> {
        Arc::new(InputBudget { bytes: AtomicUsize::new(0), dropping: AtomicBool::new(false) })
    }

    /// 터미널·전역 상한 안에서 n 바이트 확보 — 초과면 되돌리고 false (폐기 신호)
    fn try_reserve(&self, n: usize) -> bool {
        let g = GLOBAL_INPUT_BYTES.fetch_add(n, Ordering::Relaxed);
        let t = self.bytes.fetch_add(n, Ordering::Relaxed);
        if g + n > GLOBAL_INPUT_MAX_BYTES || t + n > TERM_INPUT_MAX_BYTES {
            GLOBAL_INPUT_BYTES.fetch_sub(n, Ordering::Relaxed);
            self.bytes.fetch_sub(n, Ordering::Relaxed);
            return false;
        }
        true
    }

    /// 큐에서 빠진 몫 반환. 큐가 비면 폐기 에피소드도 종료
    fn release(&self, n: usize) {
        GLOBAL_INPUT_BYTES.fetch_sub(n, Ordering::Relaxed);
        if self.bytes.fetch_sub(n, Ordering::Relaxed) == n {
            self.dropping.store(false, Ordering::Relaxed);
        }
    }

    /// 폐기 에피소드 진입 — 처음일 때만 true (안내 1회 조건)
    fn begin_dropping(&self) -> bool {
        !self.dropping.swap(true, Ordering::Relaxed)
    }
}

// WHY: 쓰기 스레드의 종료 drain 직후 send 가 끼어들면 그 몫이 반환되지 않는다 — 터미널
//      카운터는 Term 과 함께 사라지지만 전역 카운터는 프로세스 수명 내내 남아 단조
//      누적된다. 마지막 보유자(Term·쓰기 스레드)가 사라질 때 잔여분을 전역에서 빼 닫는다
impl Drop for InputBudget {
    fn drop(&mut self) {
        GLOBAL_INPUT_BYTES.fetch_sub(self.bytes.load(Ordering::Relaxed), Ordering::Relaxed);
    }
}

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
// tmux 클라이언트는 아래 WHY 대로 detach-client 로 물러나게 한다(세션·셸이 산다). plain 은 종전대로
// SIGHUP 으로 셸을 끝낸다.
pub(crate) fn kill_term(mut t: Term) {
    t.flow.kill(); // 배압 대기 중인 리더를 깨워야 스레드가 회수된다
    std::thread::spawn(move || {
        // WHY: tmux 는 detach-client 로 먼저 clean detach 한다 — master(pty)나 writer 를 먼저 닫으면
        //      클라이언트가 아직 붙은 채 HUP 을 받아 급종료되고, tmux 가 그 pane(셸)까지 destroy
        //      한다(실측 2026-09-07). clean detach 는 tmux 세션·셸을 살린다. detach 는 클라이언트를
        //      스스로 종료시키므로, wait 로 종료를 확인한 뒤에야 t(master·writer)를 떨군다.
        match &t.detach {
            Some(tty) => {
                if let Some(bin) = crate::tmux::bin() {
                    let _ = std::process::Command::new(bin).args(crate::tmux::detach_args(tty)).output();
                    let _ = t.child.wait(); // 클라이언트 프로세스 종료
                    // 서버가 detach 를 완전히 처리(클라이언트 목록에서 제거)한 뒤에야 master 를 닫는다
                    crate::tmux::wait_client_gone(bin, tty, std::time::Duration::from_secs(2));
                }
            }
            None => {
                let _ = t.child.kill(); // plain: SIGHUP 으로 셸을 끝낸다
                let _ = t.child.wait();
            }
        }
        drop(t); // master·writer 를 닫는다 (tmux 는 클라이언트가 이미 나갔으므로 무영향)
    });
}

/// session — PTY 환경변수 SUPERLITE_SESSION 으로 셸에 알릴 세션 id (익명 세션은 None)
pub(crate) fn handle_term(
    method: &str,
    p: &Value,
    terms: &Terms,
    sink: &Sink,
    root: &Path,
    session: Option<&str>,
) {
    let id = p["term"].as_u64().unwrap_or(0);
    match method {
        "createTerminal" => {
            // 같은 id 재생성은 거부 — 수락하면 기존 PTY 가 회수 없이 샌다. 종전엔 조용히 무시해
            // 프론트의 새 핸들이 옛 PTY(다른 tmux 세션)에 그대로 묶였다 (ticket
            // multi-client-terminal-crosstalk) — 그 터미널 화면에 사유를 내고 비정상 종료로 드러낸다
            if terms.lock().unwrap().contains_key(&id) {
                let msg = json!({"event": "termData", "term": id,
                    "data": "[superlite: 터미널 id 충돌 — 이 세션에 같은 번호의 터미널이 이미 있다]\r\n"});
                sink_send(sink, msg.to_string(), true);
                sink_send(sink, json!({"event": "termExit", "term": id}).to_string(), false);
                return;
            }
            let cols = p["cols"].as_u64().unwrap_or(80) as u16;
            let rows = p["rows"].as_u64().unwrap_or(24) as u16;
            // attach (와이어 v17): 기존 tmux 세션 id — 사이드바 목록·레이아웃 복원이 준다
            let attach = p["attach"].as_str();
            if let Err(e) = spawn_term(id, cols, rows, root, session, attach, terms.clone(), sink.clone()) {
                let msg = json!({"event": "termData", "term": id, "data": format!("pty 생성 실패: {e}\r\n")});
                sink_send(sink, msg.to_string(), true);
                // code 없는 termExit = 비정상 — 프론트가 탭을 유지해 위 에러 출력을 보여준다
                sink_send(sink, json!({"event": "termExit", "term": id}).to_string(), false);
            }
        }
        "termWrite" => {
            let data = p["data"].as_str().unwrap_or("");
            // Some(첫 폐기 여부) — sink 전송은 terms 락 밖에서 (terms → sink 중첩을 안 만든다)
            let mut dropped = None;
            if let Some(t) = terms.lock().unwrap().get(&id) {
                // 예산 초과(끊김 반복 등으로 창 리셋이 겹치면 규약을 지키는 프론트도 도달
                // 가능) — 폐기가 안전. 안내는 셸 입력이 아니라 그 터미널 화면으로만 나간다
                if !t.budget.try_reserve(data.len()) {
                    dropped = Some(t.budget.begin_dropping());
                }
                // 채널 send 는 논블로킹 — 실제 pty write 는 전용 스레드가 한다.
                // 실패 = 쓰기 스레드가 이미 종료(pty 사망) — 잔여 예산 회수와 어긋나지 않게 반환
                else if t.input.send(data.to_string()).is_err() {
                    t.budget.release(data.len());
                }
            }
            if let Some(first) = dropped {
                if first {
                    let msg = json!({"event": "termData", "term": id,
                        "data": "\r\n[superlite: 입력 큐 상한 초과 — 초과 입력을 폐기함]\r\n"});
                    sink_send(sink, msg.to_string(), true);
                }
                // 폐기분도 창은 돌려준다 — 큐를 점유하지 않으므로. 안 돌려주면 프론트의
                // 미소화 카운터가 영구히 남아 창이 그만큼 좁아진 채 잠긴다
                let chars = data.encode_utf16().count() as u64;
                sink_send(
                    sink,
                    json!({"event": "termInputAck", "term": id, "chars": chars}).to_string(),
                    true,
                );
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

/// 셸 심 폴더 — SUPERLITE_CLI_DIR 우회, 아니면 데몬 실행 파일 옆 `cli/` (superlite + sl 링크).
/// 데몬 폴더 자체를 PATH 에 넣지 않는다 — 거기 있는 동봉 tmux 가 사용자의 tmux 를 가린다
fn cli_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SUPERLITE_CLI_DIR") {
        return Some(PathBuf::from(p));
    }
    let dir = std::env::current_exe().ok()?.parent()?.join("cli");
    dir.is_dir().then_some(dir)
}

/// PTY 에서 돌릴 프로그램 — tmux 방식이면 tmux 클라이언트(attach-session), 아니면 셸 직접.
/// tmux 새 세션은 여기서 detached 로 먼저 만든다 (id 를 알아야 termTmux 로 프론트에 알린다).
/// tmux 방식인데 세션 생성·조회가 실패하면 셸 직접 실행으로 대체하고 사유를 돌려준다 (경고용)
struct Program {
    cmd: CommandBuilder,
    /// Some((id, name)) = tmux 세션에 붙는다. None = plain
    tmux: Option<(String, String)>,
    /// tmux 방식이었는데 plain 으로 대체된 사유
    fallback: Option<String>,
}

fn program(root: &Path, session: Option<&str>, attach: Option<&str>) -> Program {
    // 셸 심(`superlite <path>`, ticket cli-open-command)이 이 데몬·세션을 찾는 좌표 (와이어 v9).
    // SUPERLITE_SOCK 은 common 의 우회 변수와 같은 이름 — 셸 안에서 띄운 백엔드·심이 socket_path()
    // 만으로 이 데몬(격리 인스턴스 포함)에 붙는다. 원격에서는 원격 데몬이 만드니 자연히 원격 소켓
    let mut env: Vec<(&str, String)> =
        vec![("SUPERLITE_SOCK", crate::sock().to_string_lossy().into_owned())];
    if let Some(sid) = session {
        env.push(("SUPERLITE_SESSION", sid.to_string()));
    }
    // 터미널의 git 도 앱의 인증 대화상자를 쓴다 (VS Code git.terminalAuthentication 대응, 와이어 v18):
    // GIT_CONFIG_* 환경(git 2.31+, -c 와 같은 최우선·추가 의미)으로 이 데몬 실행 파일을 credential
    // helper 목록 '뒤에' 덧붙인다 — 그 머신의 helper 가 먼저, 비었을 때 우리 차례, 성공 store·실패
    // erase 도 받는다 (main.rs credential_helper/credential_main). 요청자는 자기 tty 로 "지금 이 터미널을
    // 보는 세션" 을 찾는다 — 세션 id 환경변수는 셸보다 먼저 죽는다 (새로고침·다른 클라이언트 이어받기).
    // GIT_TERMINAL_PROMPT 는 두지 않는다 — 대화상자 취소는 터미널 프롬프트로 떨어진다
    if let Some(helper) = crate::credential_helper() {
        env.push(("GIT_CONFIG_COUNT", "1".into()));
        env.push(("GIT_CONFIG_KEY_0", "credential.helper".into()));
        env.push(("GIT_CONFIG_VALUE_0", helper));
    }
    if let Some(lang) = crate::tmux::locale_fallback() {
        env.push(("LANG", lang.to_string()));
    }
    // 셸 심 `superlite`·`sl` 을 PATH 앞에 — 데몬 옆 cli/ 폴더(배포 세트·원격 헬퍼 폴더 모두 그
    // 배치, SUPERLITE_CLI_DIR 우회는 개발용). 폴더가 없으면 PATH 를 건드리지 않는다
    if let Some(dir) = cli_dir() {
        let cur = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&cur)));
        if let Ok(p) = joined {
            env.push(("PATH", p.to_string_lossy().into_owned()));
        }
    }
    let mut fallback = None;
    if let crate::tmux::Mode::Tmux { bin } = crate::tmux::mode() {
        // tmux 세션 환경변수로 — 새 창·패널의 셸에 상속되고, 워크스페이스 역방향 조회 키가 된다
        env.push((crate::tmux::ENV_ROOT, root.to_string_lossy().into_owned()));
        let target = match attach {
            Some(id) => Ok((id.to_string(), crate::tmux::name_of(bin, id))),
            None => crate::tmux::new_session(bin, root, &env),
        };
        match target.and_then(|t| crate::tmux::base_args().map(|a| (t, a))) {
            Ok(((id, name), args)) => {
                let mut cmd = CommandBuilder::new(bin);
                cmd.args(args);
                // -u: 클라이언트 로케일과 무관하게 UTF-8 터미널로 — ssh 로 뜬 원격 데몬은 LANG 이 없어
                // tmux 가 한글을 _ 로 그린다 (ticket tmux-server-cwd-utf8). 프론트 xterm 은 항상 UTF-8
                cmd.arg("-u");
                // -T sync: 클라이언트 터미널(프론트 xterm.js 6, DECSET 2026 지원)에 동기화 출력 기능을 알린다.
                // 그러면 tmux 가 화면 갱신마다 ?2026h…?2026l 로 감싸고 xterm 은 그 사이 렌더를 미뤄, 갱신이
                // 잦은 TUI(claude·codex 로딩 애니메이션)에서 tmux 가 셀을 고치러 다니는 커서가 화면을 휘젓고
                // 입력줄 커서가 깜빡이는 것이 사라진다. terminfo xterm-256color 에는 Sync 가 없어 자동으론
                // 켜지지 않는다 (ticket ime-composition-window)
                cmd.args(["-T", "sync"]);
                cmd.args(["attach-session", "-t", &id]);
                cmd.cwd(root);
                cmd.env("TERM", "xterm-256color");
                // 데몬이 tmux 안에서 떴어도 클라이언트가 중첩 경고를 내지 않게
                cmd.env_remove("TMUX");
                cmd.env_remove("TMUX_PANE");
                return Program { cmd, tmux: Some((id, name)), fallback: None };
            }
            Err(e) => fallback = Some(e),
        }
    }
    #[cfg(unix)]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    // Windows 는 $SHELL 규약이 없다 — ComSpec(cmd.exe)이 대응물. ponytail: PowerShell 선호는 설정 몫
    #[cfg(windows)]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(root);
    // ConPTY 세계엔 TERM 규약이 없다 — 심어두면 Windows 태생 도구들이 오판한다
    #[cfg(unix)]
    {
        cmd.env("TERM", "xterm-256color");
        // tmux 방식은 base.conf 의 전역 환경이 준다 — plain 도 같은 값 (프론트 xterm.js 는 truecolor)
        cmd.env("COLORTERM", "truecolor");
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    Program { cmd, tmux: None, fallback }
}

fn spawn_term(
    id: u64,
    cols: u16,
    rows: u16,
    root: &Path,
    session: Option<&str>,
    attach: Option<&str>,
    terms: Terms,
    sink: Sink,
) -> Result<(), String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;
    let Program { cmd, tmux, fallback } = program(root, session, attach);
    // tmux 클라이언트는 정리 시 detach-client -t <이 pty tty> 로 clean detach 한다 (kill_term).
    // tty 를 못 구하면 detach 없음 → SIGHUP 폴백 (그 경우 pane 이 죽지만 tty 부재는 드물다)
    #[cfg(unix)]
    let tty = pty.master.as_raw_fd().and_then(pts_name);
    #[cfg(not(unix))]
    let tty: Option<String> = None;
    let detach = tmux.as_ref().and_then(|_| tty.clone());
    let tmux_id = tmux.as_ref().map(|(id, _)| id.clone());
    let child = pty.slave.spawn_command(cmd).map_err(err)?;
    // termTmux (와이어 v17): 프론트가 탭 제목·사이드바 대조·강제 종료 대상으로 쓰는 세션 id, 또는
    // tmux 실패로 plain 이 된 사유 (경고 배지). 첫 출력보다 먼저 나간다
    if let Some((tid, name)) = &tmux {
        sink_send(&sink, json!({"event": "termTmux", "term": id, "id": tid, "name": name}).to_string(), false);
    } else if let Some(e) = fallback {
        sink_send(&sink, json!({"event": "termTmux", "term": id, "error": e}).to_string(), false);
    }
    let mut writer = pty.master.take_writer().map_err(err)?;
    let mut reader = pty.master.try_clone_reader().map_err(err)?;
    let flow = Flow::new();
    // 터미널별 쓰기 스레드 — Term drop(dispose·회수) 으로 채널이 닫히면 끝난다.
    // 막힌 write 중이라면 child kill 후 pty 쪽 에러로 풀린다
    let budget = InputBudget::new();
    let route = Arc::new(Mutex::new(Route { id, sink, terms: terms.clone() }));
    let (input, input_rx) = std::sync::mpsc::channel::<String>();
    {
        let (budget, route) = (budget.clone(), route.clone());
        std::thread::spawn(move || {
            while let Ok(data) = input_rx.recv() {
                // 예산은 큐 적재량을 잰다 — 꺼낸 즉시 반환 (블로킹 write 중 보유는 청크 1개)
                budget.release(data.len());
                if writer.write_all(data.as_bytes()).is_err() {
                    break;
                }
                // 소화량 통지 — 프론트 입력 배압 창이 이만큼 되돌아온다.
                // WHY: 단위는 프론트 data.length 와 같은 UTF-16 (termAck 와 같은 이유)
                let chars = data.encode_utf16().count() as u64;
                let (id, sink) = Route::snapshot(&route);
                sink_send(
                    &sink,
                    json!({"event": "termInputAck", "term": id, "chars": chars}).to_string(),
                    true,
                );
            }
            // 종료 시 채널 잔여분 예산 반환 — drain 직후 send 가 끼어드는 미시 race 의
            // 잔여분은 InputBudget 의 Drop(마지막 Arc 해제 시)이 전역에서 마저 뺀다
            while let Ok(data) = input_rx.try_recv() {
                budget.release(data.len());
            }
        });
    }
    // WHY: 리더 스레드가 종료 시 맵에서 자기 항목을 지우므로, 스레드 시작 전에 등록해야
    //      즉사한 셸이 맵에 유령으로 남는 race 가 없다
    terms
        .lock()
        .unwrap()
        .insert(id, Term { input, master: pty.master, child, flow: flow.clone(), budget, route: route.clone(), detach, tty, tmux_id, attached_at: std::time::Instant::now() });
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
                let (id, sink) = Route::snapshot(&route);
                sink_send(&sink, json!({"event": "termData", "term": id, "data": text}).to_string(), true);
                // 미ack 이 고수위를 넘으면 여기서 멈춘다 — PTY 커널 버퍼가 차면 셸도 멈춘다
                flow.add_and_wait(chars);
            }
        }
        // read 종료 = 셸 자연 종료 또는 세션 회수(kill) — 맵에서 제거해 fd/좀비 누수를 막는다.
        // WHY: if let 스크루티니의 임시 가드는 블록 끝까지 산다 — kill/wait 를 락 밖에서
        // 소속은 route 에서 읽는다 — adopt 로 다른 세션에 옮겨졌으면 그쪽 맵에서 빠져야 한다
        let (id, sink, terms) = {
            let r = route.lock().unwrap();
            (r.id, r.sink.clone(), r.terms.clone())
        };
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

    /// 입력 예산 — 터미널 상한 초과 시 폐기 신호, release 로 회복, 폐기 안내는 에피소드당 1회
    #[test]
    fn input_budget_caps_and_recovers() {
        let b = InputBudget::new();
        assert!(b.try_reserve(TERM_INPUT_MAX_BYTES));
        assert!(!b.try_reserve(1), "터미널 상한 초과는 거부되어야 한다");
        assert!(b.begin_dropping(), "첫 폐기는 안내한다");
        assert!(!b.begin_dropping(), "같은 에피소드의 반복 폐기는 조용해야 한다");
        b.release(TERM_INPUT_MAX_BYTES);
        assert!(b.try_reserve(1), "큐를 비우면 다시 받는다");
        assert!(b.begin_dropping(), "큐가 비면 에피소드가 끝나 다음 폐기를 다시 안내한다");
        b.release(1); // 전역 카운터 원상복구 (테스트 간 공유 상태)
    }

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

    /// adopt — 실제 pty 를 한 세션(A)에서 다른 세션(B)으로 옮기면 이후 출력·입력 ack 가 B 의
    /// sink 로 새 id 를 달고 나가고, A 의 맵에서는 사라진다 (와이어 v10 adoptTerminal 본체)
    #[cfg(unix)]
    #[test]
    fn adopt_moves_term_and_reroutes_output() {
        fn detached() -> Sink {
            Arc::new(Mutex::new(SinkState::Detached(VecDeque::new(), 0)))
        }
        fn events(sink: &Sink) -> Vec<String> {
            let g = sink.lock().unwrap();
            let SinkState::Detached(buf, _) = &*g else { panic!("Detached 여야 한다") };
            buf.iter().map(|(_, m)| m.clone()).collect()
        }
        let (terms_a, sink_a): (Terms, Sink) = (Terms::default(), detached());
        let (terms_b, sink_b): (Terms, Sink) = (Terms::default(), detached());
        // WHY: plain PTY 로 고정한다 — tmux 가 있는 머신에서는 실제 tmux 세션이 공유 서버(-L <SLUG>,
        //      SUPERLITE_CHANNEL 없는 cargo test 는 stable 서버)에 만들어지고 kill_term 은 detach 라
        //      세션이 남는다. 재는 것은 adopt 의 라우팅이지 tmux 가 아니다. mode() 는 OnceLock 이라
        //      첫 호출 전에 둬야 하고, 이 프로세스의 다른 테스트는 tmux 를 타지 않는다.
        std::env::set_var("SUPERLITE_TMUX", "0");
        std::env::set_var("SHELL", "/bin/sh");
        spawn_term(1, 80, 24, Path::new("/"), None, None, terms_a.clone(), sink_a.clone()).expect("pty");
        // A 에 이미 있는 id 로는 못 붙인다 / 없는 출처는 실패
        assert!(adopt(&terms_a, 9, &terms_b, 7, &sink_b).is_err(), "없는 출처 터미널");
        adopt(&terms_a, 1, &terms_b, 7, &sink_b).expect("adopt");
        assert!(!terms_a.lock().unwrap().contains_key(&1), "출처 맵에서 빠져야 한다");
        assert!(terms_b.lock().unwrap().contains_key(&7), "대상 맵에 새 id 로 있어야 한다");
        // B 의 id 로 입력 → 셸 출력이 B sink 에 term 7 로 도착한다
        handle_term("termWrite", &json!({"term": 7, "data": "echo adopted-ok\n"}), &terms_b, &sink_b, Path::new("/"), None);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let evs = events(&sink_b);
            if evs.iter().any(|m| m.contains("\"term\":7") && m.contains("adopted-ok")) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "B sink 에 출력이 와야 한다: {evs:?}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            events(&sink_a).iter().all(|m| !m.contains("adopted-ok")),
            "옮긴 뒤의 출력은 A 로 가지 않는다"
        );
        // 정리 — 스레드가 회수되도록 kill (임시 가드를 지역변수 drop 전에 끝낸다)
        let t = terms_b.lock().unwrap().remove(&7);
        if let Some(t) = t {
            kill_term(t);
        }
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
