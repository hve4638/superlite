//! superlight-backend 중계 코어 — /ws ↔ 데몬 IPC(unix socket / named pipe) 중계.
//!
//! 유일한 네트워크 노출 지점 (_docs/decision/process-topology.md). 데몬을 tmux 방식으로
//! 자동 기동하고(접속 실패 → spawn → 재시도), 프론트 WS 연결마다 데몬 IPC 연결을
//! 1:1 로 열어 그대로 중계한다 — id 재매핑 없음. 각 데몬 연결에 30초 주기 ping(생존 신호).
//!
//! bin(main.rs)은 env 를 해석해 dist 정적 서빙을 얹은 단독 웹서버로 뜨고,
//! Tauri 앱(app/)은 front 를 자산으로 번들하므로 dist 없이 in-process 로 serve 를 부른다.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

mod ssh;

#[cfg(unix)]
type DaemonStream = tokio::net::UnixStream;
#[cfg(windows)]
type DaemonStream = tokio::net::windows::named_pipe::NamedPipeClient;

/// 접속 대상 — 세션 root 문자열이 `ssh://` 스킴이면 원격이다. 레지스트리·지속 저장은
/// PathBuf 를 불투명하게 나르고, 해석은 접속 직전 이 한 곳에서만 한다.
enum Target {
    Local(PathBuf),
    Remote { host: String, path: String },
}

fn to_target(root: PathBuf) -> Target {
    match ssh::parse_remote(&root.to_string_lossy()) {
        Some((host, path)) => Target::Remote { host, path },
        None => Target::Local(root),
    }
}

/// 세션 id → root 해석기. root 결정권은 native(레지스트리 등록자)에 남는다 —
/// front 는 session id 만 말하고 임의 경로를 지목할 통로가 없다 (decision/workspace-session-tabs.md).
#[derive(Clone)]
pub enum SessionRoots {
    /// 모든 세션이 root 하나를 쓴다 — bin(기동 인자)·종전 동작
    Fixed(PathBuf),
    /// 등록된 세션만 허용 — Tauri 앱이 dialog·드롭·argv 로 얻은 root 를 등록한다.
    /// Vec 인 이유: 등록 순서가 곧 세션 탭 순서다 — 순서의 단일 출처를 레지스트리에 둔다
    /// (세션 수가 한 자리라 조회는 선형 탐색으로 충분).
    /// root 가 None 인 엔트리는 루트 없는 빈 세션(시작 페이지 탭) — 탭으로는 살지만
    /// 데몬 attach 대상이 아니다 (front 도 연결을 열지 않는다, ticket app-empty-session)
    Registry(Arc<Mutex<Vec<(String, Option<PathBuf>)>>>),
}

impl SessionRoots {
    fn resolve(&self, session: Option<&str>) -> Option<PathBuf> {
        match self {
            SessionRoots::Fixed(root) => Some(root.clone()),
            SessionRoots::Registry(list) => {
                let session = session?;
                let list = list.lock().unwrap();
                list.iter().find(|(id, _)| id == session).and_then(|(_, root)| root.clone())
            }
        }
    }
}

#[derive(Clone)]
struct App {
    roots: SessionRoots,
    /// 설정 시 /ws 연결 토큰 — 로컬(loopback+Origin 검증)은 무인증이 기본이라 옵션이다
    token: Option<String>,
    /// 호스트별 예비 ssh 파이프 — relay 들이 공유 (ticket ssh-spare-pipe)
    spares: Arc<ssh::Spares>,
}

/// 서버 기동 단일 진입점 — 제어 연결을 spawn 하고 /ws(+옵션 dist) 라우터를 listener 위에 serve.
pub async fn serve(listener: TcpListener, roots: SessionRoots, token: Option<String>, dist: Option<String>) {
    // 상주 제어 연결 — 데몬 기동 보장 + 백엔드 생존 신호. 이게 있는 한 데몬은 안 죽는다.
    tokio::spawn(control_loop());

    let mut app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/ssh/hosts", get(hosts_handler))
        .route("/ssh/state", axum::routing::post(state_handler))
        .route("/daemon/clean", axum::routing::post(clean_handler));
    if let Some(dist) = &dist {
        app = app.fallback_service(ServeDir::new(dist));
    }
    let app = app.with_state(App { roots, token, spares: Arc::default() });
    axum::serve(listener, app).await.unwrap();
}

