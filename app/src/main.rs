//! superlight-app — Tauri 데스크톱 껍데기. front dist 를 자산으로 번들하고,
//! relay(serve)를 loopback 임의 포트로 in-process 기동해 WS endpoint 를 webview 에
//! 주입한다. 와이어 계약·daemon 분리 수명(tmux 식)은 그대로 — Tauri IPC 전환은 비목표.
//!
//! 세션 레지스트리(session id → root, 순서 = 탭 순서)는 여기(native)가 소유한다 — front 는
//! WS 접속 시 session id 만 말하고, root 는 dialog·퀵인풋·드롭·argv 로 native 에 모인
//! 것만 등록된다 (decision/workspace-session-tabs.md).
//!
//! 창은 하나다 — 세션 탭 전환은 front 가 페이지 안에서 세션 컨텍스트(연결·모델)를
//! 교체하는 것이고 (웹과 동일 동작), native 는 창을 옮기지 않는다. native 의 몫은
//! 레지스트리(추가·제거)와 그 변경 방송(sessions-changed)뿐이며, 어느 탭이 활성인지는
//! 모른다.
//!
//! 시작은 항상 빈 세션(시작 페이지)이다 — 마지막 워크스페이스 복원·지속 저장은 하지
//! 않는다 (2026-09-02 사용자 결정, ticket app-empty-session). 명시 argv 로 준 폴더만 연다.
//!
//! 실행: superlight-app [워크스페이스루트]  (인자 없으면 빈 세션으로 시작)

// 릴리스 Windows 에서 콘솔 창이 같이 뜨지 않게
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use superlight_backend::SessionRoots;
use tauri::{Emitter, Manager};

/// 세션 레지스트리 — 순서가 곧 탭 순서 (relay 의 SessionRoots::Registry 와 공유).
/// root None = 루트 없는 빈 세션 (시작 페이지 탭, ticket app-empty-session) —
/// 백엔드 연결 없이 front 에만 그려지고, 폴더를 열면 그 자리가 교체된다
type Sessions = Arc<Mutex<Vec<(String, Option<PathBuf>)>>>;

struct AppState {
    ws_url: String,
    sessions: Sessions,
}

/// 세션 탭 표시용 사영 — 부팅 주입(__SUPERLIGHT_SESSIONS__)·list_sessions 응답·
/// sessions-changed 이벤트 payload 가 전부 이 모양이다
#[derive(Clone, serde::Serialize)]
struct SessionInfo {
    id: String,
    name: String,
    /// null = 루트 없는 빈 세션 — 표시 라벨·시작 페이지 여부는 front 가 이걸로 판단한다
    root: Option<String>,
}

fn session_infos(sessions: &Sessions) -> Vec<SessionInfo> {
    sessions
        .lock()
        .unwrap()
        .iter()
        .map(|(id, root)| SessionInfo {
            id: id.clone(),
            name: root
                .as_deref()
                .map(|r| {
                    r.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| r.to_string_lossy().into_owned())
                })
                .unwrap_or_default(),
            root: root.as_deref().map(|r| r.to_string_lossy().into_owned()),
        })
        .collect()
}

/// 레지스트리 변경 방송 — front 세션 관리자가 이 목록으로 reconcile 한다
fn emit_sessions(app: &tauri::AppHandle, sessions: &Sessions) {
    let _ = app.emit("sessions-changed", session_infos(sessions));
}

fn rand_hex() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("난수 생성 실패");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 'Open Folder' 경로 퀵인풋의 시작 경로 — 열린 워크스페이스가 없을 때(빈 세션) 쓴다.
/// front 가 navigator 로 OS 를 추측하면 웹(리눅스 서버)에서 틀리므로, 데몬과 같은
/// 머신인 native 가 정한다. Windows 는 시스템 드라이브 루트(예: `C:/`), 그 외는 `/`.
fn default_open_root() -> String {
    #[cfg(windows)]
    {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        format!("{}/", drive.trim_end_matches(['/', '\\']))
    }
    #[cfg(not(windows))]
    {
        "/".to_string()
    }
}

