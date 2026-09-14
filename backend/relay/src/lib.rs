//! superlite-backend 중계 코어 — /ws ↔ 데몬 IPC(unix socket / named pipe) 중계.
//!
//! 유일한 네트워크 노출 지점 (_docs/decision/process-topology.md). 데몬을 tmux 방식으로
//! 자동 기동하고(접속 실패 → spawn → 재시도), 프론트 WS 연결마다 데몬 IPC 연결을
//! 1:1 로 열어 그대로 중계한다 — id 재매핑 없음. 각 데몬 연결에 30초 주기 ping(생존 신호).
//!
//! bin(main.rs)은 env 를 해석해 dist 정적 서빙을 얹은 단독 웹서버로 뜨고,
//! Tauri 앱(app/)은 front 를 자산으로 번들하므로 dist 없이 in-process 로 serve 를 부른다.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// 데몬 연결 생존 신호 — 데몬의 read timeout(daemon main.rs, 600초)보다 충분히 짧아야 한다.
/// 제어 연결·/ws 업스트림·ssh 예비 파이프(ssh.rs)가 같은 값을 쓴다.
pub(crate) const PING_LINE: &str = r#"{"method":"ping"}"#;
pub(crate) const PING_INTERVAL: Duration = Duration::from_secs(30);

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

mod ssh;
mod gitcred;
// 클라이언트 설정 파일(tmux 프로필·~/.ssh/config) — 편집기 탭이 HTTP 로 읽고 쓴다 (ticket config-editors)
mod conf;

#[cfg(unix)]
type DaemonStream = tokio::net::UnixStream;
#[cfg(windows)]
type DaemonStream = tokio::net::windows::named_pipe::NamedPipeClient;

// 임베드 Neovim 중계 (/nvim) — 데몬 와이어 밖 relay 자체 자원 (ticket editor-vim-mode)
mod nvim;

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
    Registry(Registry),
}

/// (세션 id, root) 등록 순서 목록 — SessionRoots::Registry 의 본체
pub type Registry = Arc<Mutex<Vec<(String, Option<PathBuf>)>>>;

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
    /// 설정 시 접속 비밀번호 — 로컬(loopback+Origin 검증)은 무인증이 기본이라 옵션이다. bin 은
    /// SUPERLITE_PASSWORD(사용자가 정한 값), Tauri 앱은 기동마다 랜덤 토큰
    password: Option<String>,
    /// password 의 sha256 hex — 쿠키(superlite_auth)에 담기는 값. 쿠키 jar 에 원문을 두지 않고
    /// 쿠키 안전 문자만 쓰기 위함이지 별도 비밀은 아니다 (세션 토큰은 범위 밖, ticket web-remote-access)
    cookie: Option<String>,
    /// attach 에 실을 세션 detach 유예(초, 와이어 v26) — Fixed(단독 bin) 만 Some. 웹 클라이언트(폰)는
    /// 화면 잠금이 곧 끊김이라 데몬 기본 300초로는 세션이 회수된다. SUPERLITE_SESSION_GRACE_SECS,
    /// 기본 12시간. Registry(Tauri 앱)는 None — 데몬 기본 그대로
    grace: Option<u64>,
    /// 호스트별 예비 ssh 파이프 — relay 들이 공유 (ticket ssh-spare-pipe)
    spares: Arc<ssh::Spares>,
}

