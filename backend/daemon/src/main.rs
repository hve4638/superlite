//! superlight-daemon — 워크스페이스·터미널을 소유하는 단일 상주 프로세스 (v0, 로컬).
//!
//! 백엔드하고만 로컬 IPC(unix socket / Windows named pipe)로 통신한다 — 네트워크에 노출되지 않는다
//! (_docs/decision/process-topology.md). 프레이밍은 개행 구분 JSON 한 줄:
//! {"id","method","params"} 요청 → {"id","result"|"error"} 응답, 터미널 출력은
//! {"event":"termData","term","data"} 푸시. 연결마다 첫 요청은 attach(root) 여야 하고
//! 이후 요청은 그 root 를 쓴다. 와이어 계약 확정은 보류 중 (_docs/decisions.md).
//!
//! 수명(tmux 방식): 백엔드가 접속 실패 시 이 바이너리를 spawn 한다. 연결 0 인 상태가
//! grace(기본 3초) 지속되면 소켓을 지우고 스스로 종료한다.
//!
//! 세션 지속: attach 의 session id(프론트 페이지 수명 단위)로 터미널이 연결보다 오래 산다.
//! 끊김 중 터미널 출력은 세션 sink 에 버퍼링, 재접속 시 flush. detach 상태로 세션 grace
//! (기본 300초)를 넘기면 회수한다. session id 없는 attach(체크 스크립트)는 익명 세션 —
//! 연결 종료가 곧 터미널 정리다 (종전 동작).
//!
//! 파일 감시: attach 시 그 연결의 root 에 재귀 워처를 만들고, 이벤트를 75ms 집계·경로별
//! coalesce 해 {"event":"fsChanges","changes":[{path,kind}]} 로 푸시한다. 배치가 넘치면
//! changes 대신 overflow:true — 프론트는 전체 리프레시로 대응한다.
//!
//! 데몬→프론트 요청(와이어 v9): 소켓 요청자의 frontRequest 를 세션 프론트에 request 이벤트로
//! 전달하고 requestReply 를 되돌린다 (front 모듈). PTY 는 SUPERLIGHT_SOCK·SUPERLIGHT_SESSION
//! 환경변수로 요청자가 이 데몬·세션을 찾는 좌표를 받는다.
//!
//! 모듈: req(RPC 요청 처리) · term(PTY) · watch(파일 감시) · front(프론트 요청 중계).
//! 이 파일은 수명과 연결만 안다.
//!
//! ponytail: 같은 session id 동시 attach 는 tmux 식 탈취 (마지막 연결이 이벤트를 가져간다).
//!
//! 터미널 이동 (와이어 v10): adoptTerminal {from, fromTerm, term} — 같은 root 의 다른 세션이
//! 소유한 터미널을 이 연결의 세션으로 옮긴다 (에디터·터미널 탭을 다른 창으로 끌어 옮기는
//! app-tab-detach-window). 응답이 있는 요청이다 — 프론트가 완료 후 화면을 이어 그린다.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

mod clean;
mod front;
mod req;
mod term;
mod watch;

use term::{Sink, SinkState, Terms};

/// 연결보다 오래 사는 상태 한 벌 — attach 의 session id 가 키.
struct Session {
    /// attach 의 session id — PTY 환경변수(SUPERLIGHT_SESSION)로 요청자에게 알린다.
    /// 익명 세션은 None (요청자가 지목할 수 없다)
    id: Option<String>,
    root: PathBuf,
    terms: Terms,
    sink: Sink,
    /// None = 연결이 붙어 있다. Some(시각) 부터 세션 grace 를 재고 넘기면 회수.
    detached_at: Mutex<Option<Instant>>,
    /// 프론트 응답 대기 중인 요청자 요청 (와이어 v9)
    pending: front::Pending,
    /// 빠른 열기 파일 목록 캐시 (와이어 v12) — 세션 수명이라 재접속 뒤 첫 Ctrl+P 가 다시 걷지 않는다
    quick: req::QuickCache,
}

type Sessions = Arc<Mutex<HashMap<String, Arc<Session>>>>;