// ---------------------------------------------------------------- daemon

/// 데몬 연결 확보. spawn 은 제어 루프에서만 — relay 까지 spawn 하면 백엔드 하나가
/// 데몬을 두 번 띄우는 race 가 생긴다. 데몬 부재 시 제어 루프가 곧 재기동하므로
/// relay 는 재시도만으로 충분하다.
async fn daemon_conn(spawn: bool) -> Result<DaemonStream, String> {
    let sock = superlight_common::socket_path();
    for i in 0..50 {
        #[cfg(unix)]
        let conn = DaemonStream::connect(&sock).await;
        // open 은 동기 — 파이프 부재·인스턴스 소진(busy) 모두 이 재시도 루프가 흡수한다
        #[cfg(windows)]
        let conn = tokio::net::windows::named_pipe::ClientOptions::new().open(sock.as_os_str());
        if let Ok(s) = conn {
            return Ok(s);
        }
        if spawn && i == 0 {
            spawn_daemon()?;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("데몬 기동 실패 (5초): {}", sock.display()))
}

/// OS·아키텍처에 맞는 데몬 바이너리 — 로컬 spawn 과 원격 업로드(ssh 모듈)가 같은 규칙 하나를
/// 쓴다: 실행 파일 옆 `daemon/<os>-<arch>[.exe]` (이름은 std::env::consts::OS·ARCH 값
/// 그대로 — build.sh 가 이 배치로 배포 세트를 만든다). 로컬(내 OS·arch)은
/// SUPERLIGHT_DAEMON_BIN 우회가 먼저고, daemon/ 에 없으면 형제 `superlight-daemon` 으로
/// 폴백한다 — cargo 는 target/debug 에 평평하게 놓는다 (check 하니스·cargo run 이 기댄다).
/// 원격용(다른 OS·arch)은 daemon/ 에 없으면 오류 — 무엇을 어디에 둬야 하는지 알린다.
pub(crate) fn daemon_bin_for(os: &str, arch: &str) -> Result<PathBuf, String> {
    let local = os == std::env::consts::OS && arch == std::env::consts::ARCH;
    if local {
        if let Ok(p) = std::env::var("SUPERLIGHT_DAEMON_BIN") {
            return Ok(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let name = format!("{os}-{arch}{}", if os == "windows" { ".exe" } else { "" });
    let p = exe.with_file_name("daemon").join(&name);
    if p.is_file() {
        Ok(p)
    } else if local {
        Ok(exe.with_file_name("superlight-daemon"))
    } else {
        // 짧게 — 프론트에 close 사유(123B 한도)로 그대로 간다. 전체 경로는 로그에
        eprintln!("backend: 원격 데몬 바이너리 없음: {}", p.display());
        Err(format!("원격 {os}/{arch} 용 데몬 바이너리 없음 (daemon/{name} 을 앱 옆에)"))
    }
}

/// 로컬 데몬 바이너리 — 내 OS·아키텍처용 (daemon_bin_for)
pub(crate) fn daemon_bin_path() -> Result<PathBuf, String> {
    daemon_bin_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn spawn_daemon() -> Result<(), String> {
    let bin = daemon_bin_path()?;
    let mut cmd = std::process::Command::new(&bin);
    // 프로세스 그룹 분리 — 백엔드 터미널의 Ctrl+C 가 데몬까지 죽이지 않게.
    // 로그는 상속 — 개발 중 백엔드 터미널에서 같이 보인다.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    // CREATE_NEW_CONSOLE(0x10) — daemon 이 자기 콘솔 창을 갖고 뜬다 (사용자 결정:
    // daemon 생존·로그가 창으로 보인다 — 창이 있다 = 데몬이 살아 있다). 콘솔이 분리되므로
    // 백엔드 터미널의 Ctrl+C 도 전파되지 않는다 — CREATE_NEW_PROCESS_GROUP 은
    // NEW_CONSOLE 과 함께 주면 무시되는 플래그라 뺐다.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0000_0010);
    let mut child = cmd.spawn().map_err(|e| format!("데몬 spawn 실패 {}: {e}", bin.display()))?;
    // 좀비 방지 — 이미 데몬이 있어 즉시 물러난 자식도 회수해야 한다
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// 백엔드 수명 내내 데몬에 제어 연결을 유지하며 30초마다 ping. 끊기면 재기동·재접속.
async fn control_loop() {
    let mut next = tokio::time::Instant::now();
    loop {
        // 접속 즉시 끊기는 병리 상황(종료 직전 데몬, 소켓 선점 등)에서 스핀 방지
        tokio::time::sleep_until(next).await;
        next = tokio::time::Instant::now() + Duration::from_secs(1);
        let stream = match daemon_conn(true).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("backend: {e} — 5초 후 재시도");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut lines = BufReader::new(read_half).lines();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    if write_line(&mut write_half, r#"{"method":"ping"}"#).await.is_err() {
                        break;
                    }
                }
                l = lines.next_line() => match l {
                    Ok(Some(_)) => {} // 제어 연결엔 응답이 없어야 정상 — 오면 버린다
                    _ => break,       // 데몬 사망 → 바깥 루프가 재기동
                },
            }
        }
    }
}

async fn write_line(w: &mut (impl AsyncWrite + Unpin), s: &str) -> std::io::Result<()> {
    w.write_all(s.as_bytes()).await?;
    w.write_all(b"\n").await
}

// ---------------------------------------------------------------- relay

/// 이른 반환 없는 상수시간 비교 — 토큰 대조가 타이밍으로 새지 않게 (길이는 샌다)
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// /ws 와 /ssh/* 가 공유하는 접속 인증 — 통과 = 워크스페이스(터미널 포함) 접근 권한
fn authed(app: &App, query: &std::collections::HashMap<String, String>, headers: &HeaderMap) -> bool {
    if let Some(token) = &app.token {
        // 토큰 일치가 곧 인증 — 이때 Origin 검증은 생략한다. 임의 웹페이지는 랜덤 토큰을
        // 알 수 없어 CSRF 가 성립하지 않고, Tauri webview(tauri://·http://tauri.localhost)
        // 처럼 Origin 이 Host 와 다를 수밖에 없는 정당한 클라이언트가 이 경로로 들어온다.
        return query.get("tkn").is_some_and(|t| token_eq(t, token));
    }
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        // WHY: WS 는 CORS 밖 — Origin 검증이 없으면 사용자가 방문한 임의의 웹페이지가
        //      localhost 백엔드에 붙어 셸을 얻는다. 브라우저 요청은 Origin 호스트가 Host 와
        //      같아야 하고(같은 오리진·vite 프록시 모두 충족), 비브라우저(체크 스크립트)는
        //      Origin 이 없어 통과한다.
        let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
        let origin_host =
            origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"));
        return origin_host == Some(host);
    }
    true
}

/// /ssh/* 는 Tauri webview(http://tauri.localhost 오리진)가 fetch 로 부른다 — WebSocket 인
/// /ws 와 달리 CORS 대상이라 허용 헤더가 없으면 브라우저가 응답을 버린다 ("Failed to fetch").
/// 접근 통제는 authed(토큰 일치 / Origin=Host)가 이미 하므로 '*' 가 권한을 넓히지 않는다 —
/// 토큰 없는 교차 오리진 요청은 어차피 403 이다. GET + 표준 헤더뿐이라 preflight 도 없다
fn cors(mut resp: Response) -> Response {
    resp.headers_mut()
        .insert("access-control-allow-origin", axum::http::HeaderValue::from_static("*"));
    resp
}

/// 원격 탐색기의 호스트 목록 — 백엔드가 실행된 머신의 ~/.ssh/config (읽기 전용) 에
/// superlight 자체 상태(즐겨찾기·고정·drift·missing)를 합친 것. /ws 를 거치지 않는 백엔드 자체 응답 —
/// 주소·연결은 백엔드 소유라는 결정 (decision/remote-ssh.md 2026-08-31)의 첫 표면이다.
async fn hosts_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    cors(Json(ssh::host_list()).into_response())
}

/// POST /ssh/state?op=&host= — 즐겨찾기·고정·최근·pane 상태 변경 (fav·unfav·pin·unpin·ack·refresh·forget·pane).
/// 본문 없이 쿼리만 쓴다 — JSON 본문은 CORS preflight(OPTIONS) 를 유발해 라우트가 하나 더
/// 필요해진다. 응답은 갱신된 목록 (GET 과 같은 형태) — 프론트가 재조회 없이 갈아끼운다
async fn state_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let op = query.get("op").map(String::as_str).unwrap_or("");
    cors(match ssh::update_state(op, &query) {
        Ok(list) => Json(list).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    })
}

