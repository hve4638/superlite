//! superlight-app — Tauri 데스크톱 껍데기. front dist 를 자산으로 번들하고,
//! relay(serve)를 loopback 임의 포트로 in-process 기동해 WS endpoint 를 webview 에
//! 주입한다. 와이어 계약·daemon 분리 수명(tmux 식)은 그대로 — Tauri IPC 전환은 비목표.
//!
//! 세션 레지스트리(session id → root)는 여기(native)가 소유한다 — front 는 WS 접속 시
//! session id 만 말하고, root 는 dialog·드롭·argv 로 native 에 모인 것만 등록된다
//! (decision/workspace-session-tabs.md).
//!
//! 세션 목록은 state.json(app_data_dir)에 지속되어 재실행 시 마지막 워크스페이스가
//! 복원된다 — 스키마·쓰기 규칙은 decision/state-persistence.md.
//!
//! 실행: superlight-app [워크스페이스루트]  (인자 없으면 저장된 세션 복원, 없으면 cwd)

// 릴리스 Windows 에서 콘솔 창이 같이 뜨지 않게
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use superlight_backend::SessionRoots;
use tauri::Manager;

struct AppState {
    ws_url: String,
    sessions: Arc<Mutex<HashMap<String, PathBuf>>>,
    state_file: PathBuf,
}

/// 디스크에 남기는 상태 — 스키마·규칙은 docs/decision/state-persistence.md.
/// 저장 단위는 세션 목록이다 (단일 세션은 원소 1개인 특수형 — 세션 탭이 와도 스키마 유지).
/// 엔트리가 객체인 것은 추후 front 세션 상태 참조가 붙을 자리라서다.
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedState {
    version: u32,
    workspaces: Vec<WorkspaceEntry>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct WorkspaceEntry {
    root: PathBuf,
}

/// 세션 레지스트리를 state.json 에 저장 — 레지스트리 변경(창 열림·닫힘)마다 호출한다.
/// 종료 훅에 의존하지 않으므로 crash 에도 마지막 변경까지 남는다.
/// WHY: 빈 목록은 저장하지 않는다 — 마지막 창 닫힘(=종료)이 종료 직전 목록을 지우면
///      다음 기동에 복원할 것이 사라진다. 그래서 파일에는 항상 마지막 비어있지 않은
///      목록이 남고, 그것이 복원 대상이다.
fn persist_workspaces(state: &AppState) {
    let workspaces: Vec<WorkspaceEntry> = state
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|root| WorkspaceEntry { root: root.clone() })
        .collect();
    if workspaces.is_empty() {
        return;
    }
    let json = serde_json::to_string(&PersistedState { version: 1, workspaces })
        .expect("상태 직렬화는 실패할 수 없다");
    // tmp 에 쓴 뒤 rename — torn write 로 파일이 깨지지 않게
    let tmp = state.state_file.with_extension("json.tmp");
    if let Err(e) =
        std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, &state.state_file))
    {
        eprintln!("superlight-app: 상태 저장 실패: {e}");
    }
}

/// 저장된 워크스페이스 목록을 읽는다. 파일 없음·파싱 실패·버전 불일치는 빈 목록으로
/// 취급한다 — 호출자(setup)가 cwd 로 fallback 한다.
fn load_workspaces(state_file: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(state_file) else {
        return Vec::new();
    };
    match serde_json::from_str::<PersistedState>(&text) {
        Ok(s) if s.version == 1 => s.workspaces.into_iter().map(|w| w.root).collect(),
        _ => Vec::new(),
    }
}

fn rand_hex() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("난수 생성 실패");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 폴더 선택 dialog → 세션 전환. front 의 '폴더 열기' 커맨드가 invoke 한다.
/// 취소는 무동작. 성공 시 호출한 창을 닫는다 (기존 세션 교체 — 지금은 활성 세션 1개).
#[tauri::command]
async fn open_folder(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let Some(dir) = rfd::AsyncFileDialog::new().pick_folder().await else {
        return Ok(());
    };
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root = superlight_common::plain(
        dir.path().canonicalize().map_err(|e| format!("경로 확인 실패: {e}"))?,
    );
    // WHY: webview 창 생성은 메인 스레드(이벤트 루프)에서 — async 커맨드 스레드에서
    //      build 하면 Windows 에서 창은 뜨되 콘텐츠가 초기화되지 않은 빈 창이 된다 (실측).
    let handle = app.clone();
    app.run_on_main_thread(move || switch_session(&handle, &window, root))
        .map_err(|e| e.to_string())
}