/// 새 세션 등록 단일 진입점 — 새 session id 를 발급해 레지스트리에 붙이고 방송한다.
/// front 는 sessions-changed 를 받아 새 id 로 WS 연결을 열고 그 탭을 활성으로 만든다.
/// dialog·퀵인풋·OS 드롭·두 번째 실행이 공유한다.
///
/// replace 는 빈 세션 탭 id (시작 페이지에서 열기) — 그 엔트리가 아직 root 없는
/// 채로 있으면 push 대신 그 자리를 교체해 탭 위치를 보존한다. id 는 새로 발급 —
/// front reconcile 이 제거+추가로 자연히 따라온다.
///
/// 같은 워크스페이스가 이미 열려 있으면 새 탭 대신 그 탭으로 포커스만 옮긴다
/// (session-focus 이벤트 — front 가 활성 탭을 바꾼다. 빈 탭은 그대로 남는다).
/// 워크스페이스 정체성은 지금은 canonicalize 된 로컬 경로가 전부지만, ssh 등 원격
/// 세션이 붙으면 (origin, path) 쌍이 되어야 한다 — 같은 경로라도 origin 이 다르면
/// 별개 세션이다.
fn open_workspace(app: &tauri::AppHandle, state: &AppState, root: PathBuf, replace: Option<&str>) {
    {
        let mut list = state.sessions.lock().unwrap();
        if let Some((id, _)) = list.iter().find(|(_, r)| r.as_ref() == Some(&root)) {
            let id = id.clone();
            drop(list);
            let _ = app.emit("session-focus", id);
            return;
        }
        let session = rand_hex();
        // 교체 대상은 여전히 루트가 없어야 한다 — 경합(그 사이 다른 열기로 교체됨)이면 push
        match replace.and_then(|rid| list.iter().position(|(id, r)| id == rid && r.is_none())) {
            Some(i) => list[i] = (session, Some(root)),
            None => list.push((session, Some(root))),
        }
    }
    emit_sessions(app, &state.sessions);
}

/// 폴더 선택 dialog → 새 세션 탭 추가. front 의 '폴더 열기' 커맨드·시작 페이지·
/// + 드롭다운이 invoke 한다. 취소는 무동작. replace 는 빈 세션 탭 id (open_workspace 참조).
#[tauri::command]
async fn open_folder(app: tauri::AppHandle, replace: Option<String>) -> Result<(), String> {
    let Some(dir) = rfd::AsyncFileDialog::new().pick_folder().await else {
        return Ok(());
    };
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root = superlight_common::plain(
        dir.path().canonicalize().map_err(|e| format!("경로 확인 실패: {e}"))?,
    );
    let state = app.state::<AppState>();
    open_workspace(&app, &state, root, replace.as_deref());
    Ok(())
}

/// front 폴더 퀵인풋(Ctrl+O)이 확정한 절대 경로로 새 세션 탭 추가. 경로 지목 통로 개방의
/// 근거는 ws docs/decision/web-folder-open.md 개정 — webview 는 이미 /ws 로 셸을
/// 가지므로 권한 확대가 아니고, 검증·세션 등록은 여전히 여기(native)가 소유한다.
#[tauri::command]
fn open_folder_path(app: tauri::AppHandle, path: String, replace: Option<String>) -> Result<(), String> {
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root = superlight_common::plain(
        std::path::Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("경로 확인 실패: {e}"))?,
    );
    if !root.is_dir() {
        return Err(format!("디렉토리가 아니다: {}", root.display()));
    }
    let state = app.state::<AppState>();
    open_workspace(&app, &state, root, replace.as_deref());
    Ok(())
}

/// 루트 없는 빈 세션 탭 추가 (탭 + 버튼) — 중복 검사 없음, 빈 탭은 여러 개 공존
/// 가능하다 (VS Code 빈 창과 동일).
#[tauri::command]
fn open_empty_session(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.sessions.lock().unwrap().push((rand_hex(), None));
    emit_sessions(&app, &state.sessions);
}