/// POST /daemon/clean?host= — 문제 데몬 정리 (`superlight-daemon --clean`). host 가 없으면
/// 로컬 데몬 바이너리를 직접, 있으면 ssh 로 원격에서 실행한다. 프론트가 "데몬 기동 실패"
/// 뒤 사용자 승인을 받은 경우에만 부른다 — 자동으로 부르는 곳은 없다 (사용자 결정
/// 2026-09-04: 강제 종료는 명시적 승인 하에서만). 응답 본문은 --clean 의 stdout 그대로
async fn clean_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let result = match query.get("host").filter(|h| !h.is_empty()) {
        Some(host) => ssh::clean_remote(host).await,
        None => clean_local().await,
    };
    cors(match result {
        Ok(report) => report.into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e).into_response(),
    })
}

async fn clean_local() -> Result<String, String> {
    let bin = daemon_bin_path()?;
    let out = tokio::process::Command::new(&bin)
        .arg("--clean")
        .output()
        .await
        .map_err(|e| format!("데몬 정리 실행 실패 {}: {e}", bin.display()))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn ws_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !authed(&app, &query, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // 세션 id — 데몬이 재접속 시 같은 세션(터미널)을 이어 붙이는 키.
    // 없으면(체크 스크립트) 익명 세션 — 연결과 함께 죽는 종전 동작.
    // 빈 문자열은 익명 취급 — ?session= 만 넘긴 클라이언트들이 "" 키 하나를 공유하지 않게
    let session = query.get("session").cloned().filter(|s| !s.is_empty());
    // 웹 '폴더 열기' — Fixed(bin) 는 ?folder= 절대 경로로 root 를 넘겨받는다 (VS Code web
    // 의 ?folder= 상당). /ws 인증 통과자는 이미 터미널로 셸을 얻으므로 임의 root 가 권한을
    // 넓히지 않는다 — ssh:// 원격도 마찬가지다 (로컬 셸 보유자는 ssh 를 직접 부를 수 있다).
    // Registry(Tauri) 는 무시 — root 결정권은 native 에 남는다.
    let target = match (&app.roots, query.get("folder").filter(|f| !f.is_empty())) {
        (SessionRoots::Fixed(_), Some(folder)) => match ssh::parse_remote(folder) {
            // 원격 경로 검증은 원격 데몬의 attach canonicalize 가 한다 — 여기선 형식만
            Some((host, path)) => Target::Remote { host, path },
            // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
            None => match std::path::Path::new(folder).canonicalize() {
                Ok(p) if p.is_dir() => Target::Local(superlight_common::plain(p)),
                _ => return StatusCode::FORBIDDEN.into_response(),
            },
        },
        // Registry 모드는 미등록·부재·루트 없는 세션을 거부한다 — root 는 등록 시점에
        // native 가 정한 것만.
        // WHY: 거부를 HTTP 403 이 아니라 upgrade 후 close 4403 으로 — 브라우저 WS 는
        //      handshake 실패의 HTTP status 를 노출하지 않아, 403 은 백엔드 다운(재시도
        //      가치 있음)과 구분되지 않고 front 가 1초 간격 무한 재연결에 빠진다.
        //      close code 만이 "재시도 무의미"를 전할 수 있는 통로다.
        _ => match app.roots.resolve(session.as_deref()) {
            Some(root) => to_target(root),
            None => {
                return ws.on_upgrade(|sock| async move {
                    use futures_util::StreamExt;
                    let (mut tx, mut rx) = sock.split();
                    close_with(&mut tx, &mut rx, 4403, "unknown session").await;
                });
            }
        },
    };
    let spares = app.spares.clone();
    ws.on_upgrade(move |sock| relay(sock, target, session, spares))
}

/// payload 프레임의 상한 — READ_MAX_BYTES(50MB)보다 넉넉한 방어선. 초과는 프레임
/// 오염(동기화 깨짐)으로 보고 연결을 닫는다.
const PAYLOAD_MAX: u32 = 64 * 1024 * 1024;

/// 데몬 IPC 의 다음 프레임 — JSON 줄(Line) 또는 0x00 매직 + 4B BE 길이의 바이너리
/// payload(Bin, 와이어 v6). 첫 바이트로 구분한다 (JSON 줄은 항상 '{').
enum DaemonFrame {
    Line(String),
    Bin(Vec<u8>),
}

/// 데몬 쪽 스트림의 읽기/쓰기 반쪽 — 로컬은 IPC 소켓 split, 원격은 ssh child 의
/// stdout/stdin. 프레이밍은 양쪽 동일하다 (원격 헬퍼 --pipe 는 생 바이트 중계)
type DaemonRead = Box<dyn AsyncRead + Send + Unpin>;
type DaemonWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// 순차 읽기 전용 — select 안에서 쓰면 취소 시 부분 읽기가 유실돼 프레임 동기가 깨진다.
/// (전용 태스크에서만 호출할 것)
async fn read_frame(r: &mut BufReader<DaemonRead>) -> std::io::Result<Option<DaemonFrame>> {
    use tokio::io::AsyncReadExt;
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
        return Ok(Some(DaemonFrame::Bin(buf)));
    }
    let mut line = vec![first[0]];
    r.read_until(b'\n', &mut line).await?;
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    match String::from_utf8(line) {
        Ok(s) => Ok(Some(DaemonFrame::Line(s))),
        Err(_) => Err(std::io::Error::other("비 UTF-8 줄 — 프레임 오염")),
    }
}

