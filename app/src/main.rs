//! superlite — Tauri 데스크톱 껍데기. front dist 를 자산으로 번들하고,
//! relay(serve)를 loopback 임의 포트로 in-process 기동해 WS endpoint 를 webview 에
//! 주입한다. 와이어 계약·daemon 분리 수명(tmux 식)은 그대로 — Tauri IPC 전환은 비목표.
//!
//! 세션 레지스트리(session id → root, 순서 = 탭 순서)는 여기(native)가 소유한다 — front 는
//! WS 접속 시 session id 만 말하고, root 는 dialog·퀵인풋·드롭·argv 로 native 에 모인
//! 것만 등록된다 (decision/workspace-session-tabs.md).
//!
//! 창은 여럿일 수 있다 (2026-09-03 개정, ticket app-tab-detach-window) — VS Code 창을 여러 개
//! 띄우는 것처럼 사용자가 탭을 창 밖으로 끌어 새 창을 만든다. 프로세스는 하나, 창마다 웹뷰
//! 페이지가 별도라 front 상태·WS 연결은 창 단위로 독립이다. native 는 세션마다 소속 창
//! label 을 함께 들고 list_sessions·sessions-changed 를 창 단위로 보낸다. 어느 탭이
//! 활성인지는 여전히 모른다 (전환은 front 소유).
//!
//! 창은 각각 독립된 하나다 — 세션이 0 개가 된 창은 닫힌다 (close_if_empty — 탭 닫기·분리·
//! 병합 모두 같은 규칙, 2026-09-05 개정). 창의 X 는 그 창의 세션만 정리한다. 마지막 창이
//! 닫히면 앱 종료다 (Tauri 기본 — 창이 모두 닫히면 종료).
//!
//! 탭 이동의 front 상태(에디터 문서·터미널 버퍼 등)는 JSON 핸드오프로 나른다 — 출처 창이
//! 만들고 native 는 내용을 모른 채 대상 창에 전달만 한다 (아직 로드 전인 새 창은 부팅 후
//! take_handoff 로 가져간다).
//!
//! 시작은 항상 빈 세션(시작 페이지)이다 — 마지막 워크스페이스 자동 복원은 하지 않는다
//! (2026-09-02 사용자 결정, ticket app-empty-session). 명시 argv 로 준 폴더만 연다.
//! 대신 state.json(app_data_dir, version 2 — decision/state-persistence.md)에 최근 연 폴더
//! MRU 와 세션 묶음(한 창에 함께 열려 있던 root 집합) 이력을 남기고, 시작 페이지가 그 목록을
//! 보여 사용자가 명시적으로 다시 연다 (ticket start-page-recents).
//!
//! 실행: superlite [워크스페이스루트]  (인자 없으면 빈 세션으로 시작)

// 릴리스 Windows 에서 콘솔 창이 같이 뜨지 않게
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use superlite_backend::SessionRoots;
use tauri::{Emitter, Manager};

/// 세션 레지스트리 — 순서가 곧 탭 순서 (relay 의 SessionRoots::Registry 와 공유).
/// root None = 루트 없는 빈 세션 (시작 페이지 탭, ticket app-empty-session) —
/// 백엔드 연결 없이 front 에만 그려지고, 폴더를 열면 그 자리가 교체된다
type Sessions = Arc<Mutex<Vec<(String, Option<PathBuf>)>>>;

/// 첫 창의 label — 이후 창은 w1, w2 … (new_window_label)
const MAIN_WINDOW: &str = "main";

struct AppState {
    ws_url: String,
    sessions: Sessions,
    /// session id → 소속 창 label. sessions 와 함께 갱신한다 — 락 순서는 sessions → windows
    /// (relay 는 sessions 만 본다 — 창은 relay 의 관심사가 아니다)
    windows: Mutex<HashMap<String, String>>,
    /// 창 label → 도착 대기 핸드오프. 창이 아직 로드 전이거나 이벤트를 놓쳐도 부팅 후
    /// take_handoff 로 가져갈 수 있게 큐로 둔다
    handoffs: Mutex<HashMap<String, Vec<serde_json::Value>>>,
    /// 마지막으로 포커스된 창 — 두 번째 실행(argv)·OS 드롭처럼 창을 지목하지 않는 열기의 대상
    focused: Mutex<String>,
    next_window: AtomicUsize,
    /// 최근 폴더·세션 묶음 이력 — state.json 의 메모리 사본. 락 순서는 sessions → windows → persisted
    persisted: Mutex<Persisted>,
    /// state.json 경로 — app_data_dir 를 못 만들면 None (저장 없이 동작)
    state_file: Option<PathBuf>,
}

/// 최근 연 폴더 MRU 상한 (시작 페이지 왼쪽 컬럼)
const RECENTS_MAX: usize = 10;
/// 세션 묶음 이력 상한 (시작 페이지 오른쪽 컬럼)
const BUNDLES_MAX: usize = 5;

/// 디스크에 남기는 상태 — 스키마·규칙은 docs/decision/state-persistence.md (version 2).
/// recents 는 개별 root 의 MRU(앞이 최신), bundles 는 한 창에 함께 열려 있던 root 집합의
/// 이력(앞이 최신, 원소 순서 = 탭 순서). 빈 세션(root 없음·경로 없는 ssh://host)은 둘 다 제외
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Persisted {
    version: u32,
    #[serde(default)]
    recents: Vec<PathBuf>,
    #[serde(default)]
    bundles: Vec<Vec<PathBuf>>,
}

/// 시작 페이지용 사영 — missing 은 로컬 경로가 지금 디렉토리가 아니다(삭제·이동·드라이브
/// 분리). 원격 ssh:// 는 검사하지 않는다(접속해야 안다). 표시 이름은 front 가 root 로 만든다
#[derive(Clone, serde::Serialize)]
struct RecentEntry {
    root: String,
    missing: bool,
}

#[derive(Clone, serde::Serialize)]
struct RecentsInfo {
    recents: Vec<RecentEntry>,
    bundles: Vec<Vec<RecentEntry>>,
}

fn recent_entry(root: &Path) -> RecentEntry {
    let s = root.to_string_lossy().into_owned();
    let missing = !s.starts_with("ssh://") && !root.is_dir();
    RecentEntry { root: s, missing }
}

/// state.json 읽기 — 파일 없음·파싱 실패·버전 불일치는 빈 상태 (reader 는 version 이 다르면
/// 파일 전체를 무시한다 — 결정 문서 규칙)
fn load_state(path: Option<&Path>) -> Persisted {
    let Some(path) = path else {
        return Persisted { version: 2, ..Default::default() };
    };
    match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Persisted>(&t).ok()) {
        Some(p) if p.version == 2 => p,
        _ => Persisted { version: 2, ..Default::default() },
    }
}