/// 세션 교체 실행부 — 메인 스레드에서만 호출한다. dialog 와 OS 폴더 드롭이 공유한다.
fn switch_session(app: &tauri::AppHandle, window: &tauri::WebviewWindow, root: PathBuf) {
    let state = app.state::<AppState>();
    if let Err(e) = open_workspace(app, &state, root) {
        eprintln!("superlight-app: 세션 전환 실패: {e}");
        return;
    }
    // 새 창이 뜬 뒤에 닫는다 — 마지막 창이 닫히면 앱이 종료되므로 순서가 수명이다
    let _ = window.close();
    // 교체된 세션은 레지스트리에서 제거 — 레지스트리 = 살아 있는 세션 불변식 유지.
    // 데몬 쪽 상태(터미널)는 연결 끊김 후 grace 규칙대로 회수된다.
    if let Some(old) = window.label().strip_prefix("s-") {
        if state.sessions.lock().unwrap().remove(old).is_some() {
            persist_workspaces(&state);
        }
    }
}

/// 세션 전환 단일 진입점 — 새 session id 를 발급·등록하고 그 세션의 창을 띄운다.
/// 이전 창 정리는 호출자(switch_session) 몫.
fn open_workspace(
    app: &tauri::AppHandle,
    state: &AppState,
    root: PathBuf,
) -> tauri::Result<()> {
    let session = rand_hex();
    state.sessions.lock().unwrap().insert(session.clone(), root);
    persist_workspaces(state);
    spawn_session_window(app, &state.ws_url, &session)
}

/// 세션 하나를 렌더링하는 창. label 은 session id 기반 — 창들은 대등하고 메인 창 개념이 없다.
fn spawn_session_window(
    app: &tauri::AppHandle,
    ws_url: &str,
    session: &str,
) -> tauri::Result<()> {
    // 주입 스크립트는 프론트 코드 실행 전에 평가된다 (host.ts 가 두 값을 읽는다)
    // WHY: 숨김 기동(visible false → load 후 show)은 쓰지 않는다 — WebView2 가 숨김
    //      상태에서 로딩을 미뤄 오히려 흰 화면이 길어지는 역효과가 실측됐다.
    //      흰 플래시는 창 배경색 + index.html 인라인 배경으로 막는다.
    let window = tauri::WebviewWindowBuilder::new(
        app,
        format!("s-{session}"),
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("superlight")
    .inner_size(1200.0, 800.0)
    // OS 창 헤더 없음 — 창 제어(닫기·최소화·최대화·드래그)는 front TitleBar 가 가진다
    .decorations(false)
    // WHY: Tauri 의 drag-drop 핸들러가 켜져 있으면 WebView2(Windows)가 HTML5 DnD
    //      이벤트를 가로채 내부 DnD(pane 분할·탭·탐색기 드래그)가 DOM 에 도달하지 않는다.
    .disable_drag_drop_handler()
    // 첫 페인트 전 흰 플래시 방지 — 테마 배경(--vscode-editor-background)과 일치
    .background_color(tauri::window::Color(0x1f, 0x1f, 0x1f, 0xff))
    .initialization_script(&format!(
        "window.__SUPERLIGHT_WS__ = '{ws_url}'; window.__SUPERLIGHT_SESSION__ = '{session}';"
    ))
    .build()?;
    #[cfg(windows)]
    attach_os_drop(app, &window);
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

/// OS 파일/폴더 드롭 수신 (Windows 전용). disable_drag_drop_handler 로 Tauri 의 파일 드롭
/// 이벤트가 꺼진 상태의 공식 대체 경로다 (WebView2 WebMessageObjects): front 가 DOM drop 의
/// FileSystemHandle/File 객체를 postMessageWithAdditionalObjects 로 넘기면 여기서 절대
/// 경로·종류를 읽는다. root 결정권은 native 유지 — 경로는 드롭 객체에서만 나오고 front 가
/// 문자열로 지목할 통로는 없다.
#[cfg(windows)]
fn attach_os_drop(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::Interface;

    let app = app.clone();
    let win = window.clone();
    let _ = window.with_webview(move |webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let mut token = Default::default();
        // WHY: WebMessageReceived 는 멀티캐스트 — wry 의 IPC 핸들러와 공존한다. wry 는
        //      문자열 메시지만 읽으므로 front 가 객체 메시지로 보내면 서로를 오염시키지 않고,
        //      우리 쪽은 부속 객체 유무로 드롭 메시지만 골라낸다.
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
                return Ok(());
            };
            let Ok(objects) = (unsafe { args2.AdditionalObjects() }) else {
                return Ok(());
            };
            let mut count = 0u32;
            unsafe { objects.Count(&mut count)? };

            let mut dirs: Vec<String> = Vec::new();
            let mut files: Vec<String> = Vec::new();
            for i in 0..count {
                let Ok(obj) = (unsafe { objects.GetValueAtIndex(i) }) else {
                    continue;
                };
                let Ok(file) = obj.cast::<ICoreWebView2File>() else {
                    continue;
                };
                let mut path = windows_core::PWSTR::null();
                if unsafe { file.Path(&mut path) }.is_err() {
                    continue;
                }
                let path = take_pwstr(path);
                // WHY: 파일/폴더 구분은 경로를 직접 stat — DOM File 에는 종류 정보가 없고
                //      (폴더도 File 로 온다), 경로가 native 획득 값이라 믿을 수 있다.
                let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
                if is_dir {
                    dirs.push(path);
                } else {
                    files.push(path);
                }
            }

            if let Some(dir) = dirs.into_iter().next() {
                // 폴더 드롭 = 세션 전환 (첫 폴더만).
                // WHY: 이 콜백은 메인 스레드의 WebView2 이벤트 안이다 — run_on_main_thread 는
                //      메인 스레드에서 인라인 실행되므로 여기서 곧장 부르면 이벤트 핸들러
                //      재진입 상태로 webview 창을 만들게 되어 새 창이 멈춘다 (실측).
                //      별도 스레드를 거쳐야 이벤트 루프 큐로 넘어간다.
                let app2 = app.clone();
                let win2 = win.clone();
                std::thread::spawn(move || {
                    let app3 = app2.clone();
                    let _ = app2.run_on_main_thread(move || {
                        // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다
                        match std::path::Path::new(&dir).canonicalize() {
                            Ok(root) => switch_session(&app3, &win2, superlight_common::plain(root)),
                            Err(e) => eprintln!("superlight-app: 드롭 경로 확인 실패: {e}"),
                        }
                    });
                });
            } else if !files.is_empty() {
                // 파일 드롭 — 루트 상대화·열기 판단은 front 몫이라 절대 경로만 돌려준다
                let json =
                    serde_json::json!({ "superlightOsDrop": { "files": files } }).to_string();
                unsafe { sender.PostWebMessageAsJson(&windows_core::HSTRING::from(json))? };
            }
            Ok(())
        }));
        let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
    });
}