/// 순서 이동의 재배열 본체 — to 는 표시 목록 기준 삽입 인덱스 (이동 중 탭 포함,
/// 제거 후 인덱스 보정). 없는 id 는 무동작
fn move_entry(list: &mut Vec<(String, Option<PathBuf>)>, id: &str, to: usize) -> bool {
    let Some(i) = list.iter().position(|(sid, _)| sid == id) else {
        return false;
    };
    let item = list.remove(i);
    let to = if to > i { to - 1 } else { to }.min(list.len());
    list.insert(to, item);
    true
}

/// 탭 드래그 순서 이동 — 순서의 단일 출처는 레지스트리이므로 재배열도 native 가 하고,
/// 방송으로 front 가 따라온다
#[tauri::command]
fn move_session(app: tauri::AppHandle, id: String, to: usize) {
    let state = app.state::<AppState>();
    if !move_entry(&mut state.sessions.lock().unwrap(), &id, to) {
        return;
    }
    emit_sessions(&app, &state.sessions);
}

/// 세션 탭 목록 — front 세션 관리자의 초기 동기화 (이후 갱신은 sessions-changed 이벤트)
#[tauri::command]
fn list_sessions(state: tauri::State<AppState>) -> Vec<SessionInfo> {
    session_infos(&state.sessions)
}

/// 탭 닫기 = 세션 종료(kill 의미) — 레지스트리에서 제거해 재-attach 를 차단한다.
/// front 가 그 세션의 WS 연결을 끊으면 데몬 detach → 세션 grace 후 터미널 회수
/// (즉시 kill 와이어는 없다 — grace 지연 회수 수용, docs/ticket/app-session-tabs).
/// 마지막 탭을 닫으면 앱을 종료하는 대신 루트 없는 빈 세션(시작 페이지)으로 대체한다
/// (VS Code 처럼 — 앱 종료는 창 X 로만. 창 하나 = 앱 수명 규칙은 창 닫기에만 남고,
/// 탭 닫기는 최소 한 탭을 유지한다).
#[tauri::command]
fn close_session(app: tauri::AppHandle, id: String) {
    let state = app.state::<AppState>();
    {
        let mut list = state.sessions.lock().unwrap();
        let Some(i) = list.iter().position(|(sid, _)| sid == &id) else {
            return;
        };
        list.remove(i);
        if list.is_empty() {
            list.push((rand_hex(), None));
        }
    }
    emit_sessions(&app, &state.sessions);
}

