//! superlight-backend — 앱 인스턴스당 1개. 웹(정적) 서빙 + WS 인터페이스.
//!
//! 유일한 네트워크 노출 지점 (_docs/decision/process-topology.md). 데몬을 tmux 방식으로
//! 자동 기동하고(접속 실패 → spawn → 재시도), 프론트 WS 연결마다 데몬 unix socket 연결을
//! 1:1 로 열어 그대로 중계한다 — id 재매핑 없음. 각 데몬 연결에 30초 주기 ping(생존 신호).
//!
//! 실행: superlight-backend [워크스페이스루트]  (기본 cwd)
//!   SUPERLIGHT_HTTP=127.0.0.1:8795  SUPERLIGHT_DIST=mock-front/dist
//!   SUPERLIGHT_TOKEN=<토큰>  — 설정 시 /ws 는 ?tkn= 일치 필수 (loopback 밖 노출 전제조건)
//!
//! ponytail: unix 전용 (spawn 분리·socket) — Windows 지원 때 named pipe/DETACHED_PROCESS 분기.

use std::path::PathBuf;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixStream};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct App {
    root: PathBuf,
    /// 설정 시 /ws 연결 토큰 — 로컬(loopback+Origin 검증)은 무인증이 기본이라 옵션이다
    token: Option<String>,
}

#[tokio::main]
async fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    let root = root.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다");
    // 네트워크 노출 지점은 여기 하나 — 기본은 localhost. 개발 LAN 접근은 vite(8793)가 프록시.
    let addr = std::env::var("SUPERLIGHT_HTTP").unwrap_or_else(|_| "127.0.0.1:8795".into());
    // 빌드된 프론트가 있으면 서빙. 개발 중엔 vite 가 프론트를 서빙하고 /ws 만 여기로 프록시.
    let dist = std::env::var("SUPERLIGHT_DIST").unwrap_or_else(|_| "mock-front/dist".into());

    // 상주 제어 연결 — 데몬 기동 보장 + 백엔드 생존 신호. 이게 있는 한 데몬은 안 죽는다.
    tokio::spawn(control_loop());

    let token = match std::env::var("SUPERLIGHT_TOKEN") {
        // WHY: 토큰 계산이 빈 문자열을 낳은 배포 스크립트가 조용히 무인증 노출로 빠지지 않게
        Ok(t) if t.is_empty() => {
            eprintln!("superlight-backend: SUPERLIGHT_TOKEN 이 비어 있다 — 무인증으로 열지 않는다");
            std::process::exit(1);
        }
        Ok(t) => Some(t),
        Err(_) => None,
    };
    let auth = if token.is_some() { "token" } else { "off" };
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&dist))
        .with_state(App { root: root.clone(), token });
    let listener = TcpListener::bind(&addr).await.expect("bind 실패 (SUPERLIGHT_HTTP 로 변경)");
    // dist 는 cwd 상대 기본값 — 다른 디렉터리에서 띄우면 404 만 나므로 경로를 같이 찍는다
    eprintln!("superlight-backend: http://{addr} root={} dist={dist} auth={auth}", root.display());
    axum::serve(listener, app).await.unwrap();
}

// ---------------------------------------------------------------- daemon