/// 서버 기동 단일 진입점 — 제어 연결을 spawn 하고 /ws(+옵션 dist) 라우터를 listener 위에 serve.
pub async fn serve(listener: TcpListener, roots: SessionRoots, password: Option<String>, dist: Option<String>) {
    // 상주 제어 연결 — 데몬 기동 보장 + 백엔드 생존 신호. 이게 있는 한 데몬은 안 죽는다.
    tokio::spawn(control_loop());

    let mut app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/auth", get(auth_handler))
        .route("/auth/login", axum::routing::post(auth_login_handler))
        .route("/ssh/hosts", get(hosts_handler))
        .route("/ssh/state", axum::routing::post(state_handler))
        .route("/daemon/clean", axum::routing::post(clean_handler))
        .route("/tmux-conf", get(tmux_conf_get).put(tmux_conf_put).options(conf_options))
        .route("/tmux-conf/profiles", get(tmux_profiles_get).post(tmux_profiles_post))
        .route("/ssh-config", get(ssh_config_get).put(ssh_config_put).options(conf_options))
        .route("/settings", get(settings_get).put(settings_put).options(conf_options))
        .route("/version", get(version_handler))
        .route("/github/oauth", axum::routing::post(github_oauth_handler))
        .route("/git/credentials", get(git_credentials_get).post(git_credentials_post))
        .route("/nvim", get(nvim::nvim_handler));
    if let Some(dist) = &dist {
        // 정적 dist 만 authed 를 거치지 않는다 — 번들에 비밀이 없고, 프론트가 /auth 로 로그인 화면을 띄운다.
        // gzip (ticket url-tab-slow-first-load): 원격 PC 에서 캐시 없이 열면 비압축 번들 약 5MB 를 받느라 load 가 2초를 넘었다
        // /mobile 은 모바일 셸 진입 경로 (ticket mobile-shell) — 별개의 vite 진입 mobile.html (데스크톱 index.html 과 청크·CSS 가 갈린다)
        // dist 라우터 안에 두어야 dist_cache_control(no-cache)이 같이 걸린다 — 밖에 두면 브라우저 휴리스틱 캐시로 옛 html 이
        // 남아 재빌드가 폰에 반영되지 않았다 (2026-09-14 실측)
        let index = ServeFile::new(format!("{dist}/mobile.html"));
        app = app.fallback_service(
            Router::new()
                .route("/mobile", axum::routing::get_service(index.clone()))
                .route("/mobile/", axum::routing::get_service(index))
                .fallback_service(ServeDir::new(dist))
                .layer(axum::middleware::from_fn(dist_cache_control))
                .layer(tower_http::compression::CompressionLayer::new()),
        );
    }
    let cookie = password.as_deref().map(sha256_hex);
    let grace = matches!(roots, SessionRoots::Fixed(_)).then(|| {
        std::env::var("SUPERLITE_SESSION_GRACE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(12 * 3600)
    });
    let app = app.with_state(App { roots, password, cookie, grace, spares: Arc::default() });
    axum::serve(listener, app).await.unwrap();
}

/// dist 정적 응답의 캐시 정책 (ticket url-tab-stale-content). ServeDir 는 Cache-Control 을 붙이지 않아
/// 브라우저가 Last-Modified 기준 휴리스틱 캐시를 쓰고, iframe(앱 URL 탭) 안 재로드는 최상위 새로고침과 달리
/// 재검증 없이 그 캐시를 그대로 쓴다 — dist 를 재빌드해도 옛 index.html 이 옛 해시 자산을 가리킨 채 남는다.
/// vite 산출물은 /assets/ 아래만 내용 해시 이름이라 영구 캐시(immutable)해도 되고, 그 밖(index.html·아이콘)은
/// 이름이 고정이라 매번 재검증(no-cache — 캐시는 하되 If-Modified-Since 로 확인, 안 바뀌면 304)한다
async fn dist_cache_control(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let immutable = req.uri().path().starts_with("/assets/");
    let mut res = next.run(req).await;
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        let v = if immutable { "public, max-age=31536000, immutable" } else { "no-cache" };
        res.headers_mut().insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static(v));
    }
    res
}

// ---------------------------------------------------------------- daemon

/// 로컬 데몬의 빌드 식별 — spawn 할 데몬 바이너리(daemon_bin_path)의 내용 해시 (common build_id).
/// 데몬은 자기 실행 파일로 같은 값을 내므로 두 프로세스가 같은 IPC 주소를 계산한다. 한 번 계산 —
/// 백엔드 수명 동안 데몬 바이너리는 바뀌지 않는다 (바뀌면 앱 재시작이 곧 새 빌드 접속이다).
/// 바이너리가 없거나 못 읽으면 주소도 없다 — 접속 실패 사유로 그대로 나간다
fn daemon_build() -> Result<&'static str, String> {
    static BUILD: OnceLock<Result<String, String>> = OnceLock::new();
    BUILD
        .get_or_init(|| {
            let bin = daemon_bin_path()?;
            superlite_common::build_id(&bin).map_err(|e| format!("데몬 바이너리 읽기 실패 {}: {e}", bin.display()))
        })
        .as_deref()
        .map_err(Clone::clone)
}