/// state.json 쓰기 — tmp 에 쓴 뒤 rename (torn write 방지). 실패는 로그만 — 이력이 앱을 죽이면 안 된다
fn save_state(path: Option<&Path>, p: &Persisted) {
    let Some(path) = path else { return };
    let json = serde_json::to_string(p).expect("상태 직렬화는 실패할 수 없다");
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, path)) {
        eprintln!("superlite: 상태 저장 실패: {e}");
    }
}

/// MRU 갱신 — 있으면 앞으로 당기고 없으면 앞에 넣는다. 상한 초과는 뒤에서 버린다
fn note_recent(recents: &mut Vec<PathBuf>, root: &Path) {
    recents.retain(|r| r != root);
    recents.insert(0, root.to_path_buf());
    recents.truncate(RECENTS_MAX);
}

fn is_subset(a: &[PathBuf], b: &[PathBuf]) -> bool {
    a.iter().all(|x| b.contains(x))
}

/// 묶음 이력 갱신 — 한 창의 현재 root 집합(탭 순서)을 넣는다. 세션 하나는 묶음이 아니다
/// (왼콽 MRU 몫). WHY: 탭을 하나씩 열고 닫는 과정의 중간 구성이 이력을 채우지 않게 — 새 집합이
///      기존 묶음의 부분집합이면(탭을 닫는 중) 그 묶음을 앞으로 당기기만 하고, 새 집합이 기존
///      묶음을 포함하면(탭을 더 여는 중) 그 부분집합 묶음들을 새 것으로 대체한다. 결과적으로
///      한 작업 흐름의 최대 구성만 남는다
fn note_bundle(bundles: &mut Vec<Vec<PathBuf>>, roots: Vec<PathBuf>) {
    if roots.len() < 2 {
        return;
    }
    if let Some(i) = bundles.iter().position(|b| is_subset(&roots, b)) {
        let b = bundles.remove(i);
        bundles.insert(0, b);
        return;
    }
    bundles.retain(|b| !is_subset(b, &roots));
    bundles.insert(0, roots);
    bundles.truncate(BUNDLES_MAX);
}

/// 폴더 열기 진입점들이 부른다 — MRU 에 올리고 저장. 빈 세션 root 는 무시
fn remember_recent(state: &AppState, root: &Path) {
    if is_empty_root(Some(root)) {
        return;
    }
    let mut p = state.persisted.lock().unwrap();
    note_recent(&mut p.recents, root);
    save_state(state.state_file.as_deref(), &p);
}

/// 레지스트리 변경마다(emit_sessions) 창별 root 집합을 묶음 이력에 반영하고 저장한다.
/// 종료 훅에 의존하지 않으므로 crash 에도 마지막 변경까지 남는다
fn record_bundles(state: &AppState) {
    let groups: Vec<Vec<PathBuf>> = {
        let list = state.sessions.lock().unwrap();
        let windows = state.windows.lock().unwrap();
        let mut labels: Vec<&String> = Vec::new();
        for (id, _) in list.iter() {
            if let Some(w) = windows.get(id) {
                if !labels.contains(&w) {
                    labels.push(w);
                }
            }
        }
        labels
            .into_iter()
            .map(|w| {
                list.iter()
                    .filter(|(id, r)| owns(&windows, id, w) && !is_empty_root(r.as_deref()))
                    .filter_map(|(_, r)| r.clone())
                    .collect()
            })
            .collect()
    };
    let mut p = state.persisted.lock().unwrap();
    for g in groups {
        note_bundle(&mut p.bundles, g);
    }
    save_state(state.state_file.as_deref(), &p);
}

/// 세션 탭 표시용 사영 — 부팅 주입(__SUPERLITE_SESSIONS__)·list_sessions 응답·
/// sessions-changed 이벤트 payload 가 전부 이 모양이다
#[derive(Clone, serde::Serialize)]
struct SessionInfo {
    id: String,
    name: String,
    /// null = 루트 없는 빈 세션 — 표시 라벨·시작 페이지 여부는 front 가 이걸로 판단한다
    root: Option<String>,
}

/// 창 목록 사영 — 탭 우클릭 "Move to Window …" 메뉴용 (title = 그 창의 세션 이름들)
#[derive(Clone, serde::Serialize)]
struct WindowInfo {
    label: String,
    title: String,
}

fn info_of(id: &str, root: Option<&std::path::Path>) -> SessionInfo {
    SessionInfo {
        id: id.to_string(),
        name: root
            .map(|r| {
                r.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| r.to_string_lossy().into_owned())
            })
            .unwrap_or_default(),
        root: root.map(|r| r.to_string_lossy().into_owned()),
    }
}

/// 한 창의 세션 탭 목록 — 레지스트리 순서 중 그 창 소속만
fn infos_for(state: &AppState, label: &str) -> Vec<SessionInfo> {
    let list = state.sessions.lock().unwrap();
    let windows = state.windows.lock().unwrap();
    list.iter()
        .filter(|(id, _)| owns(&windows, id, label))
        .map(|(id, root)| info_of(id, root.as_deref()))
        .collect()
}

/// 레지스트리 변경 방송 — 창마다 자기 몫의 목록을 보낸다. front 세션 관리자가 reconcile 한다
fn emit_sessions(app: &tauri::AppHandle, state: &AppState) {
    // 저장이 방송보다 앞 — front 가 반향을 받고 list_recents 를 부르면 이미 갱신돼 있다
    record_bundles(state);
    for label in app.webview_windows().keys() {
        let infos = infos_for(state, label);
        // 세션 0 개인 창은 닫히는 중(close_if_empty) — 빈 목록을 보내면 front 가 활성 세션
        // 없는 상태를 잠깐 그리므로 보내지 않는다
        if infos.is_empty() {
            continue;
        }
        let _ = app.emit_to(label.as_str(), "sessions-changed", infos);
    }
}

/// 세션 0 개가 된 창은 닫는다 — 탭 닫기·분리·병합 모두 이 규칙을 탄다 (2026-09-05 개정,
/// ticket convenience-features: 종전엔 빈 세션으로 남겼다). 마지막 창이면 Tauri 기본대로 앱이
/// 종료된다 — 묶음 이력(state.json)은 레지스트리 변경마다 이미 저장돼 있어 종료 훅이 필요 없다.
/// 남은 정리(핸드오프·focused)는 Destroyed → drop_window. 호출자가 sessions·windows 락을 잡지
/// 않은 상태여야 한다
fn close_if_empty(app: &tauri::AppHandle, state: &AppState, label: &str) {
    if state.windows.lock().unwrap().values().any(|w| w == label) {
        return;
    }
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
    }
}