/// 데몬 연결 확보. spawn 은 제어 루프에서만 — relay 까지 spawn 하면 백엔드 하나가
/// 데몬을 두 번 띄우는 race 가 생긴다. 데몬 부재 시 제어 루프가 곧 재기동하므로
/// relay 는 재시도만으로 충분하다.
async fn daemon_conn(spawn: bool) -> Result<UnixStream, String> {
    let sock = superlight_common::socket_path();
    for i in 0..50 {
        if let Ok(s) = UnixStream::connect(&sock).await {
            return Ok(s);
        }
        if spawn && i == 0 {
            spawn_daemon()?;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("데몬 기동 실패 (5초): {}", sock.display()))
}

fn spawn_daemon() -> Result<(), String> {
    let bin = match std::env::var("SUPERLIGHT_DAEMON_BIN") {
        Ok(p) => PathBuf::from(p),
        // 형제 바이너리 — cargo build --workspace 가 둘 다 만든다
        Err(_) => std::env::current_exe()
            .map_err(|e| format!("current_exe: {e}"))?
            .with_file_name("superlight-daemon"),
    };
    let mut cmd = std::process::Command::new(&bin);
    // 프로세스 그룹 분리 — 백엔드 터미널의 Ctrl+C 가 데몬까지 죽이지 않게.
    // 로그는 상속 — 개발 중 백엔드 터미널에서 같이 보인다.
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
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
        let (read_half, mut write_half) = stream.into_split();
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

async fn write_line(w: &mut tokio::net::unix::OwnedWriteHalf, s: &str) -> std::io::Result<()> {
    w.write_all(s.as_bytes()).await?;
    w.write_all(b"\n").await
}

// ---------------------------------------------------------------- relay

/// 이른 반환 없는 상수시간 비교 — 토큰 대조가 타이밍으로 새지 않게 (길이는 샌다)
fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn ws_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // 토큰이 설정돼 있으면 Origin 검증과 별개로 ?tkn= 일치 필수 — loopback 밖 노출의 전제
    if let Some(token) = &app.token {
        if !query.get("tkn").is_some_and(|t| token_eq(t, token)) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    // WHY: WS 는 CORS 밖 — Origin 검증이 없으면 사용자가 방문한 임의의 웹페이지가
    //      localhost 백엔드에 붙어 셸을 얻는다. 브라우저 요청은 Origin 호스트가 Host 와
    //      같아야 하고(같은 오리진·vite 프록시 모두 충족), 비브라우저(체크 스크립트)는
    //      Origin 이 없어 통과한다.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
        let origin_host =
            origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"));
        if origin_host != Some(host) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    // 프론트가 만든 세션 id — 데몬이 재접속 시 같은 세션(터미널)을 이어 붙이는 키.
    // 없으면(체크 스크립트) 익명 세션 — 연결과 함께 죽는 종전 동작.
    // 빈 문자열은 익명 취급 — ?session= 만 넘긴 클라이언트들이 "" 키 하나를 공유하지 않게
    let session = query.get("session").cloned().filter(|s| !s.is_empty());
    ws.on_upgrade(move |sock| relay(sock, app.root, session))
}

/// 프론트 WS ↔ 데몬 소켓 1:1 중계. 어느 쪽이 끊겨도 둘 다 정리 —
/// 데몬 쪽 연결 drop 이 그 연결의 터미널을 정리한다.
async fn relay(mut ws: WebSocket, root: PathBuf, session: Option<String>) {
    let Ok(stream) = daemon_conn(false).await else {
        return; // ws 는 drop 으로 닫힌다 — 프론트 onclose 가 진행 중 요청을 실패 처리
    };
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();
    // 첫 줄은 attach. 응답(id 0)이 프론트로 중계돼도 무시된다 — 프론트 id 는 1부터.
    let mut attach = json!({"id": 0, "method": "attach", "params": {"root": root.to_string_lossy()}});
    if let Some(s) = session {
        attach["params"]["session"] = json!(s);
    }
    if write_line(&mut write_half, &attach.to_string()).await.is_err() {
        return;
    }
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await; // interval 의 첫 즉시 틱 소비
    loop {
        tokio::select! {
            msg = ws.recv() => match msg {
                Some(Ok(Message::Text(t))) => {
                    // 생 개행이 든 프레임은 데몬 쪽에서 N개 요청으로 쪼개진다(1:1 불변식
                    // 파괴 — JSON.stringify 출력엔 있을 수 없다). 프로토콜 위반 → 연결 종료
                    if t.as_str().contains('\n')
                        || write_line(&mut write_half, t.as_str()).await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {} // binary/ping/pong 프레임은 프로토콜에 없다
            },
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if ws.send(Message::Text(l.into())).await.is_err() {
                        break;
                    }
                }
                _ => break,
            },
            _ = ping.tick() => {
                if write_line(&mut write_half, r#"{"method":"ping"}"#).await.is_err() {
                    break;
                }
            }
        }
    }
}
