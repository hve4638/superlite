//! superlight-daemon — 워크스페이스·터미널을 소유하는 단일 상주 프로세스 (v0, 로컬).
//!
//! 백엔드하고만 unix socket 으로 통신한다 — 네트워크에 노출되지 않는다
//! (_docs/decision/process-topology.md). 프레이밍은 개행 구분 JSON 한 줄:
//! {"id","method","params"} 요청 → {"id","result"|"error"} 응답, 터미널 출력은
//! {"event":"termData","term","data"} 푸시. 연결마다 첫 요청은 attach(root) 여야 하고
//! 이후 요청은 그 root 를 쓴다. 와이어 계약 확정은 보류 중 (_docs/decisions.md).
//!
//! 수명(tmux 방식): 백엔드가 접속 실패 시 이 바이너리를 spawn 한다. 연결 0 인 상태가
//! grace(기본 60초) 지속되면 소켓을 지우고 스스로 종료한다.
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
//! 모듈: req(RPC 요청 처리) · term(PTY) · watch(파일 감시). 이 파일은 수명과 연결만 안다.
//!
//! ponytail: 같은 session id 동시 attach 는 tmux 식 탈취 (마지막 연결이 이벤트를 가져간다).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

mod req;
mod term;
mod watch;

use term::{Sink, SinkState, Terms};