/// 창 소속 제거 — 창 X(Destroyed) 가 그 창의 세션들을 레지스트리에서 뺀다 (재-attach 차단 →
/// 데몬 grace 후 회수). 대기 핸드오프도 버린다
fn drop_window(app: &tauri::AppHandle, state: &AppState, label: &str) {
    {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        list.retain(|(id, _)| !owns(&windows, id, label));
        windows.retain(|_, w| w != label);
    }
    state.handoffs.lock().unwrap().remove(label);
    // 죽은 창이 focused 로 남으면 두 번째 실행이 어느 창에도 안 보이는 세션을 만든다 — 살아 있는
    // 창으로 되돌린다 (OS 포커스가 다른 앱으로 가면 Focused(true) 가 안 와 스스로 갱신되지 않는다)
    let mut focused = state.focused.lock().unwrap();
    if *focused == label {
        if let Some(other) = app.webview_windows().keys().find(|l| l.as_str() != label) {
            *focused = other.clone();
        }
    }
}

fn rand_hex() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("난수 생성 실패");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 세션 등록 — id 발급·소속 창 기록·레지스트리 끝에 push. sessions Vec 과 windows 맵을 함께
/// 갱신하는 불변식은 여기(와 open_workspace 의 슬롯 교체)에만 둔다. 두 락을 잡고 부른다
fn push_session(
    list: &mut Vec<(String, Option<PathBuf>)>,
    windows: &mut HashMap<String, String>,
    label: &str,
    root: Option<PathBuf>,
) -> String {
    let id = rand_hex();
    windows.insert(id.clone(), label.to_string());
    list.push((id.clone(), root));
    id
}

/// 세션 id 가 창 label 소속인가
fn owns(windows: &HashMap<String, String>, id: &str, label: &str) -> bool {
    windows.get(id).map(String::as_str) == Some(label)
}

/// 창 소속 엔트리의 레지스트리 인덱스 — 레지스트리 순서대로
fn slots_of(list: &[(String, Option<PathBuf>)], windows: &HashMap<String, String>, label: &str) -> Vec<usize> {
    (0..list.len()).filter(|&i| owns(windows, &list[i].0, label)).collect()
}

