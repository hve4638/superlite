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
//! ponytail: 재연결·flow control·다중 클라이언트 세션 공유 없음 — 계약 확정 때 함께.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

struct Term {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

type Terms = Arc<Mutex<HashMap<u64, Term>>>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// (mtime_ms, size) 기반 etag — VS Code 와 동일한 구성. 내용 해시가 아니라 stat 스냅샷이다.
fn file_etag(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        // mtime 미지원 fs 에선 0 — etag 가 크기 전용으로 강등된다 (리눅스에선 사실상 없음)
        .unwrap_or(0);
    format!("{mtime}-{}", meta.len())
}

// WHY: 요청은 태스크로 병렬 처리된다 — etag 검사→쓰기가 다른 쓰기와 끼어들면 검사가 무의미.
// ponytail: 전역 쓰기 락 + 락 안 블로킹 fs 호출 — 병목이 실측되면 경로별 락 + spawn_blocking.
static WRITE_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

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

    let terms: Terms = Arc::new(Mutex::new(HashMap::new()));
    let mut root: Option<PathBuf> = None;
    // 워처 슬롯 — 등록(트리 walk)이 blocking 태스크에서 끝나면 여기 담긴다.
    // 연결 종료로 이 Arc 가 떨어지면 워처(및 집계 태스크)도 함께 정리된다.
    let watcher_slot: Arc<Mutex<Option<notify::RecommendedWatcher>>> = Arc::new(Mutex::new(None));
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
                        start_watcher(r.clone(), tx.clone(), watcher_slot.clone());
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
                handle_term(&method, &req["params"], &terms, &tx, root);
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
                    let out = match handle_req(&method, &params, &root).await {
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
        kill_term(t);
    }
}

// WHY: portable-pty 의 kill 은 SIGHUP 후 최대 200ms 를 재우며 대기한다 — read 루프/워커를
//      막지 않게 스레드로 보내고, wait 까지 해서 좀비를 남기지 않는다.
fn kill_term(mut t: Term) {
    std::thread::spawn(move || {
        let _ = t.child.kill();
        let _ = t.child.wait();
    });
}

// ---------------------------------------------------------------- watch

/// 워처 이벤트 배치 상한 — 넘으면 경로 나열 대신 overflow(전체 리프레시 신호)로 강등.
/// 대량 변경(브랜치 전환 등)은 경로를 다 나르는 것보다 전체 리프레시가 싸다.
const WATCH_BATCH_CAP: usize = 1_000;

