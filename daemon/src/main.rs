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
//! 파일 감시: attach 시 그 연결의 root 에 재귀 워처를 만들고, 이벤트를 75ms 집계·경로별
//! coalesce 해 {"event":"fsChanges","changes":[{path,kind}]} 로 푸시한다. 배치가 넘치면
//! changes 대신 overflow:true — 프론트는 전체 리프레시로 대응한다.
//!
//! 모듈: req(RPC 요청 처리) · term(PTY) · watch(파일 감시). 이 파일은 수명과 연결만 안다.
//!
//! ponytail: 재연결·flow control·다중 클라이언트 세션 공유 없음 — 계약 확정 때 함께.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::unbounded_channel;

mod req;
mod term;
mod watch;

use term::Terms;

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

    let conns = Arc::new(AtomicUsize::new(0));
    let grace: u64 = std::env::var("SUPERLIGHT_GRACE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    // 연결 0 이 grace 만큼 지속되면 자진 종료 (백엔드 전멸 = 쓰는 사람 없음).
    // ponytail: 종료 직전 새 접속이 오는 race 는 백엔드의 접속 실패 → spawn 재시도가 흡수
    {
        let (conns, sock) = (conns.clone(), sock.clone());
        tokio::spawn(async move {
            let mut idle = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                idle = if conns.load(Ordering::SeqCst) == 0 { idle + 1 } else { 0 };
                if idle >= grace {
                    let _ = std::fs::remove_file(&sock);
                    eprintln!("superlight-daemon: 유휴 {grace}s — 종료");
                    std::process::exit(0);
                }
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
        conns.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            handle_conn(stream).await;
            conns.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

fn acquire_lock(sock: &Path) -> Option<std::fs::File> {
    let f = std::fs::File::create(sock.with_extension("lock")).ok()?;
    let ret = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&f), libc::LOCK_EX | libc::LOCK_NB) };
    (ret == 0).then_some(f)
}

async fn handle_conn(stream: UnixStream) {
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

    let terms = Terms::default();
    let mut root: Option<PathBuf> = None;
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
                if root.is_some() {
                    let _ = tx.send(json!({"id": req["id"], "error": "이미 attach 된 연결"}).to_string());
                    continue;
                }
                match PathBuf::from(req["params"]["root"].as_str().unwrap_or("")).canonicalize() {
                    Ok(r) => {
                        let path = r.to_string_lossy().into_owned();
                        // 감시 실패(inotify 한도 등)는 치명적이지 않다 — 감시 없이 동작
                        watch::start_watcher(r.clone(), tx.clone(), watcher_slot.clone());
                        root = Some(r);
                        let _ = tx.send(json!({"id": req["id"], "result": {"rootPath": path}}).to_string());
                    }
                    Err(e) => {
                        let _ = tx.send(json!({"id": req["id"], "error": format!("attach 실패: {e}")}).to_string());
                        break; // 루트 없는 연결은 쓸모없다 — 닫아서 실패를 드러낸다
                    }
                }
            }
            // 터미널 계열은 입력 순서 보장이 필요해 read 루프에서 즉시 처리 (전부 논블로킹)
            "createTerminal" | "termWrite" | "termResize" | "disposeTerminal" => {
                let Some(root) = &root else { continue };
                term::handle_term(&method, &req["params"], &terms, &tx, root);
            }
            _ => {
                let (id, params) = (req["id"].clone(), req["params"].clone());
                let Some(root) = root.clone() else {
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
    // 연결 종료 → 이 연결의 터미널 정리 (세션 지속성은 계약 확정 후)
    for (_, t) in terms.lock().unwrap().drain() {
        term::kill_term(t);
    }
}