/// 두 번째 실행 수신 (single-instance) — 넘어온 argv·cwd 로 root 를 정해 기존 프로세스에
/// 새 세션 창을 추가한다. 창들은 대등하므로 기존 창은 건드리지 않는다
/// ("폴더 인자 실행 → 기존 앱에 새 세션" UX — app-installer 의 "CSL로 열기"가 이 경로를 탄다).
fn open_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    // 상대 경로 인자는 두 번째 프로세스의 cwd 기준 — join 은 절대 경로 인자를 그대로 쓴다
    let root = match argv.get(1) {
        Some(arg) => PathBuf::from(&cwd).join(arg),
        None => PathBuf::from(&cwd),
    };
    // WHY: 별도 스레드 경유 — 이 콜백은 메인 스레드의 플러그인 이벤트 처리 중일 수 있고,
    //      run_on_main_thread 는 메인 스레드에서 인라인 실행되므로 곧장 부르면 이벤트
    //      재진입 상태로 webview 창을 만들게 된다 (attach_os_drop 과 같은 회피).
    let app = app.clone();
    std::thread::spawn(move || {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
            // 경로 오류는 로그만 — 두 번째 실행의 잘못된 인자가 기존 앱을 죽이면 안 된다
            match root.canonicalize() {
                Ok(root) => {
                    let state = handle.state::<AppState>();
                    if let Err(e) =
                        open_workspace(&handle, &state, superlight_common::plain(root))
                    {
                        eprintln!("superlight-app: 두 번째 실행 세션 열기 실패: {e}");
                    }
                }
                Err(e) => eprintln!("superlight-app: 두 번째 실행 경로 확인 실패: {e}"),
            }
        });
    });
}