/// OS 파일/폴더 드롭 수신 (Windows 전용). disable_drag_drop_handler 로 Tauri 의 파일 드롭
/// 이벤트가 꺼진 상태의 공식 대체 경로다 (WebView2 WebMessageObjects): front 가 DOM drop 의
/// File 객체를 postMessageWithAdditionalObjects 로 넘기면 여기서 절대 경로·종류를 읽는다.
/// 폴더 드롭 = 새 세션 탭 (창이 하나가 되면서 "이 창의 세션 교체" 근거가 사라졌다 —
/// 폴더 열기 계열과 같은 의미론으로 통일). 파일 드롭은 절대 경로를 DOM 에 돌려준다.
#[cfg(windows)]
fn attach_os_drop(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::Interface;

    let app = app.clone();
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
                // 폴더 드롭 = 새 세션 탭 (첫 폴더만).
                // WHY: 별도 스레드 경유 — 이 콜백은 WebView2 COM 이벤트 안이다. 레지스트리
                //      갱신·emit 만이라 창 조작은 없지만, 이벤트 재진입을 피해 큐로 넘긴다.
                let app2 = app.clone();
                std::thread::spawn(move || {
                    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다
                    match std::path::Path::new(&dir).canonicalize() {
                        Ok(root) => {
                            let state = app2.state::<AppState>();
                            open_workspace(&app2, &state, superlight_common::plain(root), None);
                        }
                        Err(e) => eprintln!("superlight-app: 드롭 경로 확인 실패: {e}"),
                    }
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
/// 새 세션 탭을 추가하고 창을 앞으로 가져온다.
/// "폴더 인자 실행 → 기존 앱에 새 세션" UX — app-installer 의 "CSL로 열기"가 이 경로를 탄다.
fn open_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    // 상대 경로 인자는 두 번째 프로세스의 cwd 기준 — join 은 절대 경로 인자를 그대로 쓴다
    let root = match argv.get(1) {
        Some(arg) => PathBuf::from(&cwd).join(arg),
        None => PathBuf::from(&cwd),
    };
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    // 경로 오류는 로그만 — 두 번째 실행의 잘못된 인자가 기존 앱을 죽이면 안 된다
    match root.canonicalize() {
        Ok(root) => {
            let state = app.state::<AppState>();
            open_workspace(app, &state, superlight_common::plain(root), None);
        }
        Err(e) => eprintln!("superlight-app: 두 번째 실행 경로 확인 실패: {e}"),
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
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

    let sessions: Sessions = Arc::default();

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
        .invoke_handler(tauri::generate_handler![
            open_folder,
            open_folder_path,
            open_empty_session,
            list_sessions,
            close_session,
            move_session
        ])
        .setup(move |app| {
            // 시작은 항상 빈 세션(시작 페이지)이다 — 마지막 워크스페이스 복원은 하지
            // 않는다 (2026-09-02 사용자 결정, ticket app-empty-session). 명시 argv 로 준
            // 폴더("CSL로 열기"·인자 실행)만 그 폴더를 연다. 명시 인자의 경로 오류는 즉시 실패.
            let roots: Vec<PathBuf> = match &cli_root {
                Some(arg) => {
                    vec![arg.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다")]
                }
                None => Vec::new(),
            };

            app.manage(AppState { ws_url, sessions });
            let state = app.state::<AppState>();
            // 초기 세션 등록 — 창을 만들기 전에 끝내야 주입 목록이 완전하다
            {
                let mut list = state.sessions.lock().unwrap();
                for root in roots {
                    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다
                    let root = superlight_common::plain(root);
                    list.push((rand_hex(), Some(root)));
                }
                if list.is_empty() {
                    list.push((rand_hex(), None));
                }
            }

            // 유일한 창 — 세션 탭은 front 가 이 창 안에서 그린다.
            // 주입 스크립트는 프론트 코드 실행 전에 평가된다 (host.ts 가 두 값을 읽는다).
            // WHY: 숨김 기동(visible false → load 후 show)은 쓰지 않는다 — WebView2 가 숨김
            //      상태에서 로딩을 미뤄 오히려 흰 화면이 길어지는 역효과가 실측됐다.
            //      흰 플래시는 창 배경색 + index.html 인라인 배경으로 막는다.
            let boot = serde_json::to_string(&session_infos(&state.sessions))
                .expect("세션 목록 직렬화는 실패할 수 없다");
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
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
                "window.__SUPERLIGHT_WS__ = '{}'; window.__SUPERLIGHT_SESSIONS__ = {boot}; window.__SUPERLIGHT_OPEN_ROOT__ = {open_root};",
                state.ws_url,
                // JSON 문자열로 — 경로 이스케이프 안전 (드라이브 문자엔 특수문자 없지만 관례)
                open_root = serde_json::to_string(&default_open_root())
                    .expect("문자열 직렬화는 실패할 수 없다"),
            ))
            .build()?;
            #[cfg(windows)]
            attach_os_drop(app.handle(), &window);
            #[cfg(not(windows))]
            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 기동 실패");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_entry_uses_display_insertion_index() {
        let mut list = vec![
            ("a".to_string(), Some(PathBuf::from("/a"))),
            ("b".to_string(), Some(PathBuf::from("/b"))),
            ("c".to_string(), Some(PathBuf::from("/c"))),
        ];
        // 앞으로: c 를 맨 앞에
        assert!(move_entry(&mut list, "c", 0));
        assert_eq!(list.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
        // 뒤로: c 를 끝(표시 인덱스 3) 앞에 — 제거 후 보정으로 마지막이 된다
        assert!(move_entry(&mut list, "c", 3));
        assert_eq!(list.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        // 없는 id 는 무동작
        assert!(!move_entry(&mut list, "x", 0));
    }
}