/// '재시도 무의미' 를 close code 로 프론트에 — 4403(미등록 세션)·4502(접속 실패 + 사유).
/// 코드 없는 close 는 프론트가 재연결(원격은 매번 ssh 재시도)한다. 사유는 WS close
/// 한도(123B) 안에서 문자 경계로 자른다.
/// WHY: Close 를 보낸 뒤 클라이언트의 Close 응답(닫기 핸드셰이크)을 기다린다 — 바로 소켓을
///      drop 하면 Chrome 은 비정상 종료(1006)로 보고해 코드·사유가 유실되고 프론트는 무한
///      재연결에 빠진다 (실측 2026-09-03 — node 클라이언트는 코드를 보여 줘 눈에 안 띄었다)
async fn close_with(
    tx: &mut (impl futures_util::Sink<Message> + Unpin),
    rx: &mut (impl futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin),
    code: u16,
    reason: &str,
) {
    use futures_util::{SinkExt, StreamExt};
    let mut reason = reason.to_string();
    while reason.len() > 120 {
        reason.pop();
    }
    let close = Message::Close(Some(axum::extract::ws::CloseFrame { code, reason: reason.into() }));
    let _ = tx.send(close).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(Ok(m)) = rx.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
}

/// 프론트 Text 프레임 하나를 데몬에 한 줄로. 생 개행이 든 프레임은 데몬 쪽에서 N개 요청으로
/// 쪼개진다(1:1 불변식 파괴 — JSON.stringify 출력엔 있을 수 없다) — 프로토콜 위반으로 보고
/// false (연결 종료). 쓰기 실패도 false
async fn forward_client_line(w: &mut DaemonWrite, line: &str) -> bool {
    !line.contains('\n') && write_line(w, line).await.is_ok()
}

