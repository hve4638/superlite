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
use axum::Router;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

#[cfg(unix)]
type DaemonStream = tokio::net::UnixStream;
#[cfg(windows)]
type DaemonStream = tokio::net::windows::named_pipe::NamedPipeClient;

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
}

/// 서버 기동 단일 진입점 — 제어 연결을 spawn 하고 /ws(+옵션 dist) 라우터를 listener 위에 serve.
pub async fn serve(listener: TcpListener, roots: SessionRoots, token: Option<String>, dist: Option<String>) {
    // 상주 제어 연결 — 데몬 기동 보장 + 백엔드 생존 신호. 이게 있는 한 데몬은 안 죽는다.
    tokio::spawn(control_loop());

    let mut app = Router::new().route("/ws", get(ws_handler));
    if let Some(dist) = &dist {
        app = app.fallback_service(ServeDir::new(dist));
    }
    let app = app.with_state(App { roots, token });
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

async fn ws_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Some(token) = &app.token {
        // 토큰 일치가 곧 인증 — 이때 Origin 검증은 생략한다. 임의 웹페이지는 랜덤 토큰을
        // 알 수 없어 CSRF 가 성립하지 않고, Tauri webview(tauri://·http://tauri.localhost)
        // 처럼 Origin 이 Host 와 다를 수밖에 없는 정당한 클라이언트가 이 경로로 들어온다.
        if !query.get("tkn").is_some_and(|t| token_eq(t, token)) {
            return StatusCode::FORBIDDEN.into_response();
        }
    } else if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        // WHY: WS 는 CORS 밖 — Origin 검증이 없으면 사용자가 방문한 임의의 웹페이지가
        //      localhost 백엔드에 붙어 셸을 얻는다. 브라우저 요청은 Origin 호스트가 Host 와
        //      같아야 하고(같은 오리진·vite 프록시 모두 충족), 비브라우저(체크 스크립트)는
        //      Origin 이 없어 통과한다.
        let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
        let origin_host =
            origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"));
        if origin_host != Some(host) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    // 세션 id — 데몬이 재접속 시 같은 세션(터미널)을 이어 붙이는 키.
    // 없으면(체크 스크립트) 익명 세션 — 연결과 함께 죽는 종전 동작.
    // 빈 문자열은 익명 취급 — ?session= 만 넘긴 클라이언트들이 "" 키 하나를 공유하지 않게
    let session = query.get("session").cloned().filter(|s| !s.is_empty());
    // 웹 '폴더 열기' — Fixed(bin) 는 ?folder= 절대 경로로 root 를 넘겨받는다 (VS Code web
    // 의 ?folder= 상당). /ws 인증 통과자는 이미 터미널로 셸을 얻으므로 임의 root 가 권한을
    // 넓히지 않는다. Registry(Tauri) 는 무시 — root 결정권은 native 에 남는다.
    let root = match (&app.roots, query.get("folder").filter(|f| !f.is_empty())) {
        (SessionRoots::Fixed(_), Some(folder)) => {
            // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
            match std::path::Path::new(folder).canonicalize() {
                Ok(p) if p.is_dir() => superlight_common::plain(p),
                _ => return StatusCode::FORBIDDEN.into_response(),
            }
        }
        // Registry 모드는 미등록·부재·루트 없는 세션을 거부한다 — root 는 등록 시점에
        // native 가 정한 것만.
        // WHY: 거부를 HTTP 403 이 아니라 upgrade 후 close 4403 으로 — 브라우저 WS 는
        //      handshake 실패의 HTTP status 를 노출하지 않아, 403 은 백엔드 다운(재시도
        //      가치 있음)과 구분되지 않고 front 가 1초 간격 무한 재연결에 빠진다.
        //      close code 만이 "재시도 무의미"를 전할 수 있는 통로다.
        _ => match app.roots.resolve(session.as_deref()) {
            Some(root) => root,
            None => {
                return ws.on_upgrade(|mut sock| async move {
                    let close = Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 4403,
                        reason: "unknown session".into(),
                    }));
                    let _ = sock.send(close).await;
                });
            }
        },
    };
    ws.on_upgrade(move |sock| relay(sock, root, session))
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

/// 순차 읽기 전용 — select 안에서 쓰면 취소 시 부분 읽기가 유실돼 프레임 동기가 깨진다.
/// (전용 태스크에서만 호출할 것)
async fn read_frame(
    r: &mut BufReader<tokio::io::ReadHalf<DaemonStream>>,
) -> std::io::Result<Option<DaemonFrame>> {
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

/// 프론트 WS ↔ 데몬 소켓 1:1 중계. 어느 쪽이 끊겨도 둘 다 정리 —
/// 데몬 쪽 연결 drop 이 그 연결의 터미널을 정리한다.
/// 방향별 전용 태스크 — 바이너리 프레임 읽기(read_frame)는 다중 await 라 select 취소에
/// 안전하지 않아, 종전의 단일 select 루프 구조를 쓸 수 없다.
async fn relay(ws: WebSocket, root: PathBuf, session: Option<String>) {
    use futures_util::{SinkExt, StreamExt};
    let Ok(stream) = daemon_conn(false).await else {
        return; // ws 는 drop 으로 닫힌다 — 프론트 onclose 가 진행 중 요청을 실패 처리
    };
    let (read_half, mut write_half) = tokio::io::split(stream);
    // 첫 줄은 attach. 응답(id 0)이 프론트로 중계돼도 무시된다 — 프론트 id 는 1부터.
    let mut attach = json!({"id": 0, "method": "attach", "params": {"root": root.to_string_lossy()}});
    if let Some(s) = session {
        attach["params"]["session"] = json!(s);
    }
    if write_line(&mut write_half, &attach.to_string()).await.is_err() {
        return;
    }
    let (mut ws_tx, mut ws_rx) = ws.split();

    // 데몬 → 프론트: 순차 프레임 읽기 → WS 재프레이밍 (Line→Text, Bin→Binary)
    let mut down = tokio::spawn(async move {
        let mut reader = BufReader::new(read_half);
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
                        // 생 개행이 든 프레임은 데몬 쪽에서 N개 요청으로 쪼개진다(1:1 불변식
                        // 파괴 — JSON.stringify 출력엔 있을 수 없다). 프로토콜 위반 → 연결 종료
                        if t.as_str().contains('\n')
                            || write_line(&mut write_half, t.as_str()).await.is_err()
                        {
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