/// 데몬 연결 확보. spawn 은 제어 루프에서만 — relay 까지 spawn 하면 백엔드 하나가
/// 데몬을 두 번 띄우는 race 가 생긴다. 데몬 부재 시 제어 루프가 곧 재기동하므로
/// relay 는 재시도만으로 충분하다.
async fn daemon_conn(spawn: bool) -> Result<DaemonStream, String> {
    let sock = superlite_common::socket_path(daemon_build()?);
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
/// SUPERLITE_DAEMON_BIN 우회가 먼저고, daemon/ 에 없으면 형제 `superlite-daemon` 으로
/// 폴백한다 — cargo 는 target/debug 에 평평하게 놓는다 (check 하니스·cargo run 이 기댄다).
/// 원격용(다른 OS·arch)은 daemon/ 에 없으면 오류 — 무엇을 어디에 둬야 하는지 알린다.
pub(crate) fn daemon_bin_for(os: &str, arch: &str) -> Result<PathBuf, String> {
    let local = os == std::env::consts::OS && arch == std::env::consts::ARCH;
    if local {
        if let Ok(p) = std::env::var("SUPERLITE_DAEMON_BIN") {
            return Ok(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let name = format!("{os}-{arch}{}", if os == "windows" { ".exe" } else { "" });
    let p = exe.with_file_name("daemon").join(&name);
    if p.is_file() {
        Ok(p)
    } else if local {
        Ok(exe.with_file_name("superlite-daemon"))
    } else {
        // 짧게 — 프론트에 close 사유(123B 한도)로 그대로 간다. 전체 경로는 로그에
        eprintln!("backend: 원격 데몬 바이너리 없음: {}", p.display());
        Err(format!("원격 {os}/{arch} 용 데몬 바이너리 없음 (daemon/{name} 을 앱 옆에)"))
    }
}

/// 동봉 셸 심 바이너리(원격 업로드용) — 앱 옆 `daemon/cli-<os>-<arch>` (build.sh 가 musl 정적
/// 빌드를 둔다, ticket cli-control-discussion). 없으면 None — 원격 셸에 `superlite` 명령이 없을 뿐
pub(crate) fn cli_bin_for(os: &str, arch: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.with_file_name("daemon").join(format!("cli-{os}-{arch}"));
    p.is_file().then_some(p)
}

/// 동봉 tmux 바이너리 — 앱 옆 `daemon/tmux-<os>-<arch>` (build.sh 가 정적 릴리스를 내려받아 둔다).
/// 로컬은 SUPERLITE_TMUX_BIN 우회 먼저. 없으면 None — 로컬 데몬은 PATH 의 tmux 를, 원격은 원격
/// 호스트의 tmux 를 쓴다 (없으면 데몬이 plain 으로 대체하고 경고)
pub(crate) fn tmux_bin_for(os: &str, arch: &str) -> Option<PathBuf> {
    let local = os == std::env::consts::OS && arch == std::env::consts::ARCH;
    if local {
        if let Ok(p) = std::env::var("SUPERLITE_TMUX_BIN") {
            return Some(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let p = exe.with_file_name("daemon").join(format!("tmux-{os}-{arch}"));
    p.is_file().then_some(p)
}

/// GET /tmux-conf?profile= — 프로필 내용 (profile 생략 = 현재 적용 프로필). 편집기 탭이 연다
async fn tmux_conf_get(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let name = query.get("profile").cloned().unwrap_or_else(conf::active_name);
    cors(match conf::read_profile(&name) {
        Ok(text) => text.into_response(),
        Err(e) => (StatusCode::NOT_FOUND, e).into_response(),
    })
}

/// PUT /tmux-conf?profile= — 본문을 프로필 파일로. 접속 중인 데몬 적용은 프론트가 세션마다 tmuxConf 로
/// (relay 는 연결을 모아 두지 않는다)
async fn tmux_conf_put(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let name = query.get("profile").cloned().unwrap_or_else(conf::active_name);
    cors(match conf::write_profile(&name, &body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// GET /tmux-conf/profiles — 프로필 목록·active·실제 경로 (사이드바 폼과 탭 툴팁)
async fn tmux_profiles_get(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    cors(match conf::list() {
        Ok(l) => Json(l).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// POST /tmux-conf/profiles?op=&name=&from= — 프로필 create·clone·delete·select. 인자는 쿼리로
/// (preflight 회피 — /ssh/state 와 같은 이유). 응답은 갱신된 목록
async fn tmux_profiles_post(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let arg = |k: &str| query.get(k).map(String::as_str).unwrap_or("");
    cors(match conf::update(arg("op"), arg("name"), arg("from")) {
        Ok(l) => Json(l).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    })
}

/// GET /ssh-config — 이 머신의 ~/.ssh/config 내용 (없으면 빈 문자열)
async fn ssh_config_get(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    cors(match conf::read_ssh_config() {
        Ok(text) => text.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// PUT /ssh-config — 본문으로 통째 교체. 호스트 목록 갱신은 프론트가 /ssh/hosts 를 다시 읽는다
async fn ssh_config_put(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    cors(match conf::write_ssh_config(&body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// GET /settings — 이 머신의 사용자 설정 settings.json 원문 (없으면 `{}`, ticket user-settings)
async fn settings_get(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    cors(match conf::read_settings() {
        Ok(text) => text.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// PUT /settings — 본문으로 통째 교체. 내용 해석은 프론트 몫 (relay 는 파일 IO 만)
async fn settings_put(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    cors(match conf::write_settings(&body) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// OPTIONS /tmux-conf·/ssh-config·/settings — PUT 의 CORS preflight 응답. Tauri 앱은 프론트 오리진(tauri.localhost)과
/// relay 가 달라 PUT 앞에 브라우저가 OPTIONS 를 먼저 보내는데, 종전에는 405 라 저장이 "Failed to
/// fetch" 로 실패했다 (웹 모드는 같은 오리진이라 드러나지 않았다 — ticket relay-conn-fixes).
/// 이 파일의 다른 끝점은 쿼리 인자·text/plain 본문으로 preflight 자체를 피하지만, 이 둘은
/// PUT 의미(본문 = 파일 전체 교체)를 유지하는 쪽을 택했다.
/// 인증은 하지 않는다 — preflight 는 메타데이터 응답일 뿐이고 실제 PUT 이 authed 를 거친다
async fn conf_options() -> Response {
    let mut resp = cors(StatusCode::NO_CONTENT.into_response());
    let h = resp.headers_mut();
    h.insert("access-control-allow-methods", axum::http::HeaderValue::from_static("GET, PUT"));
    h.insert("access-control-allow-headers", axum::http::HeaderValue::from_static("content-type"));
    resp
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
    // CREATE_NO_WINDOW(0x08000000) | CREATE_NEW_PROCESS_GROUP(0x200) — 콘솔 창 없이 뜬다.
    // 초기에는 CREATE_NEW_CONSOLE 로 데몬이 자기 창을 갖게 했다 ("창이 있다 = 데몬이 살아
    // 있다", 로그도 창으로) — 지금은 로그가 daemon.log 로 가고 좀비 정리(--clean)도 있어
    // 앱마다 딸려 뜨는 콘솔 창이 마찰일 뿐이라 사용자 결정으로 없앴다 (2026-09-07,
    // daemon-no-console-window). 콘솔이 없으니 Ctrl+C 전파 자체가 없지만 그룹 분리는 남긴다.
    // 콘솔이 없어 stdio 를 상속할 곳이 없다 — 원격 헬퍼(spawn_self_daemon)와 같게 stdout 은
    // null, stderr 는 daemon.log (실패면 null).
    #[cfg(windows)]
    {
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000 | 0x0000_0200);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(
            superlite_common::daemon_log_file().map_or_else(std::process::Stdio::null, std::process::Stdio::from),
        );
    }
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
                _ = tokio::time::sleep(PING_INTERVAL) => {
                    if write_line(&mut write_half, PING_LINE).await.is_err() {
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

/// GET /auth — 지금 요청이 인증되는가: 204 또는 401. 프론트가 부팅 때 불러 로그인 화면 여부를 정한다.
/// 비밀번호 미설정(로컬)은 Origin 검증만 거쳐 204. 403 이 아니라 401 인 이유: 다른 끝점의 403(거부)과
/// 달리 "비밀번호를 물어라" 는 신호라서
async fn auth_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if authed(&app, &query, &headers) { StatusCode::NO_CONTENT } else { StatusCode::UNAUTHORIZED }.into_response()
}

/// POST /auth/login — 본문(text/plain)이 비밀번호. 일치면 superlite_auth 쿠키(HttpOnly·SameSite=Strict·
/// 1년)를 심고 204, 불일치 403. Secure 는 붙이지 않는다 — LAN·VPN 의 http 가 전제 (TLS 는 범위 밖).
/// 비밀번호 미설정이면 쿠키 없이 204. 로그아웃·만료·해지는 없다 (세션 토큰은 범위 밖) — 비밀번호를
/// 바꾸면 sha256 이 달라져 옛 쿠키가 무효가 된다
async fn auth_login_handler(State(app): State<App>, headers: HeaderMap, body: String) -> Response {
    let Some(password) = &app.password else {
        // 로컬 무인증 — Origin 검증은 그대로 (임의 페이지가 fetch 로 두드려도 얻는 것이 없다)
        return if authed(&app, &Default::default(), &headers) { StatusCode::NO_CONTENT } else { StatusCode::FORBIDDEN }
            .into_response();
    };
    if !token_eq(body.trim_end_matches(['\r', '\n']), password) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let cookie = format!(
        "{AUTH_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
        app.cookie.as_deref().unwrap_or(""),
        365 * 24 * 3600
    );
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut().insert("set-cookie", axum::http::HeaderValue::from_str(&cookie).unwrap());
    resp
}

/// 이른 반환 없는 상수시간 비교 — 토큰 대조가 타이밍으로 새지 않게 (길이는 샌다)
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn sha256_hex(s: &str) -> String {
    format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(s.as_bytes()))
}

/// 쿠키 헤더에서 이름이 name 인 값 — 없으면 None. 브라우저 형식(`a=1; b=2`)만 다룬다
fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}

const AUTH_COOKIE: &str = "superlite_auth";

/// /ws·/nvim·HTTP API 가 공유하는 접속 인증 — 통과 = 워크스페이스(터미널 포함) 접근 권한.
/// 비밀번호가 설정돼 있으면 일치가 곧 인증이고 Origin 검증은 생략한다 — 임의 웹페이지는 비밀을
/// 알 수 없어 CSRF 가 성립하지 않고, Tauri webview(tauri://·http://tauri.localhost)처럼 Origin 이
/// Host 와 다를 수밖에 없는 정당한 클라이언트가 이 경로로 들어온다. 전달 경로 셋:
/// - 쿠키 superlite_auth = sha256(비밀번호) — 웹 브라우저. WebSocket 은 헤더를 못 붙이므로 웹의
///   /ws·/nvim 은 이것뿐이다. /auth/login 이 심는다 (ticket web-remote-access)
/// - Authorization: Bearer <비밀번호> — 비브라우저(검증 스크립트·후속 APK 의 fetch)
/// - ?tkn= 쿼리 — Registry(Tauri 앱) 만. 앱은 webview 오리진이 relay 와 달라 쿠키를 못 쓰고, 주입
///   URL 은 주소창·히스토리에 남지 않는다. 단독 bin(Fixed) 은 거부 — 비밀이 URL·북마크에 남던 경로를 닫는다
fn authed(app: &App, query: &std::collections::HashMap<String, String>, headers: &HeaderMap) -> bool {
    if let Some(password) = &app.password {
        if cookie_value(headers, AUTH_COOKIE).is_some_and(|c| token_eq(c, app.cookie.as_deref().unwrap_or(""))) {
            return true;
        }
        if headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|t| token_eq(t, password))
        {
            return true;
        }
        return matches!(app.roots, SessionRoots::Registry(_)) && query.get("tkn").is_some_and(|t| token_eq(t, password));
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
/// superlite 자체 상태(즐겨찾기·고정·drift·missing)를 합친 것. /ws 를 거치지 않는 백엔드 자체 응답 —
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

/// POST /ssh/state?op=&host= — 즐겨찾기·고정·경로 아이템·pane 상태 변경 (fav·unfav·pin·unpin·ack·refresh·
/// set-items·pane·expand). 인자는 쿼리로 — JSON content-type 본문은 CORS preflight(OPTIONS) 를 유발해
/// 라우트가 하나 더 필요해진다. set-items 의 아이템 배열만은 크기 때문에 본문으로 받되 프론트가
/// text/plain 으로 보내 preflight 없이(단순 요청) 들어온다 — 여기서 쿼리 items 자리에 넣는다.
/// 응답은 갱신된 목록 (GET 과 같은 형태) — 프론트가 재조회 없이 갈아끼운다
async fn state_handler(
    State(app): State<App>,
    Query(mut query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    if !body.is_empty() {
        query.insert("items".into(), body);
    }
    let op = query.get("op").map(String::as_str).unwrap_or("");
    cors(match ssh::update_state(op, &query) {
        Ok(list) => Json(list).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    })
}

/// POST /daemon/clean?host= — 문제 데몬 정리 (`superlite-daemon --clean`). host 가 없으면
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

/// GET /version — 이 백엔드 빌드의 버전·채널(빈 문자열 = stable)·커밋·빌드 시각·daemonBuild(로컬
/// 데몬 빌드 식별 = IPC 주소 키, 부재면 오류 문자열)·로컬 데몬 경로·tmuxBin(이 OS·arch 의 tmux 배치
/// 경로, 프론트 미소비 — 진단용) (JSON). 프론트의 About·시작 페이지가 쓴다. 데몬 와이어(/ws) 밖
/// relay 자체 응답이라 웹·앱이 같은 경로를 탄다 (ticket release-versioning). 데몬 경로는 배치 규칙
/// (daemon_bin_for)의 결과 — 부재면 그 오류 문자열을 그대로 보인다
async fn version_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let daemon = daemon_bin_path().map(|p| p.display().to_string()).unwrap_or_else(|e| e);
    cors(
        Json(json!({
            "version": superlite_common::VERSION,
            "channel": superlite_common::CHANNEL,
            "commit": superlite_common::COMMIT,
            "builtAt": superlite_common::BUILT_AT,
            "daemonBuild": daemon_build().map(str::to_string).unwrap_or_else(|e| e),
            "daemonBin": daemon,
            "tmuxBin": tmux_bin_for(std::env::consts::OS, std::env::consts::ARCH),
        }))
        .into_response(),
    )
}

/// POST /github/oauth?path=<device/code|oauth/access_token>&<폼 인자…> — GitHub device flow 의
/// 두 끝점(https://github.com/login/<path>)으로 폼 인자를 그대로 전달하고 JSON 응답을 되돌린다
/// (ticket scm-subrepo-credential). 프론트가 직접 부르지 못하는 이유: github.com 의 로그인 끝점은
/// CORS 헤더가 없어 브라우저·webview 가 응답을 버린다. 인자를 본문이 아니라 query 로 받는 이유:
/// 본문 없는 POST 는 단순 요청이라 preflight 가 없다 (/ssh/* 와 같은 cors() 로 충분).
/// 데몬 와이어 밖 relay 자체 응답. 토큰은 응답으로 프론트에만 간다 —
/// relay 는 저장하지 않는다. path 는 둘만 허용 — 임의 GitHub 경로 중계기가 되지 않게
async fn github_oauth_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let path = match query.get("path").map(String::as_str) {
        Some(p @ ("device/code" | "oauth/access_token")) => p,
        _ => return cors((StatusCode::BAD_REQUEST, "path 는 device/code 또는 oauth/access_token").into_response()),
    };
    // application/x-www-form-urlencoded 본문 — reqwest 의 form 기능(추가 의존) 대신 직접 인코딩
    let form = query
        .iter()
        .filter(|(k, _)| k.as_str() != "tkn" && k.as_str() != "path")
        .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let res = reqwest::Client::new()
        .post(format!("https://github.com/login/{path}"))
        .header("accept", "application/json")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await;
    cors(match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), [("content-type", "application/json")], body)
                .into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("github.com 요청 실패: {e}")).into_response(),
    })
}

/// GET /git/credentials[?host=] — host 없으면 목록 {keychain, items[{host,username,label?,insecure}]}
/// (토큰 없음), 있으면 그 호스트의 {username, secret, label?} 또는 null. git 이 credential get 을 보낼 때
/// 프론트(gitauth)가 부른다 — 토큰은 응답으로 메모리에만 (gitcred 모듈). 인증·CORS 는 /ssh/* 와 같다
async fn git_credentials_get(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let v = match query.get("host").filter(|h| !h.is_empty()) {
        Some(h) => gitcred::get(h.clone()).await,
        None => gitcred::list().await,
    };
    cors(Json(v).into_response())
}

/// POST /git/credentials?action=set&host=&username=[&label=] (본문 = 토큰, text/plain — 단순 요청이라
/// preflight 없음) / ?action=delete&host=. set 응답 {insecure} — 키체인 부재로 파일에 갔는지
async fn git_credentials_post(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authed(&app, &query, &headers) {
        return cors(StatusCode::FORBIDDEN.into_response());
    }
    let host = query.get("host").cloned().unwrap_or_default();
    if host.is_empty() {
        return cors((StatusCode::BAD_REQUEST, "host 필요").into_response());
    }
    let result = match query.get("action").map(String::as_str) {
        Some("set") => {
            let username = query.get("username").cloned().unwrap_or_default();
            if username.is_empty() || body.is_empty() {
                return cors((StatusCode::BAD_REQUEST, "username·본문(토큰) 필요").into_response());
            }
            gitcred::set(host, username, query.get("label").cloned(), body).await
        }
        Some("delete") => gitcred::delete(host).await.map(|_| json!(null)),
        _ => return cors((StatusCode::BAD_REQUEST, "action 은 set 또는 delete").into_response()),
    };
    cors(match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    })
}

/// 폼 값 percent-encoding — 비예약 문자(영숫자·-_.~)만 그대로
fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
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
                Ok(p) if p.is_dir() => Target::Local(superlite_common::plain(p)),
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
    let grace = app.grace;
    ws.on_upgrade(move |sock| relay(sock, target, session, grace, spares))
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
        // 123B 한도 아래 여유 3B — 정확히 채울 이유가 없다
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
/// 이벤트). 접속은 별도 태스크 — 그동안 프론트 Close 를 감지해 긴 업로드
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
async fn relay(ws: WebSocket, target: Target, session: Option<String>, grace: Option<u64>, spares: Arc<ssh::Spares>) {
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
    // grace (와이어 v26): 단독 bin 의 연결만 — 폰의 화면 잠금을 견디는 detach 유예. 원격 데몬에도 이 값이
    // 간다 (환경변수는 ssh 너머로 전달되지 않는다)
    if let Some(g) = grace {
        attach["params"]["grace"] = json!(g);
    }
    if remote.as_ref().is_some_and(|r| r.browse_only) {
        attach["params"]["watch"] = json!(false);
    }
    if write_line(&mut write_half, &attach.to_string()).await.is_err() {
        return;
    }
    // 클라이언트 tmux 프로필(active)을 데몬에 (와이어 v17 tmuxConf, id 없음 — 응답 불요). 파일이 없으면 빈
    // 내용으로 보내 원격에 남은 옛 conf 를 지운다. 데몬이 plain 이면 무시한다
    let conf = conf::active_content();
    if write_line(&mut write_half, &json!({"method": "tmuxConf", "params": {"content": conf}}).to_string()).await.is_err() {
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
        let mut ping = tokio::time::interval(PING_INTERVAL);
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
                    if write_line(&mut write_half, PING_LINE).await.is_err() {
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