/// 원격 접속 결과 중 attach 이후에도 relay() 가 쓰는 것. `_child`·`_enter` 는 수명 앵커 —
/// relay 종료(drop)가 곧 ssh kill 이고 이 호스트의 접속 leave (예비 만료 타이머의 기준)다
struct RemoteConn {
    _child: tokio::process::Child,
    _enter: ssh::Enter,
    host: String,
    /// 경로 없는 ssh://host(원격 빈 세션) — attach 에 watch:false, 최근 폴더 기록 안 함
    browse_only: bool,
    /// 헬퍼·원격 데몬 stderr 의 마지막 줄 — attach 전에 끊기면 그 줄이 곧 실패 사유
    stderr_last: Arc<Mutex<String>>,
    /// 접속 중에 프론트가 보낸 요청 — attach 줄 뒤에 순서대로 보낸다
    early: Vec<String>,
}

/// 원격 접속: 예비 파이프(ssh::Spares)가 있으면 exec 없이 바로, 없거나 죽었으면 원격 정보
/// 조회 → 헬퍼 배치 → 파이프 spawn. 접속 단계를 프론트에 흘린다 —
/// {"event":"connectStage","stage":ssh|helper|upload|daemon} (데몬 와이어 밖 relay 자체
/// 이벤트, WIRE_VERSION 불변). 접속은 별도 태스크 — 그동안 프론트 Close 를 감지해 긴 업로드
/// 중 탭 닫기가 ssh 를 바로 끊게 하고(태스크 abort = child drop = kill), 프론트 Text 요청은
/// attach 뒤에 보내도록 모아 둔다. 실패는 close 4502(사유)로 프론트에 알린 뒤 None —
/// 재시도는 사용자 몫(탭 다시 접속), 상세는 로그로. 프론트가 먼저 끊어도 None
async fn connect_remote(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
    host: String,
    path: String,
    spares: &Arc<ssh::Spares>,
) -> Option<(DaemonRead, DaemonWrite, String, RemoteConn)> {
    use futures_util::{SinkExt, StreamExt};
    let browse_only = path.is_empty();
    let enter = spares.enter(&host);
    // 고정 저장본 ssh 옵션 — 접속 한 번에 한 번만 읽는다 (probe·helper·pipe·예비 보충이 공유)
    let opts = ssh::ssh_opts(&host);
    let mut early: Vec<String> = Vec::new();
    let ready = match spares.take(&host).await {
        Some(sp) => {
            eprintln!("backend: ssh {host} — 예비 파이프 사용");
            Ok((sp.child, sp.info, sp.bin))
        }
        None => {
            let (stage_tx, mut stage_rx) = tokio::sync::mpsc::unbounded_channel();
            let conn = {
                let (host, opts) = (host.clone(), opts.clone());
                tokio::spawn(async move {
                    let info = ssh::probe_remote(&host, &opts, Some(&stage_tx)).await?;
                    let bin = ssh::ensure_remote_bin(&host, &opts, &info, Some(&stage_tx)).await?;
                    Ok::<_, String>((ssh::pipe_conn(&host, &opts, &bin, Some(&stage_tx))?, info, bin))
                })
            };
            loop {
                tokio::select! {
                    s = stage_rx.recv() => match s {
                        Some((stage, bytes)) => {
                            let mut ev = json!({"event": "connectStage", "stage": stage});
                            if let Some(b) = bytes {
                                ev["bytes"] = json!(b);
                            }
                            if ws_tx.send(Message::Text(ev.to_string().into())).await.is_err() {
                                conn.abort();
                                return None;
                            }
                        }
                        None => break, // 접속 태스크 종료 (송신자 drop)
                    },
                    m = ws_rx.next() => match m {
                        Some(Ok(Message::Text(t))) => early.push(t.to_string()),
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                            conn.abort();
                            return None;
                        }
                        _ => {}
                    },
                }
            }
            conn.await.ok()?
        }
    };
    let (mut child, info, bin) = match ready {
        Ok(v) => v,
        Err(e) => {
            eprintln!("backend: ssh {host} 연결 실패: {e}");
            close_with(ws_tx, ws_rx, 4502, &e).await;
            return None;
        }
    };
    let root = ssh::expand_home(&info.home, if browse_only { "/~" } else { &path });
    // 다음 접속용 예비 보충 — 첫 접속 뒤에도, 소비 직후에도
    spares.fill(&host, &opts, info, bin);
    let (r, w) = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    // stderr 는 백엔드 로그로 흘리면서 마지막 줄을 남긴다 ("데몬 기동 실패 (5초): …" 등)
    let stderr = child.stderr.take().unwrap();
    let stderr_last = Arc::new(Mutex::new(String::new()));
    let (h, l) = (host.clone(), stderr_last.clone());
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("backend: ssh {h}: {line}");
            if !line.trim().is_empty() {
                *l.lock().unwrap() = line;
            }
        }
    });
    let conn = RemoteConn { _child: child, _enter: enter, host, browse_only, stderr_last, early };
    Some((Box::new(r), Box::new(w), root, conn))
}