fn main() {
    // 명시 인자의 canonicalize 는 setup 에서 — 저장 상태 로드와 우선순위를 한 곳에서 정한다
    let cli_root = std::env::args().nth(1).map(PathBuf::from);

    // 기동마다 새 랜덤 토큰 — 같은 머신의 외부 브라우저·임의 웹페이지가 /ws 에 붙지 못하게.
    // 주입 URL 밖으로는 전달되지 않는다.
    let token = rand_hex();

    // :0 bind — 포트는 OS 가 고르므로 고정 포트 충돌이 없다. 주입 URL 이 유일한 전달 경로.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback bind 실패");
    listener.set_nonblocking(true).expect("nonblocking 전환 실패");
    let port = listener.local_addr().expect("local_addr").port();
    let ws_url = format!("ws://127.0.0.1:{port}/ws?tkn={token}");

    let sessions: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();

    // relay 는 별도 스레드의 tokio 런타임에서 — Tauri 의 메인 스레드(이벤트 루프)와 분리
    {
        let token = token.clone();
        let roots = SessionRoots::Registry(sessions.clone());
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio 런타임 생성 실패")
                .block_on(async move {
                    let listener =
                        tokio::net::TcpListener::from_std(listener).expect("listener 전환 실패");
                    superlight_backend::serve(listener, roots, Some(token), None).await;
                });
        });
    }

    tauri::Builder::default()
        // WHY: single-instance 는 맨 먼저 등록 — 두 번째 실행이 다른 초기화를 밟기 전에
        //      argv·cwd 를 첫 프로세스로 넘기고 즉시 종료해야 한다 (공식 권고).
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_second_instance(app, argv, cwd)
        }))
        .invoke_handler(tauri::generate_handler![open_folder])
        // 창 닫힘 시 레지스트리 정리 — 사용자가 창을 직접 닫는 경로를 잡는다.
        // switch_session 경유 닫힘은 이미 제거돼 있어 no-op (remove 성공시에만 저장).
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(session) = window.label().strip_prefix("s-") {
                    let state = window.app_handle().state::<AppState>();
                    if state.sessions.lock().unwrap().remove(session).is_some() {
                        persist_workspaces(&state);
                    }
                }
            }
        })
        .setup(move |app| {
            // 상태 파일은 OS 관례 경로(app_data_dir) 아래 state.json —
            // 스키마·쓰기 규칙은 docs/decision/state-persistence.md
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let state_file = data_dir.join("state.json");

            // 복원 우선순위: 명시 argv > 저장된 세션 목록 > cwd.
            // 명시 인자의 경로 오류는 즉시 실패, 저장 목록의 소실 경로(삭제·이동)는
            // 조용히 건너뛴다 — 남는 게 없으면 cwd fallback.
            let roots: Vec<PathBuf> = match &cli_root {
                Some(arg) => {
                    vec![arg.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다")]
                }
                None => {
                    let saved: Vec<PathBuf> = load_workspaces(&state_file)
                        .into_iter()
                        .filter_map(|p| p.canonicalize().ok())
                        .collect();
                    if saved.is_empty() {
                        vec![std::env::current_dir()
                            .unwrap()
                            .canonicalize()
                            .expect("워크스페이스 루트 경로가 존재해야 한다")]
                    } else {
                        saved
                    }
                }
            };

            app.manage(AppState { ws_url, sessions, state_file });
            let state = app.state::<AppState>();
            // 포트가 런타임에 정해지므로 창은 코드로 생성 — 초기 세션도 같은 전환 경로를 탄다
            for root in roots {
                // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
                open_workspace(app.handle(), &state, superlight_common::plain(root))?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 기동 실패");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state(name: &str) -> AppState {
        AppState {
            ws_url: String::new(),
            sessions: Arc::default(),
            state_file: std::env::temp_dir().join(format!("superlight-test-{name}-{}.json", rand_hex())),
        }
    }

    #[test]
    fn persist_load_roundtrip() {
        let state = temp_state("roundtrip");
        state.sessions.lock().unwrap().insert("a".into(), PathBuf::from("/tmp/a"));
        state.sessions.lock().unwrap().insert("b".into(), PathBuf::from("/tmp/b"));
        persist_workspaces(&state);

        let mut loaded = load_workspaces(&state.state_file);
        loaded.sort();
        assert_eq!(loaded, vec![PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b")]);
        let _ = std::fs::remove_file(&state.state_file);
    }

    #[test]
    fn empty_registry_not_persisted() {
        let state = temp_state("skip-empty");
        state.sessions.lock().unwrap().insert("a".into(), PathBuf::from("/tmp/a"));
        persist_workspaces(&state);
        // 마지막 창 닫힘(=종료) 시나리오 — 빈 저장이 직전 목록을 지우면 안 된다
        state.sessions.lock().unwrap().clear();
        persist_workspaces(&state);

        assert_eq!(load_workspaces(&state.state_file), vec![PathBuf::from("/tmp/a")]);
        let _ = std::fs::remove_file(&state.state_file);
    }

    #[test]
    fn missing_or_corrupt_file_loads_empty() {
        let missing = std::env::temp_dir().join(format!("superlight-test-missing-{}.json", rand_hex()));
        assert!(load_workspaces(&missing).is_empty());

        let corrupt = std::env::temp_dir().join(format!("superlight-test-corrupt-{}.json", rand_hex()));
        std::fs::write(&corrupt, "{ torn").unwrap();
        assert!(load_workspaces(&corrupt).is_empty());
        let _ = std::fs::remove_file(&corrupt);
    }

    #[test]
    fn version_mismatch_ignored() {
        let file = std::env::temp_dir().join(format!("superlight-test-ver-{}.json", rand_hex()));
        std::fs::write(&file, r#"{ "version": 2, "workspaces": [{ "root": "/tmp/a" }] }"#).unwrap();
        assert!(load_workspaces(&file).is_empty());
        let _ = std::fs::remove_file(&file);
    }
}