fn new_window_label(state: &AppState) -> String {
    format!("w{}", state.next_window.fetch_add(1, Ordering::SeqCst) + 1)
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

/// 창 생성 — 첫 창(setup)과 분리로 생기는 창이 같은 빌더를 쓴다. 주입 목록은 그 창 소속
/// 세션만 (호출 전에 소속 배정이 끝나 있어야 한다). pos 는 논리 좌표 (드롭 지점).
/// WHY: 창을 만드는 커맨드는 반드시 async fn — 동기 커맨드는 메인 스레드에서 돌고, Windows 는
///      그 안의 build() 가 이벤트 루프를 기다리며 교착한다 (Tauri 문서 주의). 실측: 새 창이
///      로드되지 않고 출처 창의 IPC 까지 멈춰 닫기·탭 추가가 전부 먹통이 됐다
fn build_window(
    app: &tauri::AppHandle,
    state: &AppState,
    label: &str,
    pos: Option<(f64, f64)>,
) -> tauri::Result<tauri::WebviewWindow> {
    // 주입 스크립트는 프론트 코드 실행 전에 평가된다 (host.ts 가 값을 읽는다).
    // WHY: 숨김 기동(visible false → load 후 show)은 쓰지 않는다 — WebView2 가 숨김
    //      상태에서 로딩을 미뤄 오히려 흰 화면이 길어지는 역효과가 실측됐다.
    //      흰 플래시는 창 배경색 + index.html 인라인 배경으로 막는다.
    let boot = serde_json::to_string(&infos_for(state, label)).expect("세션 목록 직렬화는 실패할 수 없다");
    let mut b = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title("Superlite")
        .inner_size(1200.0, 800.0)
        // OS 창 헤더 없음 — 창 제어(닫기·최소화·최대화·드래그)는 front TitleBar 가 가진다
        .decorations(false)
        // WHY: Tauri 의 drag-drop 핸들러가 켜져 있으면 WebView2(Windows)가 HTML5 DnD
        //      이벤트를 가로채 내부 DnD(pane 분할·탭·탐색기 드래그)가 DOM 에 도달하지 않는다.
        .disable_drag_drop_handler()
        // 첫 페인트 전 흰 플래시 방지 — 테마 배경(--vscode-editor-background)과 일치
        .background_color(tauri::window::Color(0x1f, 0x1f, 0x1f, 0xff))
        .initialization_script(format!(
            "window.__SUPERLITE_WS__ = '{}'; window.__SUPERLITE_SESSIONS__ = {boot}; window.__SUPERLITE_OPEN_ROOT__ = {open_root}; window.__SUPERLITE_WINDOW__ = {win};",
            state.ws_url,
            // JSON 문자열로 — 경로 이스케이프 안전 (드라이브 문자엔 특수문자 없지만 관례)
            open_root = serde_json::to_string(&default_open_root()).expect("문자열 직렬화는 실패할 수 없다"),
            win = serde_json::to_string(label).expect("문자열 직렬화는 실패할 수 없다"),
        ));
    if let Some((x, y)) = pos {
        b = b.position(x, y);
    }
    let window = b.build()?;
    #[cfg(windows)]
    attach_os_drop(app, &window);
    Ok(window)
}

/// 빈 세션 root 판정 — None(로컬 시작 페이지) 또는 경로 없는 원격 `ssh://host`(원격 시작
/// 페이지 — 그 호스트 탐색만, relay 참조). 둘 다 폴더 열기가 제자리 교체하는 대상이다
fn is_empty_root(root: Option<&std::path::Path>) -> bool {
    match root.and_then(|r| r.to_str()) {
        None => true,
        Some(s) => s.strip_prefix("ssh://").is_some_and(|rest| !rest.contains('/')),
    }
}

/// 새 세션 등록 단일 진입점 — 새 session id 를 발급해 레지스트리에 붙이고(소속 = label)
/// 방송한다. front 는 sessions-changed 를 받아 새 id 로 WS 연결을 열고 그 탭을 활성으로
/// 만든다. dialog·퀵인풋·OS 드롭·두 번째 실행이 공유한다.
///
/// replace 는 빈 세션 탭 id (시작 페이지에서 열기) — 그 엔트리가 아직 root 없는
/// 채로 있으면 push 대신 그 자리를 교체해 탭 위치를 보존한다. id 는 새로 발급 —
/// front reconcile 이 제거+추가로 자연히 따라온다.
///
/// 같은 워크스페이스가 이미 열려 있으면(어느 창이든) 새 탭 대신 그 창을 앞으로 가져오고
/// session-focus 로 그 탭에 포커스만 옮긴다 (VS Code — 다른 창에 열린 폴더는 그 창으로).
/// 워크스페이스 정체성은 canonicalize 된 로컬 경로 또는 ssh://host/path 문자열이다.
/// 에디터·터미널 탭 분리(detach_tabs)는 같은 root 의 두 번째 세션을 의도적으로 만들므로
/// 이 함수를 타지 않는다.
fn open_workspace(app: &tauri::AppHandle, state: &AppState, label: &str, root: PathBuf, replace: Option<&str>) {
    // 이미 열려 있어 포커스만 옮기는 경우도 "최근 연 폴더"다
    remember_recent(state, &root);
    {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        if let Some((id, _)) = list.iter().find(|(_, r)| r.as_ref() == Some(&root)) {
            let id = id.clone();
            let owner = windows.get(&id).cloned().unwrap_or_else(|| label.to_string());
            drop(windows);
            drop(list);
            if let Some(w) = app.get_webview_window(&owner) {
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit_to(owner.as_str(), "session-focus", id);
            return;
        }
        // 교체 대상은 여전히 빈 세션(루트 없음 또는 경로 없는 원격 ssh://host)이어야 하고
        // 이 창 소속이어야 한다 — 경합(그 사이 다른 열기로 교체됨)이면 push
        let slot = replace.and_then(|rid| {
            list.iter().position(|(id, r)| id == rid && is_empty_root(r.as_deref()) && owns(&windows, id, label))
        });
        match slot {
            Some(i) => {
                let session = rand_hex();
                windows.remove(&list[i].0);
                windows.insert(session.clone(), label.to_string());
                list[i] = (session, Some(root));
            }
            None => {
                push_session(&mut list, &mut windows, label, Some(root));
            }
        }
    }
    emit_sessions(app, state);
}

/// 폴더 선택 dialog → 이 창에 새 세션 탭 추가. front 의 '폴더 열기' 커맨드·시작 페이지·
/// + 드롭다운이 invoke 한다. 취소는 무동작. replace 는 빈 세션 탭 id (open_workspace 참조).
#[tauri::command]
async fn open_folder(app: tauri::AppHandle, window: tauri::WebviewWindow, replace: Option<String>) -> Result<(), String> {
    let Some(dir) = rfd::AsyncFileDialog::new().pick_folder().await else {
        return Ok(());
    };
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root = superlite_common::plain(dir.path().canonicalize().map_err(|e| format!("경로 확인 실패: {e}"))?);
    let state = app.state::<AppState>();
    open_workspace(&app, &state, window.label(), root, replace.as_deref());
    Ok(())
}

/// 탐색기 다운로드(ticket explorer-download)의 로컬 저장 위치 dialog — kind=file 은 저장 파일
/// dialog(기본 파일명 name), directory 는 폴더 선택 후 그 안의 name 하위 폴더 (VS Code 원격
/// 탐색기 Download 와 같은 배치). 취소면 None. 전송 자체는 front 가 와이어로 읽어 local_write 로
/// 조각마다 넘긴다 — native 는 원격을 모른다
#[tauri::command]
async fn pick_save_target(kind: String, name: String) -> Option<String> {
    let path = if kind == "directory" {
        rfd::AsyncFileDialog::new().pick_folder().await?.path().join(&name)
    } else {
        rfd::AsyncFileDialog::new().set_file_name(&name).save_file().await?.path().to_path_buf()
    };
    Some(path.to_string_lossy().into_owned())
}

/// 다운로드 조각 쓰기 — base64 data 를 path 에 쓴다 (append 면 끝에 덧붙임, 아니면 새로).
/// 부모 디렉터리는 만들어 준다. 임의 로컬 경로를 받는 근거는 open_folder_path 와 같다 —
/// webview 는 이미 /ws 로 셸을 가지므로 권한 확대가 아니다. async — 메인 스레드에서 MB 단위
/// 쓰기를 하지 않는다
#[tauri::command]
async fn local_write(path: String, data: String, append: bool) -> Result<(), String> {
    use base64::Engine as _;
    use std::io::Write as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .append(append)
        .truncate(!append)
        .open(p)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())
}

/// 다운로드 폴더 생성 (빈 폴더도 트리에 남긴다) — create_dir_all
#[tauri::command]
fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// front 폴더 퀵인풋(Ctrl+O)이 확정한 절대 경로로 이 창에 새 세션 탭 추가. 경로 지목 통로
/// 개방의 근거는 ws docs/decision/web-folder-open.md 개정 — webview 는 이미 /ws 로 셸을
/// 가지므로 권한 확대가 아니고, 검증·세션 등록은 여전히 여기(native)가 소유한다.
#[tauri::command]
fn open_folder_path(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    replace: Option<String>,
) -> Result<(), String> {
    let root = parse_root(&path)?;
    let state = app.state::<AppState>();
    open_workspace(&app, &state, window.label(), root, replace.as_deref());
    Ok(())
}

/// front 가 준 root 문자열 → 레지스트리 root. ssh://host/path 원격은 문자열 그대로 (로컬 검증
/// 불가·불필요 — 해석·접속은 relay 가, 경로 검증은 원격 데몬 attach 가 한다), 로컬은
/// canonicalize·디렉토리 검증
fn parse_root(path: &str) -> Result<PathBuf, String> {
    if path.starts_with("ssh://") {
        return Ok(PathBuf::from(path));
    }
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root = superlite_common::plain(
        std::path::Path::new(path).canonicalize().map_err(|e| format!("경로 확인 실패: {e}"))?,
    );
    if !root.is_dir() {
        return Err(format!("디렉토리가 아니다: {}", root.display()));
    }
    Ok(root)
}

/// 루트 없는 빈 세션 탭 추가 (탭 + 버튼) — 중복 검사 없음, 빈 탭은 여러 개 공존
/// 가능하다 (VS Code 빈 창과 동일).
#[tauri::command]
fn open_empty_session(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    let state = app.state::<AppState>();
    {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        push_session(&mut list, &mut windows, window.label(), None);
    }
    emit_sessions(&app, &state);
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

/// 한 창 안에서의 순서 이동 — 전체 목록에서 그 창 소속만 뽑아 재배열하고 같은 자리들에
/// 되쓴다 (다른 창 엔트리의 위치는 그대로). to 는 그 창의 표시 목록 기준
fn move_in_window(
    list: &mut [(String, Option<PathBuf>)],
    windows: &HashMap<String, String>,
    label: &str,
    id: &str,
    to: usize,
) -> bool {
    let slots = slots_of(list, windows, label);
    let mut sub: Vec<(String, Option<PathBuf>)> = slots.iter().map(|&i| list[i].clone()).collect();
    if !move_entry(&mut sub, id, to) {
        return false;
    }
    for (slot, item) in slots.into_iter().zip(sub) {
        list[slot] = item;
    }
    true
}

/// 탭 드래그 순서 이동 (같은 창 안) — 순서의 단일 출처는 레지스트리이므로 재배열도 native 가
/// 하고, 방송으로 front 가 따라온다
#[tauri::command]
fn move_session(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String, to: usize) {
    let state = app.state::<AppState>();
    if owned_by(&state, &id, window.label()).is_err() {
        return;
    }
    // owned_by 통과 = 이 세션의 소속 창이 곧 호출 창
    let moved = {
        let mut list = state.sessions.lock().unwrap();
        let windows = state.windows.lock().unwrap();
        move_in_window(&mut list, &windows, window.label(), &id, to)
    };
    if moved {
        emit_sessions(&app, &state);
    }
}

/// 이 창의 세션 탭 목록 — front 세션 관리자의 초기 동기화 (이후 갱신은 sessions-changed 이벤트)
#[tauri::command]
fn list_sessions(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Vec<SessionInfo> {
    infos_for(&state, window.label())
}

/// 탭 닫기 = 세션 종료(kill 의미) — 레지스트리에서 제거해 재-attach 를 차단한다.
/// front 가 그 세션의 WS 연결을 끊으면 데몬 detach → 세션 grace 후 터미널 회수
/// (즉시 kill 와이어는 없다 — grace 지연 회수 수용, docs/ticket/app-session-tabs).
/// 그 창의 마지막 탭이면 그 창을 닫는다 (close_if_empty — 보조 창은 그 창만, 마지막 창이면
/// 앱 종료). async: 창을 닫는 커맨드도 build_window 와 같은 이유로 메인 스레드를 피한다
#[tauri::command]
async fn close_session(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String) {
    let state = app.state::<AppState>();
    if owned_by(&state, &id, window.label()).is_err() {
        return;
    }
    let label = {
        let mut list = state.sessions.lock().unwrap();
        let Some(i) = list.iter().position(|(sid, _)| sid == &id) else {
            return;
        };
        list.remove(i);
        state.windows.lock().unwrap().remove(&id)
    };
    emit_sessions(&app, &state);
    if let Some(label) = label {
        close_if_empty(&app, &state, &label);
    }
}

/// 핸드오프 적재 + 대상 창에 도착 알림. 아직 로드 전인 새 창은 이벤트를 못 듣지만 부팅 후
/// take_handoff 가 큐를 비운다 — 두 경로가 같은 큐를 본다
fn deliver_handoff(app: &tauri::AppHandle, state: &AppState, to: &str, handoff: serde_json::Value) {
    state.handoffs.lock().unwrap().entry(to.to_string()).or_default().push(handoff);
    let _ = app.emit_to(to, "handoff-available", ());
}

/// 호출 창이 그 세션의 소유자인지 — 창 밖 드롭과 다른 창 드롭이 겹쳐 두 경로가 같은 세션을
/// 옮기려 할 때, 이미 떠난 세션에 대한 늦은 요청을 구조적으로 거절한다 (dropEffect 전파를
/// 신뢰하지 않는다). 다른 창의 세션을 닫거나 옮기는 것도 막는다
fn owned_by(state: &AppState, id: &str, label: &str) -> Result<(), String> {
    let windows = state.windows.lock().unwrap();
    if owns(&windows, id, label) {
        Ok(())
    } else if windows.contains_key(id) {
        Err("이 창의 세션이 아니다".into())
    } else {
        Err("세션 없음".into())
    }
}

/// 세션 탭을 새 창으로 분리 — 드롭 지점(x, y 논리 좌표)에 창을 만들고 세션의 소속을 옮긴다.
/// 출처 창은 sessions-changed 로 그 세션을 잃고(연결 dispose → 데몬 detach), 새 창이 같은
/// session id 로 attach 해 터미널을 이어받는다 (tmux 식 재-attach). front 상태는 handoff.
/// 출처 창이 비면 새 창이 생긴 뒤 그 창을 닫는다 (창 생성 실패 시 출처 창이 남아 있어야 한다)
#[tauri::command]
async fn detach_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    x: f64,
    y: f64,
    handoff: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let from = window.label().to_string();
    owned_by(&state, &id, &from)?;
    let label = new_window_label(&state);
    {
        let _list = state.sessions.lock().unwrap();
        state.windows.lock().unwrap().insert(id.clone(), label.clone());
    }
    deliver_handoff(&app, &state, &label, handoff);
    if let Err(e) = build_window(&app, &state, &label, Some((x, y))) {
        // 롤백 — 생기지 않은 창 소속으로 세션이 사라지지 않게 되돌린다
        {
            let _list = state.sessions.lock().unwrap();
            state.windows.lock().unwrap().insert(id.clone(), from.clone());
        }
        state.handoffs.lock().unwrap().remove(&label);
        emit_sessions(&app, &state);
        return Err(format!("창 생성 실패: {e}"));
    }
    emit_sessions(&app, &state);
    close_if_empty(&app, &state, &from);
    Ok(())
}

/// 세션 탭을 다른(살아 있는) 창으로 병합 — 소속을 옮기고 그 창의 to_index 위치에 넣는다.
/// 출처 창이 자기 상태를 직렬화해 부른다 (대상 창의 드롭은 forward 로 출처에 요청만 한다).
/// 출처 창이 비면 그 창을 닫는다 (close_if_empty)
#[tauri::command]
async fn move_session_to_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
    to_window: String,
    to_index: usize,
    handoff: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    owned_by(&state, &id, window.label())?;
    if app.get_webview_window(&to_window).is_none() {
        return Err("대상 창 없음".into());
    }
    let from = {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        let Some(from) = windows.get(&id).cloned() else {
            return Err("세션 없음".into());
        };
        if from == to_window {
            return Err("같은 창".into());
        }
        let Some(i) = list.iter().position(|(sid, _)| sid == &id) else {
            return Err("세션 없음".into());
        };
        let item = list.remove(i);
        windows.insert(id.clone(), to_window.clone());
        // 대상 창 소속 엔트리들 사이의 to_index 자리에 — 넘치면 그 창의 마지막 뒤 (없으면 끝)
        let slots = slots_of(&list, &windows, &to_window);
        let at = match slots.get(to_index) {
            Some(&k) => k,
            None => slots.last().map(|&k| k + 1).unwrap_or(list.len()),
        };
        list.insert(at, item);
        from
    };
    deliver_handoff(&app, &state, &to_window, handoff);
    emit_sessions(&app, &state);
    close_if_empty(&app, &state, &from);
    if let Some(w) = app.get_webview_window(&to_window) {
        let _ = w.set_focus();
    }
    Ok(())
}

/// 에디터·터미널 탭을 새 창으로 분리 — 같은 root 의 새 세션(새 id)을 새 창에 만든다
/// (open_workspace 의 "이미 열림 → 포커스" 규칙을 의도적으로 건너뛴다 — 같은 워크스페이스의
/// 두 번째 세션이 목적). 핸드오프에 toSession 을 채워 새 창이 어느 세션에 붙일지 알게 한다.
/// 터미널은 그 새 창이 adoptTerminal(와이어 v10)로 출처 세션에서 가져간다
#[tauri::command]
async fn detach_tabs(
    app: tauri::AppHandle,
    root: String,
    x: f64,
    y: f64,
    mut handoff: serde_json::Value,
) -> Result<(), String> {
    let root = parse_root(&root)?;
    // 웹뷰가 준 임의 JSON — 객체가 아니면 IndexMut 이 패닉해 상태 mutex 를 poison 시킨다
    let Some(obj) = handoff.as_object_mut() else {
        return Err("핸드오프는 객체여야 한다".into());
    };
    let state = app.state::<AppState>();
    let label = new_window_label(&state);
    let session = {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        push_session(&mut list, &mut windows, &label, Some(root))
    };
    obj.insert("toSession".into(), serde_json::Value::String(session.clone()));
    deliver_handoff(&app, &state, &label, handoff);
    if let Err(e) = build_window(&app, &state, &label, Some((x, y))) {
        // 롤백 — 생기지 않은 창의 세션·핸드오프를 지운다 (front 는 실패를 받아 탭을 되돌린다)
        {
            let mut list = state.sessions.lock().unwrap();
            list.retain(|(sid, _)| sid != &session);
            state.windows.lock().unwrap().remove(&session);
        }
        state.handoffs.lock().unwrap().remove(&label);
        return Err(format!("창 생성 실패: {e}"));
    }
    emit_sessions(&app, &state);
    Ok(())
}

/// 창 간 메시지 중계 — 대상 창의 드롭이 출처 창에 이동을 요청하거나(…-move-request), 출처
/// 창이 살아 있는 대상 창에 에디터·터미널 탭 핸드오프를 보낼 때(tabs-handoff) 쓴다.
/// native 는 payload 내용을 모른다
#[tauri::command]
fn forward(app: tauri::AppHandle, to_window: String, event: String, payload: serde_json::Value) -> Result<(), String> {
    // 창 간 중계 전용 이벤트만 — 웹뷰가 native 전용 이벤트(sessions-changed 등)를 위조해 다른
    // 창에 보내는 통로가 되지 않게
    const ALLOWED: [&str; 3] = ["session-move-request", "tabs-move-request", "tabs-handoff"];
    if !ALLOWED.contains(&event.as_str()) {
        return Err("허용되지 않은 이벤트".into());
    }
    if app.get_webview_window(&to_window).is_none() {
        return Err("대상 창 없음".into());
    }
    app.emit_to(to_window.as_str(), event.as_str(), payload).map_err(|e| e.to_string())
}

/// 이 창에 도착해 있는 핸드오프를 모두 가져간다 (큐 비움) — 부팅 직후와 handoff-available
/// 이벤트 때 front 가 부른다
#[tauri::command]
fn take_handoff(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Vec<serde_json::Value> {
    state.handoffs.lock().unwrap().remove(window.label()).unwrap_or_default()
}

/// 창 목록 — 탭 우클릭 "Move to Window …" 메뉴가 자기 외 창을 나열한다. title 은 그 창의
/// 세션 이름들 (빈 세션은 Welcome)
#[tauri::command]
fn list_windows(app: tauri::AppHandle, state: tauri::State<AppState>) -> Vec<WindowInfo> {
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels
        .into_iter()
        .map(|label| {
            let names: Vec<String> = infos_for(&state, &label)
                .into_iter()
                .map(|s| if s.name.is_empty() { "Welcome".to_string() } else { s.name })
                .collect();
            WindowInfo { label, title: names.join(", ") }
        })
        .collect()
}

/// 시작 페이지 목록 — 최근 폴더 MRU 와 세션 묶음 이력. 매 표시마다 부른다 (소실 여부는 그때 검사)
#[tauri::command]
fn list_recents(state: tauri::State<AppState>) -> RecentsInfo {
    let p = state.persisted.lock().unwrap();
    RecentsInfo {
        recents: p.recents.iter().map(|r| recent_entry(r)).collect(),
        bundles: p.bundles.iter().map(|b| b.iter().map(|r| recent_entry(r)).collect()).collect(),
    }
}

/// 최근 폴더 목록에서 지우기 (시작 페이지 ×). 묶음 이력은 건드리지 않는다
#[tauri::command]
fn forget_recent(state: tauri::State<AppState>, root: String) {
    let mut p = state.persisted.lock().unwrap();
    p.recents.retain(|r| r.to_string_lossy() != root);
    save_state(state.state_file.as_deref(), &p);
}

/// 묶음 이력에서 지우기 (시작 페이지 ×) — 같은 집합인 묶음을 지운다
#[tauri::command]
fn forget_bundle(state: tauri::State<AppState>, roots: Vec<String>) {
    let roots: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
    let mut p = state.persisted.lock().unwrap();
    p.bundles.retain(|b| !(b.len() == roots.len() && is_subset(b, &roots)));
    save_state(state.state_file.as_deref(), &p);
}

/// 세션 묶음 열기 (시작 페이지 오른쪽 컬럼) — root 들을 세션 탭으로 한꺼번에 등록한다.
/// 이 창의 탭이 전부 빈 세션이면 그 빈 탭들을 치우고 이 창에 (시작 페이지에서 고르는 명시적
/// 복원), 비어 있지 않은 탭이 있으면 무조건 새 창에 (사용자 결정 — 열려 있는 작업과 섞지 않는다).
/// 이미 어느 창에든 열린 root 는 건너뛴다 (open_workspace 의 중복 금지와 같은 이유). 경로가
/// 소실된 root 도 건너뛰고, 열 것이 하나도 없으면 에러로 알린다.
/// WHY: async — 창을 만드는 커맨드는 메인 스레드에서 돌면 Windows 에서 교착한다 (build_window 참조)
#[tauri::command]
async fn open_bundle(app: tauri::AppHandle, window: tauri::WebviewWindow, roots: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let from = window.label().to_string();
    let parsed: Vec<PathBuf> = roots.iter().filter_map(|r| parse_root(r).ok()).collect();
    if parsed.is_empty() {
        return Err("열 수 있는 폴더가 없다".into());
    }
    for r in &parsed {
        remember_recent(&state, r);
    }
    let (label, added) = {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        let here_nonempty = list
            .iter()
            .any(|(id, r)| owns(&windows, id, &from) && !is_empty_root(r.as_deref()));
        let fresh: Vec<PathBuf> =
            parsed.into_iter().filter(|root| !list.iter().any(|(_, r)| r.as_ref() == Some(root))).collect();
        if fresh.is_empty() {
            return Err("묶음의 폴더가 모두 이미 열려 있다".into());
        }
        let label = if here_nonempty {
            new_window_label(&state)
        } else {
            list.retain(|(id, _)| !owns(&windows, id, &from));
            windows.retain(|_, w| w != &from);
            from.clone()
        };
        let mut added = Vec::new();
        for root in fresh {
            added.push(push_session(&mut list, &mut windows, &label, Some(root)));
        }
        (label, added)
    };
    if label != from {
        if let Err(e) = build_window(&app, &state, &label, None) {
            // 롤백 — 생기지 않은 창 소속으로 세션이 남지 않게
            let mut list = state.sessions.lock().unwrap();
            let mut windows = state.windows.lock().unwrap();
            list.retain(|(id, _)| !added.contains(id));
            for id in &added {
                windows.remove(id);
            }
            return Err(format!("창 생성 실패: {e}"));
        }
    }
    emit_sessions(&app, &state);
    Ok(())
}

/// OS 파일/폴더 드롭 수신 (Windows 전용). disable_drag_drop_handler 로 Tauri 의 파일 드롭
/// 이벤트가 꺼진 상태의 공식 대체 경로다 (WebView2 WebMessageObjects): front 가 DOM drop 의
/// File 객체를 postMessageWithAdditionalObjects 로 넘기면 여기서 절대 경로·종류를 읽는다.
/// 폴더 드롭 = 그 창에 새 세션 탭 (폴더 열기 계열과 같은 의미론). 파일 드롭은 절대 경로를
/// DOM 에 돌려준다. 창마다 등록한다 (build_window).
#[cfg(windows)]
fn attach_os_drop(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::Interface;

    let app = app.clone();
    let label = window.label().to_string();
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
                let label2 = label.clone();
                std::thread::spawn(move || {
                    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다
                    match std::path::Path::new(&dir).canonicalize() {
                        Ok(root) => {
                            let state = app2.state::<AppState>();
                            open_workspace(&app2, &state, &label2, superlite_common::plain(root), None);
                        }
                        Err(e) => eprintln!("superlite: 드롭 경로 확인 실패: {e}"),
                    }
                });
            } else if !files.is_empty() {
                // 파일 드롭 — 루트 상대화·열기 판단은 front 몫이라 절대 경로만 돌려준다
                let json = serde_json::json!({ "superliteOsDrop": { "files": files } }).to_string();
                unsafe { sender.PostWebMessageAsJson(&windows_core::HSTRING::from(json))? };
            }
            Ok(())
        }));
        let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
    });
}