/// 연결보다 오래 사는 상태 한 벌 — attach 의 session id 가 키.
struct Session {
    root: PathBuf,
    terms: Terms,
    sink: Sink,
    /// None = 연결이 붙어 있다. Some(시각) 부터 세션 grace 를 재고 넘기면 회수.
    detached_at: Mutex<Option<Instant>>,
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

#[tokio::main]
async fn main() {
    let sock = superlight_common::socket_path();
    // WHY: 단독 보장은 flock 으로 — connect 검사→unlink→bind 순서는 원자적이지 않아
    //      동시 기동 시 산 데몬의 소켓 파일을 다른 데몬이 지우는 race 가 있다.
    //      락을 쥔 쪽만 소켓 파일을 만들고 지운다. 락은 프로세스 종료와 함께 풀린다.
    let Some(_lock) = acquire_lock(&sock) else {
        return; // 다른 데몬이 이미 있다(또는 기동 중) — 조용히 물러난다
    };
    let _ = std::fs::remove_file(&sock); // 락을 쥐었으니 기존 소켓은 crash 잔재다
    let listener = UnixListener::bind(&sock).expect("socket bind 실패");
    eprintln!("superlight-daemon: {}", sock.display());

    let sessions: Sessions = Sessions::default();
    let conns = Arc::new(AtomicUsize::new(0));
    let grace: u64 = std::env::var("SUPERLIGHT_GRACE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    // 연결 0 이 grace 만큼 지속되면 자진 종료 (백엔드 전멸 = 쓰는 사람 없음).
    // 단 detach 세션이 남아 있으면 버틴다 — 세션 grace(재접속 약속)가 유휴 종료 60초에
    // 조용히 잘리지 않게. reaper 가 세션을 회수하고 나서야 유휴 카운트가 시작된다.
    // ponytail: 종료 직전 새 접속이 오는 race 는 백엔드의 접속 실패 → spawn 재시도가 흡수.
    //           handle_conn 이 panic 으로 detach 전환을 건너뛴 세션은 detached_at=None 으로
    //           영원히 남아 이 조건이 데몬을 무기한 붙든다 — 예전 60초 backstop 이 사라진
    //           대가. mutex poison 은 어차피 데몬 전면 장애라 수용, 문제되면 drop guard.
    {
        let (conns, sock, sessions) = (conns.clone(), sock.clone(), sessions.clone());
        tokio::spawn(async move {
            let mut idle = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let quiet =
                    conns.load(Ordering::SeqCst) == 0 && sessions.lock().unwrap().is_empty();
                idle = if quiet { idle + 1 } else { 0 };
                if idle >= grace {
                    let _ = std::fs::remove_file(&sock);
                    eprintln!("superlight-daemon: 유휴 {grace}s — 종료");
                    std::process::exit(0);
                }
            }
        });
    }

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

    loop {
        let Ok((stream, _)) = listener.accept().await else {
            // fd 고갈처럼 지속되는 accept 에러에서 100% CPU 스핀 방지
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let conns = conns.clone();
        let sessions = sessions.clone();
        conns.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            handle_conn(stream, sessions).await;
            conns.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn acquire_lock(sock: &Path) -> Option<std::fs::File> {
    let f = std::fs::File::create(sock.with_extension("lock")).ok()?;
    let ret = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&f), libc::LOCK_EX | libc::LOCK_NB) };
    (ret == 0).then_some(f)
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
                for m in buf.drain(..) {
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
    let s = Arc::new(new_session(root.to_path_buf(), tx));
    map.insert(id.to_string(), s.clone());
    Ok((s, false))
}

fn new_session(root: PathBuf, tx: &UnboundedSender<String>) -> Session {
    Session {
        root,
        terms: Terms::default(),
        sink: Arc::new(Mutex::new(SinkState::Attached(tx.clone()))),
        detached_at: Mutex::new(None),
    }
}

async fn handle_conn(stream: UnixStream, sessions: Sessions) {
    let (read_half, mut write_half) = stream.into_split();
    // WHY: 응답·터미널 이벤트가 여러 태스크/스레드에서 나오므로 단일 writer 태스크로 직렬화
    let (tx, mut rx) = unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(mut s) = rx.recv().await {
            s.push('\n'); // serde_json 직렬화엔 생 개행이 없다 — 개행 = 프레임 경계
            if write_half.write_all(s.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut session: Option<Arc<Session>> = None;
    let mut named = false; // 세션 맵에 등록됐는가 — 익명이면 연결 종료가 곧 세션 종료
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
            "attach" => {
                // WHY: 재-attach 를 허용하면 클라이언트가 root 를 갈아끼워 safe_join 의
                //      루트 봉쇄를 통째로 우회한다 — 연결당 한 번만
                if session.is_some() {
                    let _ = tx.send(json!({"id": req["id"], "error": "이미 attach 된 연결"}).to_string());
                    continue;
                }
                match PathBuf::from(req["params"]["root"].as_str().unwrap_or("")).canonicalize() {
                    Ok(r) => {
                        // resumed — 재접속인데 false 면 세션이 이미 회수됐다는 뜻.
                        // 프론트가 죽은 터미널을 정리할 유일한 단서다
                        let (s, resumed) = match req["params"]["session"].as_str() {
                            Some(sid) => match attach_session(&sessions, sid, &r, &tx) {
                                Ok(pair) => {
                                    named = true;
                                    pair
                                }
                                Err(e) => {
                                    let _ = tx.send(json!({"id": req["id"], "error": e}).to_string());
                                    break;
                                }
                            },
                            None => (Arc::new(new_session(r.clone(), &tx)), false),
                        };
                        if resumed {
                            // 배압 카운터 리셋 — 프론트도 재연결 시 0 에서 다시 센다
                            // (유실 프레임 몫 정리). sessions 맵 락 밖이라 안전하다
                            term::reset_flow(&s.terms);
                        }
                        let path = r.to_string_lossy().into_owned();
                        // 감시 실패(inotify 한도 등)는 치명적이지 않다 — 감시 없이 동작.
                        // 워처는 연결 스코프 — 끊김 중 놓친 이벤트는 프론트가 재접속 시 전체 리프레시
                        watch::start_watcher(r, tx.clone(), watcher_slot.clone());
                        session = Some(s);
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
                let Some(s) = &session else { continue };
                term::handle_term(&method, &req["params"], &s.terms, &s.sink, &s.root);
            }
            _ => {
                let (id, params) = (req["id"].clone(), req["params"].clone());
                let Some(root) = session.as_ref().map(|s| s.root.clone()) else {
                    if !id.is_null() {
                        let _ = tx.send(json!({"id": id, "error": "attach 전 요청"}).to_string());
                    }
                    continue;
                };
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
    // 연결 종료 — 익명 세션은 터미널을 즉시 정리, 등록 세션은 detach 로 전환해
    // 재접속을 기다린다 (회수는 reaper 몫)
    if let Some(s) = session {
        if named {
            let mut sink = s.sink.lock().unwrap();
            // WHY: 내 연결의 sink 일 때만 detach — 다른 연결이 세션을 탈취했으면 그대로 둔다
            if matches!(&*sink, SinkState::Attached(cur) if cur.same_channel(&tx)) {
                *sink = SinkState::Detached(VecDeque::new(), 0);
                *s.detached_at.lock().unwrap() = Some(Instant::now());
            }
        } else {
            for (_, t) in s.terms.lock().unwrap().drain() {
                term::kill_term(t);
            }
        }
    }
}