/// root 재귀 감시 시작. 이벤트는 75ms 집계·경로별 coalesce 후 fsChanges 로 tx 에 푸시.
/// 등록이 끝나면 워처를 slot 에 담는다 — slot 이 drop 되면 감시·집계 태스크가 함께 끝난다.
/// 심링크는 따라가지 않는다 (attach root 봉쇄와 일관 — 루트 밖 경로가 이벤트로 새지 않게).
/// ponytail: 재귀 watch 는 제외 없이 전부 inotify 에 등록한다 — 거대 node_modules 에서
///           watch 한도(fs.inotify.max_user_watches) 고갈 가능. 문제되면 디렉터리 단위
///           비재귀 watch + 제외 목록으로 전환.
fn start_watcher(
    root: PathBuf,
    tx: UnboundedSender<String>,
    slot: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
) {
    use notify::event::{EventKind, ModifyKind};
    use notify::Watcher as _;

    let (raw_tx, mut raw_rx) = unbounded_channel::<(String, &'static str)>();
    let cb_root = root.clone();
    // 콜백은 notify 스레드에서 돈다 — 분류·필터만 하고 집계는 tokio 태스크로 넘긴다
    let cb = move |res: Result<notify::Event, notify::Error>| {
        let Ok(ev) = res else { return };
        let kind = match ev.kind {
            EventKind::Access(_) => return,
            EventKind::Create(_) => "create",
            EventKind::Remove(_) => "delete",
            EventKind::Modify(ModifyKind::Name(_)) => "", // rename — 경로별 존재 여부로 판정
            EventKind::Modify(_) => "change",
            _ => "",
        };
        for p in &ev.paths {
            let Ok(rel) = p.strip_prefix(&cb_root) else { continue };
            let rel = rel.to_string_lossy().into_owned();
            if rel.is_empty() || !event_allowed(&rel) {
                continue;
            }
            // rename/불명 이벤트는 존재하면 create, 없으면 delete 로 — 프론트는 둘 다 처리한다
            let kind = if kind.is_empty() { if p.exists() { "create" } else { "delete" } } else { kind };
            if raw_tx.send((rel, kind)).is_err() {
                return; // 집계 태스크 종료 — 연결이 끊겼다
            }
        }
    };
    let mut watcher =
        match notify::RecommendedWatcher::new(cb, notify::Config::default().with_follow_symlinks(false)) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("superlight-daemon: 워처 생성 실패: {e}");
                return;
            }
        };
    // WHY: 재귀 등록은 트리 전체를 걷는 블로킹 작업 — read 루프에서 하면 attach 직후의
    //      모든 요청(부팅이 기다리는 readDir 등)이 등록 완료까지 멈춘다.
    tokio::task::spawn_blocking(move || {
        match watcher.watch(&root, notify::RecursiveMode::Recursive) {
            Ok(()) => *slot.lock().unwrap() = Some(watcher),
            Err(e) => eprintln!("superlight-daemon: 감시 시작 실패 {}: {e}", root.display()),
        }
    });

    tokio::spawn(async move {
        loop {
            let Some((path, kind)) = raw_rx.recv().await else { return };
            // 첫 이벤트부터 75ms 창으로 모은다 (VS Code 의 집계 창과 동일한 감각)
            let deadline = tokio::time::Instant::now() + Duration::from_millis(75);
            let mut batch: HashMap<String, &'static str> = HashMap::new();
            let mut overflow = false;
            coalesce(&mut batch, path, kind);
            loop {
                match tokio::time::timeout_at(deadline, raw_rx.recv()).await {
                    Ok(Some((p, k))) => {
                        if batch.len() >= WATCH_BATCH_CAP {
                            overflow = true; // 창이 끝날 때까지 마저 버린다
                        } else {
                            coalesce(&mut batch, p, k);
                        }
                    }
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            let msg = if overflow {
                json!({"event": "fsChanges", "overflow": true, "changes": []})
            } else {
                let changes: Vec<Value> = batch
                    .into_iter()
                    .map(|(path, kind)| json!({"path": path, "kind": kind}))
                    .collect();
                if changes.is_empty() {
                    continue; // 전부 상쇄됨 (create+delete)
                }
                json!({"event": "fsChanges", "changes": changes})
            };
            if tx.send(msg.to_string()).is_err() {
                return;
            }
        }
    });
}

/// 같은 창 안의 이벤트를 경로별로 접는다: create 후 delete 는 상쇄, delete 후 create 는
/// change(내용 교체), create 후 change 는 create 유지, 그 외엔 마지막이 이긴다.
fn coalesce(batch: &mut HashMap<String, &'static str>, path: String, kind: &'static str) {
    match (batch.get(path.as_str()).copied(), kind) {
        (Some("create"), "delete") => {
            batch.remove(path.as_str());
        }
        (Some("create"), "change") => {}
        (Some("delete"), "create") => {
            batch.insert(path, "change");
        }
        _ => {
            batch.insert(path, kind);
        }
    }
}

/// 심층 churn 을 버리는 디렉터리 — 직계 자식 이벤트까지만 통과.
/// VS Code watcherExclude 의 감각인데 설정 시스템이 없으므로 흔한 산출물을 하드코딩한다.
const DEEP_EXCLUDED: [&str; 5] = ["node_modules", "target", "dist", ".venv", "__pycache__"];

/// 감시 이벤트 필터:
/// .git 은 1단계 파일(HEAD·index — SCM 갱신 신호)만, index.lock 은 제외.
fn event_allowed(rel: &str) -> bool {
    let comps: Vec<&str> = rel.split('/').collect();
    for (i, c) in comps.iter().enumerate() {
        if *c == ".git" && (comps.len() > i + 2 || comps.get(i + 1) == Some(&"index.lock")) {
            return false;
        }
        if DEEP_EXCLUDED.contains(c) && comps.len() > i + 2 {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------- terminal

fn handle_term(method: &str, p: &Value, terms: &Terms, tx: &UnboundedSender<String>, root: &Path) {
    let id = p["term"].as_u64().unwrap_or(0);
    match method {
        "createTerminal" => {
            // 같은 id 재생성은 무시 — 수락하면 기존 PTY 가 회수 없이 샌다
            if terms.lock().unwrap().contains_key(&id) {
                return;
            }
            let cols = p["cols"].as_u64().unwrap_or(80) as u16;
            let rows = p["rows"].as_u64().unwrap_or(24) as u16;
            if let Err(e) = spawn_term(id, cols, rows, root, terms.clone(), tx.clone()) {
                let msg = json!({"event": "termData", "term": id, "data": format!("pty 생성 실패: {e}\r\n")});
                let _ = tx.send(msg.to_string());
                let _ = tx.send(json!({"event": "termExit", "term": id}).to_string());
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
    tx: UnboundedSender<String>,
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
            if !text.is_empty()
                && tx.send(json!({"event": "termData", "term": id, "data": text}).to_string()).is_err()
            {
                break;
            }
        }
        // 셸이 스스로 종료(exit)한 경우 — 맵에서 제거해 fd/좀비 누수를 막는다
        if let Some(mut t) = terms.lock().unwrap().remove(&id) {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
        let _ = tx.send(json!({"event": "termExit", "term": id}).to_string());
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

// ---------------------------------------------------------------- requests

async fn handle_req(method: &str, p: &Value, root: &Path) -> Result<Value, String> {
    match method {
        "workspace" => Ok(json!({
            "name": root.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
            "rootPath": root.to_string_lossy(),
        })),
        "readDir" => {
            let rel = p["path"].as_str().unwrap_or("");
            let dir = safe_join(root, rel)?;
            let mut out = Vec::new();
            for ent in std::fs::read_dir(&dir).map_err(err)? {
                let ent = ent.map_err(err)?;
                let name = ent.file_name().to_string_lossy().into_owned();
                let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                // WHY: file_type() 은 심링크를 안 따라간다 — node_modules 의 심링크 디렉터리가
                //      file 로 보인다. metadata() 는 따라간다 (깨진 링크는 file 취급).
                let is_dir = std::fs::metadata(ent.path()).map(|m| m.is_dir()).unwrap_or(false);
                let kind = if is_dir { "directory" } else { "file" };
                out.push(json!({"name": name, "path": path, "kind": kind}));
            }
            Ok(Value::Array(out))
        }
        "readFile" => {
            let path = safe_join(root, req_path(p)?)?;
            let _g = WRITE_LOCK.lock().await;
            // WHY: stat 이 read 뒤면 etag 가 내용보다 새것일 수 있다 — 그 etag 로 저장하면
            //      최신 내용을 조용히 덮는다. stat 먼저면 최악이 스퓨리어스 충돌(내용 비교
            //      탈출구가 거른다). 데몬 자신의 쓰기와는 락으로 안 겹친다.
            let meta = std::fs::metadata(&path).map_err(err)?;
            let content = std::fs::read_to_string(&path).map_err(err)?;
            Ok(json!({"content": content, "etag": file_etag(&meta)}))
        }
        "writeFile" => {
            // WHY: content 누락을 "" 로 해석하면 깨진 요청이 파일을 비운다 — 명시적 에러
            let content = p["content"].as_str().ok_or("content 필요")?;
            let path = safe_join(root, req_path(p)?)?;
            let _g = WRITE_LOCK.lock().await;
            // 낙관적 충돌 검사 (VS Code FILE_MODIFIED_SINCE 상당). etag 없으면 무조건 쓴다
            // (덮어쓰기·신규 파일). 파일이 사라진 경우는 쓰기로 진행 — 저장이 파일을 되살린다.
            if let Some(expected) = p["etag"].as_str() {
                match std::fs::metadata(&path) {
                    // etag 불일치라도 디스크가 이미 쓰려는 내용이면 충돌이 아니다 (탈출구).
                    // read 실패(EISDIR 등)는 충돌로 위장하지 않고 에러로 낸다.
                    Ok(meta) => {
                        if file_etag(&meta) != expected
                            && std::fs::read(&path).map_err(err)? != content.as_bytes()
                        {
                            return Ok(json!({"conflict": true}));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(err(e)), // 권한 등 — "없음" 으로 오독하면 검사가 무단 통과
                }
            }
            std::fs::write(&path, content).map_err(err)?;
            Ok(json!({"etag": file_etag(&std::fs::metadata(&path).map_err(err)?)}))
        }
        "listFiles" => {
            // 부팅이 이 호출을 await 하므로 실패 시 앱이 안 뜬다 — exit 1(0건)은 성공이다
            let out = run_rg(root, &["--files"]).await?;
            Ok(json!(out.lines().collect::<Vec<_>>()))
        }
        "search" => search(root, p).await,
        // git repo 가 아니어도 앱은 떠야 한다 — 빈 상태로 강등
        "gitStatus" => Ok(git_status(root)
            .await
            .unwrap_or_else(|_| json!({"branch": "", "dirty": false, "changes": []}))),
        "gitOriginalContent" => {
            let path = req_path(p)?;
            safe_join(root, path)?; // 검증만 — git 에는 상대 경로를 그대로 넘긴다
            // untracked/신규 파일이면 git show 가 실패한다 → 빈 문자열 (계약)
            match run(root, "git", &["show", &format!("HEAD:{path}")]).await {
                Ok(s) => Ok(json!(s)),
                Err(_) => Ok(json!("")),
            }
        }
        "gitCommit" => {
            run(root, "git", &["add", "-A"]).await?;
            run(root, "git", &["commit", "-m", p["message"].as_str().unwrap_or("")]).await?;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown method: {method}")),
    }
}

async fn search(root: &Path, p: &Value) -> Result<Value, String> {
    let query = p["query"].as_str().unwrap_or("");
    if query.is_empty() {
        return Ok(json!([]));
    }
    let mut args = vec!["--json", "--fixed-strings"];
    if !p["opts"]["caseSensitive"].as_bool().unwrap_or(false) {
        args.push("--ignore-case");
    }
    args.extend(["--", query]);
    let out = run_rg(root, &args).await?;
    let mut files: Vec<(String, Vec<Value>)> = Vec::new();
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "match" {
            continue;
        }
        let d = &v["data"];
        // 비UTF-8 라인/경로는 rg 가 text 대신 bytes(base64) 를 내보낸다 — 표시 불가, 건너뜀
        let (Some(path), Some(text)) = (d["path"]["text"].as_str(), d["lines"]["text"].as_str())
        else {
            continue;
        };
        let path = path.to_string();
        let text = text.trim_end_matches(['\n', '\r']);
        // WHY: rg 오프셋은 바이트, 프론트(SearchView)의 slice 는 UTF-16 코드유닛 —
        //      한글 주석 라인에서 하이라이트가 어긋나므로 여기서 변환한다
        let col =
            |b: &Value| text.get(..b.as_u64().unwrap_or(0) as usize).map_or(0, |s| s.encode_utf16().count());
        let m = json!({
            "line": d["line_number"].as_u64().unwrap_or(1).saturating_sub(1),
            "lineText": text,
            "ranges": d["submatches"].as_array().cloned().unwrap_or_default().iter()
                .map(|s| json!([col(&s["start"]), col(&s["end"])])).collect::<Vec<_>>(),
        });
        match files.last_mut() {
            Some((last, ms)) if *last == path => ms.push(m),
            _ => files.push((path, vec![m])),
        }
    }
    Ok(Value::Array(
        files.into_iter().map(|(path, ms)| json!({"path": path, "matches": ms})).collect(),
    ))
}

async fn git_status(root: &Path) -> Result<Value, String> {
    // WHY: core.quotePath 기본값이 비ASCII 경로를 C-quote("\355...") 로 내보낸다 — 끈다.
    // ponytail: 따옴표·제어문자 포함 경로는 여전히 quote 됨 — 완전 해결은 -z(NUL 구분) 파싱
    let out = run(root, "git", &["-c", "core.quotePath=false", "status", "--porcelain=v2", "--branch"]).await?;
    let mut branch = String::new();
    let mut changes = Vec::new();
    for line in out.lines() {
        if let Some(b) = line.strip_prefix("# branch.head ") {
            branch = b.to_string();
            continue;
        }
        let (kind, path) = if let Some(rest) = line.strip_prefix("? ") {
            ("untracked", rest.to_string())
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy = &line[2..4];
            let kind = if xy.contains('A') {
                "added"
            } else if xy.contains('D') {
                "deleted"
            } else {
                "modified"
            };
            // porcelain v2: '1' 은 9번째 필드부터 경로, '2'(rename) 는 score 가 껴서 10번째.
            // rename 은 "새경로\t원경로" — 새 경로만 취한다.
            let n = if line.starts_with("1 ") { 9 } else { 10 };
            let path = line
                .splitn(n, ' ')
                .nth(n - 1)
                .unwrap_or("")
                .split('\t')
                .next()
                .unwrap_or("")
                .to_string();
            (kind, path)
        } else {
            continue;
        };
        changes.push(json!({"path": path, "kind": kind}));
    }
    Ok(json!({"branch": branch, "dirty": !changes.is_empty(), "changes": changes}))
}

// ---------------------------------------------------------------- helpers

/// rg 전용 — exit code 계약이 0=매치, 1=무매치(정상), 2+=에러다
async fn run_rg(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new("rg")
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(err)?;
    match out.status.code() {
        Some(0 | 1) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

async fn run(root: &Path, bin: &str, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new(bin)
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(err)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if stderr.is_empty() {
            // git 은 "nothing to commit" 을 stdout 로 낸다 — 빈 에러 대신 그걸 보여준다.
            // (rg 매치 0건은 stdout 도 비어 있어 Err("") 유지 — search/listFiles 가 의존)
            Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(stderr)
        }
    }
}

fn req_path(p: &Value) -> Result<&str, String> {
    p["path"].as_str().ok_or_else(|| "path 필요".into())
}

/// 루트 이탈 방지 — 렉시컬 검사에 더해 심링크를 해소한 실제 경로가 루트 안인지 확인한다.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("경로 이탈: {rel}"));
    }
    let joined = root.join(rel);
    // WHY: 트리 안의 심링크가 루트 밖을 가리킬 수 있다 (root 는 main 에서 canonicalize 됨).
    //      신규 파일(writeFile)은 아직 없으므로 부모 디렉터리를 해소해 검사한다.
    let real = if joined.exists() {
        joined.canonicalize()
    } else {
        joined.parent().map_or(Ok(root.to_path_buf()), |d| d.canonicalize())
    };
    match real {
        Ok(r) if r.starts_with(root) => Ok(joined),
        Ok(_) => Err(format!("경로 이탈: {rel}")),
        Err(e) => Err(e.to_string()),
    }
}