/// 프론트 WS ↔ 데몬 1:1 중계 (로컬은 IPC 소켓, 원격은 ssh exec 채널의 stdio — 어느 쪽이든
/// 내용은 불투명). 어느 쪽이 끊겨도 둘 다 정리 — 데몬 쪽 연결 drop 이 그 연결의 터미널을
/// 정리한다 (원격은 detach 전환 — 원격 데몬의 세션 grace 가 재접속을 기다린다).
/// 방향별 전용 태스크 — 바이너리 프레임 읽기(read_frame)는 다중 await 라 select 취소에
/// 안전하지 않아, 종전의 단일 select 루프 구조를 쓸 수 없다.
async fn relay(ws: WebSocket, target: Target, session: Option<String>, spares: Arc<ssh::Spares>) {
    use futures_util::{SinkExt, StreamExt};
    let (mut ws_tx, mut ws_rx) = ws.split();
    let (read_half, mut write_half, root_str, mut remote): (
        DaemonRead,
        DaemonWrite,
        String,
        Option<RemoteConn>,
    ) = match target {
        Target::Local(root) => {
            let Ok(stream) = daemon_conn(false).await else {
                return; // ws 는 drop 으로 닫힌다 — 프론트 onclose 가 진행 중 요청을 실패 처리
            };
            let (r, w) = tokio::io::split(stream);
            (Box::new(r), Box::new(w), root.to_string_lossy().into_owned(), None)
        }
        Target::Remote { host, path } => {
            let Some((r, w, root, conn)) = connect_remote(&mut ws_tx, &mut ws_rx, host, path, &spares).await else {
                return;
            };
            (r, w, root, Some(conn))
        }
    };
    // 첫 줄은 attach. 응답(id 0)이 프론트로 중계돼도 무시된다 — 프론트 id 는 1부터.
    let mut attach = json!({"id": 0, "method": "attach", "params": {"root": root_str}});
    if let Some(s) = session {
        attach["params"]["session"] = json!(s);
    }
    if remote.as_ref().is_some_and(|r| r.browse_only) {
        attach["params"]["watch"] = json!(false);
    }
    if write_line(&mut write_half, &attach.to_string()).await.is_err() {
        return;
    }
    for l in remote.as_mut().map(|r| std::mem::take(&mut r.early)).unwrap_or_default() {
        if !forward_client_line(&mut write_half, &l).await {
            return;
        }
    }
    // 첫 프레임 = attach 응답 (데몬은 attach 전 다른 응답을 내지 않는다). 여기서 실패가
    // 드러나면 — 데몬이 에러를 돌려주고 끊거나(경로 부재 등), 응답 전에 EOF(원격 헬퍼의
    // 데몬 기동 실패·바이너리 실행 불가) — 그냥 닫지 않고 close 4502 + 사유로 프론트에
    // 알린다. 종전에는 코드 없는 close 라 프론트가 1초 간격 재연결(원격은 매번 ssh)에
    // 빠져 "Reconnecting…" 만 영원히 보였다 (2026-09-03 사용자 보고)
    // 기다리는 동안의 프론트 요청은 그대로 데몬에 흘리고(프론트는 attach 응답을 기다리지
    // 않고 첫 요청을 보낸다), 프론트가 끊으면(탭 닫기·페이지 이탈) 그대로 접는다 — ssh child
    // 는 drop 으로 죽는다. read_frame 취소는 어차피 이 연결을 버리므로 무해
    let mut reader = BufReader::new(read_half);
    let frame = tokio::select! {
        f = read_frame(&mut reader) => f,
        _ = async {
            while let Some(Ok(m)) = ws_rx.next().await {
                match m {
                    Message::Text(t) => {
                        if !forward_client_line(&mut write_half, t.as_str()).await {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        } => return,
    };
    let first = match frame {
        Ok(Some(DaemonFrame::Line(l))) => {
            let v: serde_json::Value = serde_json::from_str(&l).unwrap_or_default();
            if let Some(e) = v["error"].as_str() {
                eprintln!("backend: attach 실패 ({root_str}): {e}");
                close_with(&mut ws_tx, &mut ws_rx, 4502, e).await;
                return;
            }
            // 원격 폴더 세션은 데몬이 돌려준 정규화 경로(rootPath)를 최근 폴더로 적는다
            if let Some(r) = remote.as_ref().filter(|r| !r.browse_only) {
                if let Some(p) = v["result"]["rootPath"].as_str() {
                    ssh::record_recent(&r.host, p);
                }
            }
            l
        }
        _ => {
            // 헬퍼 stderr 의 마지막 줄이 사유 — 아직 안 왔을 수 있으니 잠깐 기다린다
            tokio::time::sleep(Duration::from_millis(200)).await;
            let last = remote.as_ref().map(|r| r.stderr_last.lock().unwrap().clone()).unwrap_or_default();
            let reason = if last.is_empty() { "데몬이 attach 전에 연결을 끊음".to_string() } else { last };
            eprintln!("backend: attach 전 끊김 ({root_str}): {reason}");
            close_with(&mut ws_tx, &mut ws_rx, 4502, &reason).await;
            return;
        }
    };

    // 데몬 → 프론트: 순차 프레임 읽기 → WS 재프레이밍 (Line→Text, Bin→Binary)
    let mut down = tokio::spawn(async move {
        if ws_tx.send(Message::Text(first.into())).await.is_err() {
            return;
        }
        loop {
            match read_frame(&mut reader).await {
                Ok(Some(DaemonFrame::Line(l))) => {
                    if ws_tx.send(Message::Text(l.into())).await.is_err() {
                        break;
                    }
                }
                Ok(Some(DaemonFrame::Bin(b))) => {
                    if ws_tx.send(Message::Binary(b.into())).await.is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });

    // 프론트 → 데몬 + 30초 ping (둘 다 취소 안전한 await 만 쓴다)
    let mut up = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        ping.tick().await; // interval 의 첫 즉시 틱 소비
        loop {
            tokio::select! {
                msg = ws_rx.next() => match msg {
                    Some(Ok(Message::Text(t))) => {
                        if !forward_client_line(&mut write_half, t.as_str()).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {} // 프론트발 binary/ping/pong 프레임은 프로토콜에 없다
                },
                _ = ping.tick() => {
                    if write_line(&mut write_half, r#"{"method":"ping"}"#).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // 한쪽이 끝나면 반대쪽도 중단 — 남은 태스크가 죽은 소켓을 영원히 기다리지 않게
    tokio::select! {
        _ = &mut down => up.abort(),
        _ = &mut up => down.abort(),
    }
}