/// 두 번째 실행 수신 (single-instance) — 넘어온 argv·cwd 로 root 를 정해 마지막으로 포커스된
/// 창에 새 세션 탭을 추가하고 그 창을 앞으로 가져온다.
/// "폴더 인자 실행 → 기존 앱에 새 세션" UX — app-installer 의 "Superlite로 열기"가 이 경로를 탄다.
fn open_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    // 상대 경로 인자는 두 번째 프로세스의 cwd 기준 — join 은 절대 경로 인자를 그대로 쓴다
    let root = match argv.get(1) {
        Some(arg) => PathBuf::from(&cwd).join(arg),
        None => PathBuf::from(&cwd),
    };
    let state = app.state::<AppState>();
    let label = state.focused.lock().unwrap().clone();
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    // 경로 오류는 로그만 — 두 번째 실행의 잘못된 인자가 기존 앱을 죽이면 안 된다
    match root.canonicalize() {
        Ok(root) => open_workspace(app, &state, &label, superlite_common::plain(root), None),
        Err(e) => eprintln!("superlite: 두 번째 실행 경로 확인 실패: {e}"),
    }
    if let Some(w) = app.get_webview_window(&label) {
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
                    let listener = tokio::net::TcpListener::from_std(listener).expect("listener 전환 실패");
                    superlite_backend::serve(listener, roots, Some(token), None).await;
                });
        });
    }

    tauri::Builder::default()
        // WHY: single-instance 는 맨 먼저 등록 — 두 번째 실행이 다른 초기화를 밟기 전에
        //      argv·cwd 를 첫 프로세스로 넘기고 즉시 종료해야 한다 (공식 권고).
        .plugin(tauri_plugin_single_instance::init(open_second_instance))
        .invoke_handler(tauri::generate_handler![
            open_folder,
            open_folder_path,
            open_empty_session,
            list_sessions,
            close_session,
            move_session,
            detach_session,
            move_session_to_window,
            detach_tabs,
            forward,
            take_handoff,
            list_windows,
            list_recents,
            forget_recent,
            forget_bundle,
            open_bundle,
            pick_save_target,
            local_write,
            local_mkdir
        ])
        // 창 닫힘(X·close_if_empty) = 그 창의 세션만 정리 (다른 창은 영향 없음). 포커스 추적은 두 번째 실행의 대상 창
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                drop_window(app, &state, window.label());
            }
            tauri::WindowEvent::Focused(true) => {
                let state = window.app_handle().state::<AppState>();
                *state.focused.lock().unwrap() = window.label().to_string();
            }
            _ => {}
        })
        .setup(move |app| {
            // 시작은 항상 빈 세션(시작 페이지)이다 — 마지막 워크스페이스 복원은 하지
            // 않는다 (2026-09-02 사용자 결정, ticket app-empty-session). 명시 argv 로 준
            // 폴더("Superlite로 열기"·인자 실행)만 그 폴더를 연다. 명시 인자의 경로 오류는 즉시 실패.
            let roots: Vec<PathBuf> = match &cli_root {
                Some(arg) => {
                    vec![arg.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다")]
                }
                None => Vec::new(),
            };

            // 상태 파일은 OS 관례 경로(app_data_dir) 아래 state.json — 스키마·쓰기 규칙은
            // docs/decision/state-persistence.md. 디렉토리를 못 만들면 저장 없이 동작한다
            let state_file = match app.path().app_data_dir().and_then(|d| {
                std::fs::create_dir_all(&d)?;
                Ok(d.join("state.json"))
            }) {
                Ok(p) => Some(p),
                Err(e) => {
                    eprintln!("superlite: 상태 디렉토리 준비 실패 — 최근 목록 저장 없이 동작: {e}");
                    None
                }
            };
            let persisted = load_state(state_file.as_deref());
            app.manage(AppState {
                ws_url,
                sessions,
                windows: Mutex::default(),
                handoffs: Mutex::default(),
                focused: Mutex::new(MAIN_WINDOW.to_string()),
                next_window: AtomicUsize::new(0),
                persisted: Mutex::new(persisted),
                state_file,
            });
            let state = app.state::<AppState>();
            // 초기 세션 등록 — 창을 만들기 전에 끝내야 주입 목록이 완전하다
            {
                let mut list = state.sessions.lock().unwrap();
                let mut windows = state.windows.lock().unwrap();
                for root in roots {
                    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다
                    let root = superlite_common::plain(root);
                    remember_recent(&state, &root);
                    push_session(&mut list, &mut windows, MAIN_WINDOW, Some(root));
                }
                if list.is_empty() {
                    push_session(&mut list, &mut windows, MAIN_WINDOW, None);
                }
            }
            build_window(app.handle(), &state, MAIN_WINDOW, None)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 기동 실패");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(ids: &[&str]) -> Vec<(String, Option<PathBuf>)> {
        ids.iter().map(|s| (s.to_string(), Some(PathBuf::from(format!("/{s}"))))).collect()
    }
    fn ids(list: &[(String, Option<PathBuf>)]) -> Vec<&str> {
        list.iter().map(|(s, _)| s.as_str()).collect()
    }

    #[test]
    fn move_entry_uses_display_insertion_index() {
        let mut list = entries(&["a", "b", "c"]);
        // a 를 c 뒤로 — 표시 인덱스 3 (끝) → 제거 후 보정 2
        assert!(move_entry(&mut list, "a", 3));
        assert_eq!(ids(&list), ["b", "c", "a"]);
        // c(현재 1)를 맨 앞으로
        assert!(move_entry(&mut list, "c", 0));
        assert_eq!(ids(&list), ["c", "b", "a"]);
        // 자기 자리 앞뒤(1 또는 2)로 옮기면 그대로
        assert!(move_entry(&mut list, "b", 1));
        assert_eq!(ids(&list), ["c", "b", "a"]);
        assert!(move_entry(&mut list, "b", 2));
        assert_eq!(ids(&list), ["c", "b", "a"]);
        // 없는 id 는 무동작
        assert!(!move_entry(&mut list, "zzz", 0));
        assert_eq!(ids(&list), ["c", "b", "a"]);
    }

    fn paths(v: &[&str]) -> Vec<PathBuf> {
        v.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn note_recent_is_mru_with_cap() {
        let mut r = Vec::new();
        for i in 0..RECENTS_MAX + 2 {
            note_recent(&mut r, Path::new(&format!("/p{i}")));
        }
        assert_eq!(r.len(), RECENTS_MAX);
        assert_eq!(r[0], PathBuf::from(format!("/p{}", RECENTS_MAX + 1)));
        // 재열기는 앞으로 당긴다 (중복 없음)
        note_recent(&mut r, Path::new("/p5"));
        assert_eq!(r[0], PathBuf::from("/p5"));
        assert_eq!(r.iter().filter(|p| **p == PathBuf::from("/p5")).count(), 1);
    }

    #[test]
    fn note_bundle_keeps_maximal_configuration() {
        let mut b = Vec::new();
        note_bundle(&mut b, paths(&["/a"])); // 하나는 묶음이 아니다
        assert!(b.is_empty());
        note_bundle(&mut b, paths(&["/a", "/b"]));
        note_bundle(&mut b, paths(&["/a", "/b", "/c"])); // 확장 — 부분집합을 대체
        assert_eq!(b, vec![paths(&["/a", "/b", "/c"])]);
        note_bundle(&mut b, paths(&["/b", "/c"])); // 축소(닫는 중) — 새 항목 없이 앞으로
        assert_eq!(b, vec![paths(&["/a", "/b", "/c"])]);
        note_bundle(&mut b, paths(&["/x", "/y"]));
        assert_eq!(b[0], paths(&["/x", "/y"]));
        assert_eq!(b.len(), 2);
        // 같은 집합 다른 순서 — 기존을 앞으로 당길 뿐
        note_bundle(&mut b, paths(&["/c", "/a", "/b"]));
        assert_eq!(b[0], paths(&["/a", "/b", "/c"]));
        assert_eq!(b.len(), 2);
        // 마지막 탭까지 닫아 창이 닫히는 경로(1 개 → 0 개) — 이력은 그대로 남는다. 종료 훅 없이
        // 변경마다 저장하므로 마지막 창이 닫혀 앱이 종료돼도 이 상태가 state.json 에 있다
        note_bundle(&mut b, paths(&["/a"]));
        note_bundle(&mut b, Vec::new());
        assert_eq!(b[0], paths(&["/a", "/b", "/c"]));
        assert_eq!(b.len(), 2);
    }

    #[test]
    fn state_roundtrip_and_version_gate() {
        let path = std::env::temp_dir().join(format!("superlite-test-{}.json", rand_hex()));
        let p = Persisted { version: 2, recents: paths(&["/a"]), bundles: vec![paths(&["/a", "/b"])] };
        save_state(Some(&path), &p);
        let back = load_state(Some(&path));
        assert_eq!(back.recents, p.recents);
        assert_eq!(back.bundles, p.bundles);
        std::fs::write(&path, r#"{"version":1,"workspaces":[{"root":"/a"}]}"#).unwrap();
        assert!(load_state(Some(&path)).recents.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    /// 창 안 순서 이동은 다른 창 엔트리의 자리를 건드리지 않는다 — 전체 목록 [a(main) x(w1)
    /// b(main) c(main)] 에서 main 의 a 를 끝으로 보내도 x 는 여전히 두 번째다
    #[test]
    fn move_in_window_keeps_other_windows_slots() {
        let mut list = entries(&["a", "x", "b", "c"]);
        let windows: HashMap<String, String> = [("a", "main"), ("x", "w1"), ("b", "main"), ("c", "main")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert!(move_in_window(&mut list, &windows, "main", "a", 3));
        assert_eq!(ids(&list), ["b", "x", "c", "a"]);
        // 다른 창 소속 id 는 그 창 기준이 아니면 무동작
        assert!(!move_in_window(&mut list, &windows, "main", "x", 0));
        assert_eq!(ids(&list), ["b", "x", "c", "a"]);
    }
}