/// detach 후 grace 를 넘긴 세션 회수 — 터미널 kill 후 맵에서 제거.
fn reap_sessions(sessions: &Sessions, grace: Duration) {
    let mut dead = Vec::new();
    sessions.lock().unwrap().retain(|_, s| {
        let expired = s.detached_at.lock().unwrap().is_some_and(|t| t.elapsed() >= grace);
        if expired {
            dead.push(s.clone());
        }
        !expired
    });
    for s in dead {
        for (_, t) in s.terms.lock().unwrap().drain() {
            term::kill_term(t);
        }
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 와이어의 상대 경로는 '/' 구분이 계약이다 — Windows 가 산출한 경로의 '\' 를 정규화한다.
/// unix 에선 '\' 가 파일명에 올 수 있는 문자라 치환하지 않는다.
fn wire_rel(s: &str) -> String {
    if cfg!(windows) { s.replace('\\', "/") } else { s.to_string() }
}

#[tokio::main]
async fn main() {
    // --pipe: ssh 헬퍼 모드 — 데몬 본체가 아니라 stdio ↔ 데몬 소켓 중계자로 뜬다
    if std::env::args().any(|a| a == "--pipe") {
        pipe_main().await;
        return;
    }
    // --clean: 문제 데몬 정리 모드 — 사용자가 앱에서 명시적으로 승인했을 때만 relay 가 부른다
    if std::env::args().any(|a| a == "--clean") {
        clean::clean_main();
        return;
    }
    let sock = superlight_common::socket_path();
    // WHY: 단독 보장은 파일 락으로 — connect 검사→unlink→bind 순서는 원자적이지 않아
    //      동시 기동 시 산 데몬의 소켓 파일을 다른 데몬이 지우는 race 가 있다.
    //      락을 쥔 쪽만 소켓 파일을 만들고 지운다. 락은 프로세스 종료와 함께 풀린다.
    let Some(_lock) = acquire_lock(&sock) else {
        return; // 다른 데몬이 이미 있다(또는 기동 중) — 조용히 물러난다
    };
    #[cfg(unix)]
    let listener = {
        let _ = std::fs::remove_file(&sock); // 락을 쥐었으니 기존 소켓은 crash 잔재다
        UnixListener::bind(&sock).expect("socket bind 실패")
    };
    // named pipe 는 프로세스 종료와 함께 사라진다 — crash 잔재 정리가 없다.
    // first_pipe_instance 는 같은 사용자의 중복 기동(락이 막는다)이 아니라 타 프로세스의
    // 이름 선점을 드러내는 용도 — panic 대신 로그를 남겨 crash loop 의 원인이 보이게 한다
    #[cfg(windows)]
    let listener = match tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .create(&sock)
    {
        Ok(l) => l,
        Err(e) => {
            eprintln!("superlight-daemon: named pipe 생성 실패 {}: {e}", sock.display());
            return;
        }
    };
    eprintln!("superlight-daemon: {}", sock.display());

    let sessions: Sessions = Sessions::default();
    let conns = Arc::new(AtomicUsize::new(0));
    let grace: u64 = std::env::var("SUPERLIGHT_GRACE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);
    // 연결 0 이 grace 만큼 지속되면 자진 종료 (백엔드 전멸 = 쓰는 사람 없음).
    // 단 detach 세션이 남아 있으면 버틴다 — 세션 grace(재접속 약속)가 유휴 종료에
    // 조용히 잘리지 않게. reaper 가 세션을 회수하고 나서야 유휴 카운트가 시작된다.
    // 소켓 파일이 사라져도 종료 — 아무도 접속할 수 없는 프로세스는 락만 쥔 좀비다
    // (unix 만 — named pipe 는 프로세스와 수명을 같이한다).
    // ponytail: 종료 직전 새 접속이 오는 race 는 백엔드의 접속 실패 → spawn 재시도가 흡수.
    //           handle_conn 이 panic 해도 detach 전환·연결 카운터 감소는 drop guard
    //           (ConnCleanup·ConnCount)가 보장한다 — 이 조건이 영구히 붙드는 일은 없다.
    let watchdog = {
        let (conns, sock, sessions) = (conns.clone(), sock.clone(), sessions.clone());
        tokio::spawn(async move {
            let mut idle = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if cfg!(unix) && !sock.exists() {
                    log_line("superlight-daemon: 소켓 파일 사라짐 — 종료");
                    std::process::exit(2);
                }
                // try_lock: 감시는 누구도 기다리지 않는다 — 다른 태스크가 세션 맵을 영원히 쥐면
                // 여기서 멈춰 소켓 확인까지 못 하는 좀비가 된다. 못 잡으면 이번 초는 '조용하지
                // 않음'으로 (유휴 카운트만 늦어진다)
                let quiet = conns.load(Ordering::SeqCst) == 0
                    && sessions.try_lock().is_ok_and(|s| s.is_empty());
                idle = if quiet { idle + 1 } else { 0 };
                if idle >= grace {
                    // 파일 정리는 unix 소켓만 — named pipe 는 프로세스 종료와 함께 사라진다
                    if cfg!(unix) {
                        let _ = std::fs::remove_file(&sock);
                    }
                    log_line(&format!("superlight-daemon: 유휴 {grace}s — 종료"));
                    std::process::exit(0);
                }
            }
        })
    };

    // 세션 reaper — detach 된 세션의 터미널을 세션 grace 뒤 회수.
    // 데몬 자체가 유휴 종료하면 그때 함께 죽는다 (백엔드 제어 연결이 있는 한 안 죽는다)
    {
        let sessions = sessions.clone();
        let session_grace: u64 = std::env::var("SUPERLIGHT_SESSION_GRACE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                reap_sessions(&sessions, Duration::from_secs(session_grace));
            }
        });
    }

    // accept 루프
    {
        let (conns, sessions) = (conns.clone(), sessions.clone());
        #[cfg(windows)]
        let sock = sock.clone();
        tokio::spawn(async move {
            #[cfg(windows)]
            let mut listener = listener;
            loop {
                #[cfg(unix)]
                let stream = match listener.accept().await {
                    Ok((s, _)) => s,
                    Err(_) => {
                        // fd 고갈처럼 지속되는 accept 에러에서 100% CPU 스핀 방지
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                // named pipe 는 인스턴스 단위 — 접속된 인스턴스를 연결에 넘기고 다음 것을 만든다
                #[cfg(windows)]
                let stream = {
                    if listener.connect().await.is_err() {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                    // 재생성 실패는 이번 접속만 포기 (unix accept 에러와 같은 정책) —
                    // 접속된 인스턴스도 drop 되므로 클라이언트의 재시도 루프가 흡수한다
                    let Ok(next) =
                        tokio::net::windows::named_pipe::ServerOptions::new().create(&sock)
                    else {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    };
                    std::mem::replace(&mut listener, next)
                };
                let conns = conns.clone();
                let sessions = sessions.clone();
                conns.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    // 감소는 drop guard 로 — handle_conn 이 panic 하면 이 뒤 코드는 실행되지 않아
                    // 카운터가 새고, 유휴 종료(연결 0 판정)가 영구히 막힌다
                    let _count = ConnCount(conns);
                    handle_conn(stream, sessions).await;
                });
            }
        });
    }

    // WHY: 프로세스 수명 = 유휴 감시 태스크 수명. 종료(exit)를 부르는 곳이 그 태스크 하나라,
    //      그것만 panic 으로 죽고 나머지(accept·reaper)가 살아남으면 락은 쥔 채 아무도 못
    //      끝내는 좀비가 된다 (실측 2026-09-03: 종료 경로의 eprintln! 이 EPIPE panic).
    //      어떤 이유로든 감시가 끝나면 프로세스 전체를 내린다
    let _ = watchdog.await;
    let _ = std::fs::remove_file(&sock);
    std::process::exit(1);
}

/// 종료·감시 경로의 로그 — 실패를 무시한다. eprintln! 은 stderr 가 닫힌 파이프면 panic 해
/// exit 까지 못 간다
fn log_line(s: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{s}");
}

/// ssh 헬퍼 모드 — 백엔드가 `ssh host superlight-daemon --pipe` 로 원격(=이 머신)에
/// 이 프로세스를 띄운다 (ws docs/decision/remote-ssh.md). 이 머신의 데몬 소켓에 접속
/// (부재 시 자기 자신을 데몬으로 spawn)해 stdin/stdout 과 양방향 중계만 한다 — 내용
/// 해석 없음. 로컬 relay 의 daemon_conn+spawn 대응물이고, "헬퍼가 곧 원격의 데몬"
/// 대칭의 접점이다 (relay 는 별개 크레이트 + common 은 tokio 무의존이라 소량 중복 수용).
///
/// ssh 가 죽으면(네트워크 단절·창 닫기) stdin EOF → 종료. 데몬 쪽 연결 drop 이 세션을
/// detach 로 돌리고, 세션 grace 안의 재접속(새 헬퍼)이 터미널을 이어받는다.
async fn pipe_main() {
    let sock = superlight_common::socket_path();
    let mut stream = None;
    for i in 0..50 {
        #[cfg(unix)]
        let conn = tokio::net::UnixStream::connect(&sock).await;
        #[cfg(windows)]
        let conn = tokio::net::windows::named_pipe::ClientOptions::new().open(sock.as_os_str());
        if let Ok(s) = conn {
            stream = Some(s);
            break;
        }
        if i == 0 {
            spawn_self_daemon();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(stream) = stream else {
        eprintln!("superlight-daemon --pipe: 데몬 기동 실패 (5초): {}", sock.display());
        std::process::exit(1);
    };
    let (mut sock_r, mut sock_w) = tokio::io::split(stream);
    let (mut in_r, mut out_w) = (tokio::io::stdin(), tokio::io::stdout());
    // 어느 방향이든 끝나면(EOF·에러) 즉시 프로세스 종료로 나머지를 정리한다.
    // WHY: return 으로 런타임을 내리면 stdin 을 읽는 블로킹 스레드가 끝나길 기다린다 —
    //      데몬이 먼저 끊은 경우(attach 실패) ssh 가 stdin 을 닫을 때까지 살아남고, relay 는
    //      이 프로세스의 종료(EOF)를 기다려 서로 교착했다 (실측 2026-09-03)
    tokio::select! {
        _ = tokio::io::copy(&mut in_r, &mut sock_w) => {}
        _ = tokio::io::copy(&mut sock_r, &mut out_w) => {}
    }
    // tokio Stdout 의 쓰기는 블로킹 스레드에서 끝난다 — flush 없이 exit 하면 데몬의 마지막
    // 응답(attach 실패 사유)이 유실된다 (실측)
    let _ = out_w.flush().await;
    std::process::exit(0);
}

/// 데몬 본체 spawn (헬퍼 → 자기 자신을 인자 없이) — relay 의 spawn_daemon 과 같은 정책
fn spawn_self_daemon() {
    let Ok(bin) = std::env::current_exe() else { return };
    let mut cmd = std::process::Command::new(bin);
    // 이 프로세스의 stdout 은 ssh 채널(와이어)이다 — 상속되면 데몬 로그가 프로토콜을
    // 오염시킨다 (데몬은 stderr 로만 쓰지만 fail-safe).
    // WHY: stderr 도 상속하지 않는다 — 데몬은 이 헬퍼(ssh 세션)보다 오래 산다. ssh 가 끊긴
    //      뒤 상속된 stderr 파이프에 eprintln! 하면 EPIPE 로 그 태스크가 panic 하는데, 유휴
    //      종료 경로가 "소켓 unlink → 로그 → exit" 순이라 소켓만 지운 채 락을 쥔 프로세스가
    //      영원히 남았다 (실측 2026-09-03: 이후 그 호스트의 모든 접속이 '데몬 기동 실패').
    //      로그는 캐시 밑 파일로 — 실패 시 null
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(daemon_log_file().map_or_else(std::process::Stdio::null, std::process::Stdio::from));
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0000_0010);
    if let Ok(mut child) = cmd.spawn() {
        // 좀비 방지 — 데몬이 이미 있어 즉시 물러난 자식 회수 (헬퍼는 오래 살 수 있다)
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// 헬퍼가 띄운 데몬의 로그 파일 — 헬퍼 배치 디렉터리(relay ssh::ensure_remote_bin)와 같은
/// 캐시 밑 `$HOME/.cache/code-superlight/daemon.log` (append)
fn daemon_log_file() -> Option<std::fs::File> {
    let dir = superlight_common::cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().append(true).create(true).open(dir.join("daemon.log")).ok()
}

fn acquire_lock(sock: &Path) -> Option<std::fs::File> {
    let f = superlight_common::open_lock_file(&superlight_common::lock_path(sock)).ok()?;
    // WouldBlock 이든 다른 실패든 물러난다 (fail-closed)
    f.try_lock().ok()?;
    // 보유자 pid — `--clean` 이 좀비(락은 쥐고 소켓은 없음)를 지목하는 유일한 근거.
    // 락을 쥔 뒤에만 쓴다 (밀려난 후보가 산 데몬의 pid 를 덮지 않게). 실패해도 데몬은 뜬다
    let _ = std::fs::write(superlight_common::pid_path(sock), std::process::id().to_string());
    Some(f)
}

/// 세션 재사용 또는 신규 등록. 재접속이면 끊김 중 쌓인 이벤트를 flush 하고 sink 를 새
/// 연결로 교체한다 — 이미 붙어 있는 연결이 있으면 tmux 식 탈취 (이벤트가 새 연결로 간다).
fn attach_session(
    sessions: &Sessions,
    id: &str,
    root: &Path,
    tx: &UnboundedSender<String>,
) -> Result<(Arc<Session>, bool), String> {
    let mut map = sessions.lock().unwrap();
    if let Some(s) = map.get(id) {
        // UUID 충돌이라기보다 다른 root 의 백엔드가 같은 id 를 재사용한 경우 — 거부가 안전
        if s.root != root {
            return Err("세션 root 불일치".into());
        }
        {
            let mut sink = s.sink.lock().unwrap();
            if let SinkState::Detached(buf, _) = &mut *sink {
                for (_, m) in buf.drain(..) {
                    let _ = tx.send(m);
                }
            }
            *sink = SinkState::Attached(tx.clone());
        }
        // WHY: 배압 리셋(terms 락)은 여기서 하지 않는다 — sessions 맵 락 아래에서 terms
        //      락을 잡으면, 오래 잡히는 terms 경로(kill 대기 등)가 전역 attach 를 막는다.
        //      호출자가 맵 락을 놓은 뒤 리셋한다.
        *s.detached_at.lock().unwrap() = None;
        return Ok((s.clone(), true));
    }
    let s = Arc::new(new_session(Some(id.to_string()), root.to_path_buf(), tx));
    map.insert(id.to_string(), s.clone());
    Ok((s, false))
}

fn new_session(id: Option<String>, root: PathBuf, tx: &UnboundedSender<String>) -> Session {
    Session {
        id,
        root,
        terms: Terms::default(),
        sink: Arc::new(Mutex::new(SinkState::Attached(tx.clone()))),
        detached_at: Mutex::new(None),
        pending: front::Pending::default(),
        quick: req::QuickCache::default(),
    }
}

/// 연결 수 카운터의 drop guard — handle_conn 이 panic 해도 감소를 보장한다
struct ConnCount(Arc<AtomicUsize>);

impl Drop for ConnCount {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 연결 종료 뒷정리의 drop guard — 정상 종료든 panic 이든 반드시 실행된다.
/// 누락되면 등록 세션이 detached_at=None 으로 영원히 남아 reaper 와 유휴 종료를
/// 무기한 막는다. 락은 poison 이어도 복구해 잡는다 — unwind 중의 뒷정리가 다시
/// panic 하면 이중 panic 으로 프로세스가 abort 된다.
struct ConnCleanup {
    session: Option<Arc<Session>>,
    /// 세션 맵에 등록됐는가 — 익명이면 연결 종료가 곧 세션 종료
    named: bool,
    tx: UnboundedSender<String>,
}

impl Drop for ConnCleanup {
    fn drop(&mut self) {
        // 익명 세션은 터미널을 즉시 정리, 등록 세션은 detach 로 전환해
        // 재접속을 기다린다 (회수는 reaper 몫)
        let Some(s) = self.session.take() else { return };
        if self.named {
            let mut sink = s.sink.lock().unwrap_or_else(|e| e.into_inner());
            // WHY: 내 연결의 sink 일 때만 detach — 다른 연결이 세션을 탈취했으면 그대로 둔다
            if matches!(&*sink, SinkState::Attached(cur) if cur.same_channel(&self.tx)) {
                *sink = SinkState::Detached(VecDeque::new(), 0);
                *s.detached_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                drop(sink);
                // 응답할 프론트가 사라졌다 — 기다리는 요청자에게 알린다 (sink 락 밖)
                front::fail_all(&s.pending, "프론트 연결이 끊겼다");
            }
        } else {
            for (_, t) in s.terms.lock().unwrap_or_else(|e| e.into_inner()).drain() {
                term::kill_term(t);
            }
        }
    }
}

/// 바이너리 payload 프레임 (와이어 v6) — IPC: 0x00 매직 + 4B BE payload 길이 + payload.
/// payload 는 relay 가 WS 바이너리 프레임으로 그대로 나르는 단위: 4B BE 헤더 길이 +
/// 헤더 JSON(id·result 메타·payload 명세) + 본문 바이트. JSON 줄은 '{' 로 시작하므로
/// 0x00 첫 바이트로 무모호하게 구분된다.
/// attach 뒤에만 허용되는 요청의 root — attach 전이면 응답 있는 요청(id 비-null)에만 에러를
/// 돌리고 None (알림은 조용히 버린다)
fn session_root(cleanup: &ConnCleanup, tx: &UnboundedSender<String>, id: &serde_json::Value) -> Option<PathBuf> {
    match &cleanup.session {
        Some(s) => Some(s.root.clone()),
        None => {
            if !id.is_null() {
                let _ = tx.send(json!({"id": id, "error": "attach 전 요청"}).to_string());
            }
            None
        }
    }
}

fn payload_frame(header: &serde_json::Value, body: &[u8]) -> Vec<u8> {
    let h = header.to_string().into_bytes();
    let payload_len = 4 + h.len() + body.len();
    let mut out = Vec::with_capacity(5 + payload_len);
    out.push(0x00);
    out.extend_from_slice(&(payload_len as u32).to_be_bytes());
    out.extend_from_slice(&(h.len() as u32).to_be_bytes());
    out.extend_from_slice(&h);
    out.extend_from_slice(body);
    out
}

async fn handle_conn(
    stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
    sessions: Sessions,
) {
    let (read_half, mut write_half) = tokio::io::split(stream);
    // WHY: 응답·터미널 이벤트가 여러 태스크/스레드에서 나오므로 단일 writer 태스크로 직렬화.
    //      바이너리 payload(와이어 v6)는 별도 채널 — 기존 String 채널의 26개 송신처를
    //      건드리지 않는다. 응답은 id 로 대응되므로 두 채널 간 순서 보장은 계약이 아니다
    //      (handle_req 가 이미 태스크 병렬이라 종전에도 응답 순서는 비결정적).
    let (tx, mut rx) = unbounded_channel::<String>();
    let (btx, mut brx) = unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        // 한쪽 채널이 닫혀도(연결 종료로 송신단 drop) 다른 쪽에 남은 응답은 다 쓰고 끝난다.
        // WHY: 닫힌 쪽의 None 에서 바로 break 하면 attach 실패 응답처럼 종료 직전에 보낸
        //      마지막 줄이 절반쯤 유실됐다 (두 송신단의 drop 순서 경합, 실측 2026-09-03)
        let (mut rx_open, mut brx_open) = (true, true);
        loop {
            let ok = tokio::select! {
                s = rx.recv(), if rx_open => match s {
                    Some(mut s) => {
                        s.push('\n'); // serde_json 직렬화엔 생 개행이 없다 — 개행 = 프레임 경계
                        write_half.write_all(s.as_bytes()).await.is_ok()
                    }
                    None => { rx_open = false; true }
                },
                b = brx.recv(), if brx_open => match b {
                    Some(b) => write_half.write_all(&b).await.is_ok(),
                    None => { brx_open = false; true }
                },
                else => break,
            };
            if !ok {
                break;
            }
        }
    });

    let mut cleanup = ConnCleanup { session: None, named: false, tx: tx.clone() };
    let watcher_slot = watch::WatcherSlot::default();
    let mut lines = BufReader::new(read_half).lines();
    loop {
        // 백엔드는 30초마다 ping 을 보낸다 — 10분 무입력이면 산 척하는 죽은 연결로 보고 닫는다
        let line = match tokio::time::timeout(Duration::from_secs(600), lines.next_line()).await {
            Ok(Ok(Some(l))) => l,
            _ => break,
        };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let method = req["method"].as_str().unwrap_or("").to_string();
        match method.as_str() {
            "ping" => {} // 생존 신호 — read timeout 리셋이 목적의 전부, 응답 없음
            // 요청자(셸 심)의 프론트 요청 (와이어 v9) — attach 없이 허용. 대상 세션은
            // params.session 으로 지목 (PTY 환경변수 SUPERLIGHT_SESSION). 응답은 프론트의
            // requestReply 가 올 때 front::reply 가 이 연결로 돌려준다
            "frontRequest" => {
                let p = &req["params"];
                let target = p["session"]
                    .as_str()
                    .and_then(|sid| sessions.lock().unwrap().get(sid).cloned());
                match target {
                    Some(s) => front::request(
                        &s.pending,
                        &s.sink,
                        &tx,
                        req["id"].clone(),
                        p["method"].as_str().unwrap_or(""),
                        p["params"].clone(),
                    ),
                    None => {
                        let _ = tx.send(json!({"id": req["id"], "error": "세션 없음"}).to_string());
                    }
                }
            }
            // 프론트의 요청 응답 — 이 연결의 세션에서 대기 중인 요청자에게 회신
            "requestReply" => {
                if let Some(s) = &cleanup.session {
                    front::reply(&s.pending, &req["params"]);
                }
            }
            "attach" => {
                // WHY: 재-attach 를 허용하면 클라이언트가 root 를 갈아끼워 safe_join 의
                //      루트 봉쇄를 통째로 우회한다 — 연결당 한 번만
                if cleanup.session.is_some() {
                    let _ = tx.send(json!({"id": req["id"], "error": "이미 attach 된 연결"}).to_string());
                    continue;
                }
                // plain: verbatim 루트는 '/' 와이어 경로 join·자식 cwd 를 깨뜨린다 (common 참조)
                match PathBuf::from(req["params"]["root"].as_str().unwrap_or(""))
                    .canonicalize()
                    .map(superlight_common::plain)
                {
                    Ok(r) => {
                        // resumed — 재접속인데 false 면 세션이 이미 회수됐다는 뜻.
                        // 프론트가 죽은 터미널을 정리할 유일한 단서다
                        let (s, resumed) = match req["params"]["session"].as_str() {
                            Some(sid) => match attach_session(&sessions, sid, &r, &tx) {
                                Ok(pair) => {
                                    cleanup.named = true;
                                    pair
                                }
                                Err(e) => {
                                    let _ = tx.send(json!({"id": req["id"], "error": e}).to_string());
                                    break;
                                }
                            },
                            None => (Arc::new(new_session(None, r.clone(), &tx)), false),
                        };
                        if resumed {
                            // 배압 카운터 리셋 — 프론트도 재연결 시 0 에서 다시 센다
                            // (유실 프레임 몫 정리). sessions 맵 락 밖이라 안전하다
                            term::reset_flow(&s.terms);
                        }
                        let path = r.to_string_lossy().into_owned();
                        // 감시 실패(inotify 한도 등)는 치명적이지 않다 — 감시 없이 동작.
                        // 워처는 연결 스코프 — 끊김 중 놓친 이벤트는 프론트가 재접속 시 전체 리프레시.
                        // watch:false (와이어 v7) 는 탐색 전용 attach — 원격 빈 세션이 폴더 열기
                        // 퀵인풋으로 이 머신을 탐색만 하는 동안 홈 전체에 재귀 워처를 걸지 않는다
                        if req["params"]["watch"].as_bool() != Some(false) {
                            watch::start_watcher(r, tx.clone(), watcher_slot.clone());
                        }
                        cleanup.session = Some(s);
                        let _ = tx.send(
                            json!({"id": req["id"], "result": {"rootPath": path, "resumed": resumed}})
                                .to_string(),
                        );
                    }
                    Err(e) => {
                        let _ = tx.send(json!({"id": req["id"], "error": format!("attach 실패: {e}")}).to_string());
                        break; // 루트 없는 연결은 쓸모없다 — 닫아서 실패를 드러낸다
                    }
                }
            }
            // 터미널 계열은 입력 순서 보장이 필요해 read 루프에서 즉시 처리 (전부 논블로킹)
            "createTerminal" | "termWrite" | "termResize" | "termAck" | "disposeTerminal" => {
                let Some(s) = &cleanup.session else { continue };
                term::handle_term(&method, &req["params"], &s.terms, &s.sink, &s.root, s.id.as_deref());
            }
            // 세션 간 터미널 이동 (와이어 v10) — 출처 세션은 맵에서 Arc 만 꺼내고 락을 놓은 뒤
            // 옮긴다 (sessions → terms 락 중첩을 만들지 않는다). 같은 root 사이에서만 —
            // 셸 cwd·와이어 경로가 root 기준이라 다른 root 로 옮기면 의미가 깨진다
            "adoptTerminal" => {
                let Some(s) = &cleanup.session else {
                    // 응답 있는 요청 — 무응답이면 프론트 프로미스가 영구 대기한다
                    let _ = tx.send(json!({"id": req["id"], "error": "attach 전 요청"}).to_string());
                    continue;
                };
                let p = &req["params"];
                let out = match (p["from"].as_str(), p["fromTerm"].as_u64(), p["term"].as_u64()) {
                    (Some(from), Some(from_term), Some(term)) => {
                        let src = sessions.lock().unwrap().get(from).cloned();
                        match src {
                            Some(src) if src.root == s.root => {
                                term::adopt(&src.terms, from_term, &s.terms, term, &s.sink)
                            }
                            Some(_) => Err("세션 root 불일치".to_string()),
                            None => Err("출처 세션 없음".to_string()),
                        }
                    }
                    _ => Err("잘못된 인자".to_string()),
                };
                let msg = match out {
                    Ok(()) => json!({"id": req["id"], "result": {"ok": true}}),
                    Err(e) => json!({"id": req["id"], "error": e}),
                };
                let _ = tx.send(msg.to_string());
            }
            // readFile 은 대형 응답이 바이너리 payload 프레임을 탄다 (와이어 v6) — 반환형이
            // 달라 일반 경로와 분리 라우팅
            "readFile" => {
                let (id, params) = (req["id"].clone(), req["params"].clone());
                let Some(root) = session_root(&cleanup, &tx, &id) else { continue };
                let (tx, btx) = (tx.clone(), btx.clone());
                tokio::spawn(async move {
                    match req::read_file(&params, &root).await {
                        Ok(req::ReadOut::Json(v)) => {
                            let _ = tx.send(json!({"id": id, "result": v}).to_string());
                        }
                        Ok(req::ReadOut::Payload { mut meta, body, enc, typ }) => {
                            meta["payload"] = json!({"enc": enc, "type": typ});
                            let header = json!({"id": id, "result": meta});
                            let _ = btx.send(payload_frame(&header, &body));
                        }
                        Err(e) => {
                            let _ = tx.send(json!({"id": id, "error": e}).to_string());
                        }
                    }
                });
            }
            // quickOpen 은 세션 캐시(와이어 v12)가 필요하다 — handle_req 는 root 만 받는다
            "quickOpen" => {
                let (id, params) = (req["id"].clone(), req["params"].clone());
                let Some(s) = cleanup.session.clone() else {
                    let _ = tx.send(json!({"id": id, "error": "attach 전 요청"}).to_string());
                    continue;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let out = match req::quick_open(&params, &s.root, &s.quick).await {
                        Ok(v) => json!({"id": id, "result": v}),
                        Err(e) => json!({"id": id, "error": e}),
                    };
                    let _ = tx.send(out.to_string());
                });
            }
            _ => {
                let (id, params) = (req["id"].clone(), req["params"].clone());
                let Some(root) = session_root(&cleanup, &tx, &id) else { continue };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let out = match req::handle_req(&method, &params, &root).await {
                        Ok(v) => json!({"id": id, "result": v}),
                        Err(e) => json!({"id": id, "error": e}),
                    };
                    let _ = tx.send(out.to_string());
                });
            }
        }
    }
    // 연결 종료 뒷정리는 cleanup(ConnCleanup)의 Drop 이 수행한다 — panic 경로와 통일
}
