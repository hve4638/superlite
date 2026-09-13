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
//! label 을 함께 들고 list_sessions·sessions-changed 를 창 단위로 보낸다.
//!
//! 창은 각각 독립된 하나다 — 세션이 0 개가 된 창은 닫힌다 (close_if_empty — 탭 닫기·분리·
//! 병합 모두 같은 규칙, 2026-09-05 개정). 창의 X 는 그 창의 세션만 정리한다. 마지막 창이
//! 닫히면 앱 종료다 (Tauri 기본 — 창이 모두 닫히면 종료).
//!
//! 메인 창과 서브 창 (2026-09-08 개정, decision/workspace-session-tabs.md): 첫 창과 세션 탭
//! 분리로 생긴 창은 메인 창(대등·독립). 에디터·터미널 탭 분리(detach_tabs)로 생긴 창은 서브 창 —
//! 소속 메인(groups.subs)이 있고, 세션 탭 스트립은 메인 것을 비춘다 (infos_for 가 메인 목록을
//! 준다). 활성 세션은 메인·서브가 공유하며 native 가 메인 창 단위로 들고 방송한다
//! (set_active_session → session-active). 서브 창의 세션은 전부 미러 — 같은 root 의 별도 세션
//! (groups.mirrors: 미러 id → 원본 id, 데몬은 같은 id 의 두 연결을 허용하지 않아 별도 id 가
//! 필요하다). 미러는 탭이 처음 오는 세션에만 만든다 (ensure_mirror). 메인 창이 닫히면 서브 창도
//! 닫히고(drop_window), 서브 창의 X·탭 0 종료는 front 가 결정한다 (탭을 메인에 되돌린 뒤 destroy).
//!
//! 탭 이동의 front 상태(에디터 문서·터미널 버퍼 등)는 JSON 핸드오프로 나른다 — 출처 창이
//! 만들고 native 는 내용을 모른 채 대상 창에 전달만 한다 (아직 로드 전인 새 창은 부팅 후
//! take_handoff 로 가져간다).
//!
//! 시작은 빈 세션(시작 페이지)이다 — 정상 종료(창 X) 뒤 마지막 워크스페이스 자동 복원은 하지 않는다
//! (2026-09-02 사용자 결정, ticket app-empty-session). 명시 argv 로 준 폴더만 연다. 예외는 비정상 종료
//! (컴퓨터 꺼짐·강제 종료·업데이트 설치기의 종료) — 열려 있던 메인 창 목록(persisted.open, sync_open 이
//! 상시 갱신하고 창 X 가 자기 항목을 지운다)이 시작 때 남아 있으면 사용자 설정 restoreWindows(none·one·all,
//! 기본 one = 마지막 포커스 창 하나, settings.json — ticket user-settings)대로 그 창들을 세션 탭째 되살린다.
//! argv 폴더가 있으면 그것만 열고 복원은 건너뛴다 (사용자 결정 2026-09-12).
//! 그 밖에 state.json(app_data_dir, version 2 — decision/state-persistence.md)에 최근 연 폴더
//! MRU 와 사용자가 고정한 그룹(pinned, ticket start-page-redesign — 종전 세션 묶음 이력을 대체)을
//! 남기고, 시작 페이지가 그 목록을 보여 사용자가 명시적으로 다시 연다 (ticket start-page-recents). 같은 파일에 웹뷰 줌
//! 레벨(zoom)도 둔다 — 배율은 창마다 따로고(zooms, set_zoom — 2026-09-09 사용자 결정, ticket zoom-per-window)
//! 저장값은 마지막으로 조절한 레벨로 부모 없는 창(첫 창·두 번째 실행 창)의 시작값이다.
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

/// 메인 창과 서브 창의 관계 (2026-09-08 개정). 어느 맵에도 없는 창은 메인 창이다
#[derive(Default)]
struct Groups {
    /// 서브 창 label → 소속 메인 창 label
    subs: HashMap<String, String>,
    /// 미러 세션 id → 원본(메인 창) 세션 id. 서브 창 소속 세션은 전부 미러다.
    /// 불변식: 레지스트리(sessions Vec)에서 미러는 항상 원본보다 뒤에 온다 — 미러는 끝에 push 되고
    /// (detach_tabs·ensure_mirror), 원본이 옮겨지거나 사라질 때 drop_mirrors_of 가 먼저 미러를 지운다.
    /// open_workspace 의 중복 열기 판정과 primary_root 의 "그 root 의 첫 세션" 이 이 순서에 기댄다
    mirrors: HashMap<String, String>,
    /// 메인 창 label → 활성 세션 id (메인·서브 공유). front 가 set_active_session 으로 알린다
    active: HashMap<String, String>,
}

impl Groups {
    /// 창의 메인 창 — 서브면 소속 메인, 아니면 자신
    fn main_of<'a>(&'a self, label: &'a str) -> &'a str {
        self.subs.get(label).map(String::as_str).unwrap_or(label)
    }
    fn subs_of(&self, main: &str) -> Vec<String> {
        self.subs.iter().filter(|(_, m)| m.as_str() == main).map(|(s, _)| s.clone()).collect()
    }
    /// 서브 창 label 의, 원본 세션 origin 에 대한 미러 id
    fn mirror_in(&self, windows: &HashMap<String, String>, label: &str, origin: &str) -> Option<String> {
        self.mirrors
            .iter()
            .find(|(m, o)| o.as_str() == origin && owns(windows, m, label))
            .map(|(m, _)| m.clone())
    }
}

/// 세션의 미러들을 레지스트리에서 지운다 — 세션이 메인 창을 떠날 때(닫기·분리·병합). 서브 창의
/// 탭은 front 가 그 전에 되돌려 받는다 (session-recall). 세 락을 잡고 부른다
fn drop_mirrors_of(
    list: &mut Vec<(String, Option<PathBuf>)>,
    windows: &mut HashMap<String, String>,
    groups: &mut Groups,
    origin: &str,
) {
    let gone: Vec<String> = groups.mirrors.iter().filter(|(_, o)| o.as_str() == origin).map(|(m, _)| m.clone()).collect();
    for m in &gone {
        groups.mirrors.remove(m);
        windows.remove(m);
    }
    list.retain(|(id, _)| !gone.contains(id));
}

/// 락 순서 규약 (교착 방지 — 중첩해 잡을 때는 반드시 이 순서로):
///   sessions → windows → groups → persisted
/// handoffs·zooms 는 다른 락을 모두 놓은 뒤 단독으로만 잡는다 (다른 락 안에서 잡지 않는다).
/// 중첩이 실제로 성립하는 곳: sessions→windows→groups 는 세션 등록·제거 블록(drop_mirrors_of 호출부),
/// sessions→windows→persisted 는 setup 의 초기 등록(remember_recent) 한 곳. `if` 조건식 안의 임시
/// guard 는 조건 평가가 끝나면 풀리므로 겹치지 않지만, 바인딩으로 바꾸면 이 규약을 따라야 한다
struct AppState {
    ws_url: String,
    sessions: Sessions,
    /// session id → 소속 창 label. sessions 와 함께 갱신한다
    /// (relay 는 sessions 만 본다 — 창은 relay 의 관심사가 아니다)
    windows: Mutex<HashMap<String, String>>,
    /// 창 label → 도착 대기 핸드오프. 창이 아직 로드 전이거나 이벤트를 놓쳐도 부팅 후
    /// take_handoff 로 가져갈 수 있게 큐로 둔다
    handoffs: Mutex<HashMap<String, Vec<serde_json::Value>>>,
    /// 메인·서브 창 묶음
    groups: Mutex<Groups>,
    /// 창 label → 웹뷰 줌 레벨 (창마다 따로, ticket zoom-per-window). 창 생성 때 넣고(build_window) 파괴 때 지운다
    zooms: Mutex<HashMap<String, i32>>,
    /// 메인 창 포커스 순서(앞이 최근) — persisted.open 의 정렬 기준 (restoreWindows one 이 고르는 창). 단독 락
    focus: Mutex<Vec<String>>,
    next_window: AtomicUsize,
    /// 최근 폴더·고정 그룹 — state.json 의 메모리 사본
    persisted: Mutex<Persisted>,
    /// state.json 경로 — app_data_dir 를 못 만들면 None (저장 없이 동작)
    state_file: Option<PathBuf>,
}

/// 최근 연 폴더 MRU 상한 (시작 페이지 왼쪽 컬럼)
const RECENTS_MAX: usize = 64;

/// 줌 레벨 상한 — 배율 1.2^8 ≈ 4.3 / 1.2^-8 ≈ 0.23 (VS Code 는 무제한이지만 실수로 끝까지 가면 되돌리기 어렵다)
const ZOOM_MAX: i32 = 8;

/// 디스크에 남기는 상태 — 스키마·규칙은 docs/decision/state-persistence.md (version 2).
/// recents 는 개별 root 의 MRU(앞이 최신) — 고정된 root 는 들어오지 않는다. pinned 는 사용자가
/// 시작 페이지에 고정한 그룹 목록(순서 = 표시 순서, 그룹의 roots 순서 = 열 때 탭 순서;
/// 2026-09-07 start-page-redesign — 종전 bundles(세션 묶음 이력)를 대체, 옛 파일의 bundles 는
/// 무시). 빈 세션(root 없음·경로 없는 ssh://host)은 제외. zoom 은 마지막으로 조절한 웹뷰 줌 레벨(0 = 100%,
/// 배율 1.2^zoom) — 창별 레벨(zooms)의 시작값으로만 쓰인다. 필드 추가는 version 을 올리지 않는다 (없으면
/// 기본값, reader 는 모르는 필드를 무시)
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Persisted {
    version: u32,
    #[serde(default)]
    recents: Vec<PathBuf>,
    #[serde(default)]
    pinned: Vec<PinGroup>,
    #[serde(default)]
    zoom: i32,
    /// 워크스페이스별 상태 (ticket workspace-state-restore) — root 마다 front 가 만든 스냅샷 JSON(탭·배치·
    /// 펼침·커서·터미널 자리, 내용은 native 가 해석하지 않는다). 최근 저장 순(앞이 최신), 최대 WORKSPACES_MAX
    #[serde(default)]
    workspaces: Vec<WorkspaceEntry>,
    /// 지금 열려 있는 메인 창 목록 (ticket user-settings restoreWindows) — 포커스 최근 순(앞이 마지막 포커스), 창마다
    /// 세션 탭 root 순서. sync_open 이 레지스트리·포커스 변경마다 갱신하고 창 X(drop_window)가 자기 항목을 지우므로,
    /// 시작 때 비어 있지 않으면 지난 실행이 비정상 종료된 것 — 설정 restoreWindows 대로 되살린다
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    open: Vec<OpenWindow>,
}

/// 열려 있는 메인 창 하나 — 세션 탭 root 들(빈 세션 제외, 서브 창 미러 제외)과 활성 탭 인덱스
#[derive(Clone, Default, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
struct OpenWindow {
    roots: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active: Option<usize>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct WorkspaceEntry {
    root: PathBuf,
    state: serde_json::Value,
    /// 보조창(서브 창) 몫 — 창마다 하나, 서브 창이 set_workspace_sub_state 로 보낸다. 메인이 복원할 때
    /// (get_workspace_state) 넘기면서 비운다 — 되살아난 서브 창이 새 label 로 다시 저장한다
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subs: Vec<SubWorkspaceEntry>,
}

/// 서브 창 하나의 저장 — front 스냅샷 + 창 위치·크기(논리 px)·웹뷰 줌 레벨(저장 시점에 native 가 읽는다)
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SubWorkspaceEntry {
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    zoom: i32,
    state: serde_json::Value,
}

/// 기억하는 워크스페이스 수 상한 — 넘으면 가장 오래 전에 저장한 것부터 버린다
const WORKSPACES_MAX: usize = 64;

/// 고정 그룹 — root 하나여도 그룹이다. alias 는 사용자가 붙인 제목(없으면 front 가 첫 멤버 이름으로)
#[derive(Clone, Default, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
struct PinGroup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    roots: Vec<PathBuf>,
}

fn is_pinned(pinned: &[PinGroup], root: &Path) -> bool {
    pinned.iter().any(|g| g.roots.iter().any(|r| r == root))
}

/// 줌 레벨 전이 — in +1, out -1, reset 0, 그 외 무변경. ±ZOOM_MAX 로 클램프
fn step_zoom(level: i32, action: &str) -> i32 {
    match action {
        "in" => (level + 1).min(ZOOM_MAX),
        "out" => (level - 1).max(-ZOOM_MAX),
        "reset" => 0,
        _ => level,
    }
}

/// 레벨 → 배율. VS Code window.zoomLevel 과 같은 밑(1.2)
fn zoom_factor(level: i32) -> f64 {
    1.2f64.powi(level)
}

/// 시작 페이지용 사영 — missing 은 로컬 경로가 지금 디렉토리가 아니다(삭제·이동·드라이브
/// 분리). 원격 ssh:// 는 검사하지 않는다(접속해야 안다). 표시 이름은 front 가 root 로 만든다
#[derive(Clone, serde::Serialize)]
struct RecentEntry {
    root: String,
    missing: bool,
}

#[derive(Clone, serde::Serialize)]
struct PinGroupInfo {
    alias: Option<String>,
    roots: Vec<RecentEntry>,
}

#[derive(Clone, serde::Serialize)]
struct RecentsInfo {
    recents: Vec<RecentEntry>,
    pinned: Vec<PinGroupInfo>,
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

/// 열려 있는 메인 창 목록을 persisted.open 에 (ticket user-settings restoreWindows) — 레지스트리 변경(emit_sessions)·
/// 창 소멸(drop_window)·포커스 이동 때 부른다. 바뀐 경우만 저장. 락을 잡지 않은 상태에서 부른다
fn sync_open(state: &AppState) {
    let focus = state.focus.lock().unwrap().clone();
    let open: Vec<OpenWindow> = {
        let list = state.sessions.lock().unwrap();
        let windows = state.windows.lock().unwrap();
        let groups = state.groups.lock().unwrap();
        let mut mains: Vec<String> = windows.values().filter(|l| !groups.subs.contains_key(*l)).cloned().collect();
        mains.sort();
        mains.dedup();
        mains.sort_by_key(|l| focus.iter().position(|f| f == l).unwrap_or(usize::MAX));
        mains
            .iter()
            .map(|label| {
                let roots: Vec<PathBuf> = list
                    .iter()
                    .filter(|(id, _)| owns(&windows, id, label))
                    .filter_map(|(_, r)| r.clone())
                    .filter(|r| !is_empty_root(Some(r)))
                    .collect();
                let active = groups
                    .active
                    .get(label)
                    .and_then(|aid| list.iter().find(|(id, _)| id == aid))
                    .and_then(|(_, r)| r.as_ref())
                    .and_then(|ar| roots.iter().position(|r| r == ar));
                OpenWindow { roots, active }
            })
            .collect()
    };
    let mut p = state.persisted.lock().unwrap();
    if p.open != open {
        p.open = open;
        save_state(state.state_file.as_deref(), &p);
    }
}

/// 사용자 설정 restoreWindows — 프론트 model/settings 스키마의 키를 native 가 시작 때 settings.json
/// (superlite_common::config_dir, relay /settings 와 같은 파일)에서 직접 읽는다. 없거나 못 읽으면 "one"
fn restore_mode() -> String {
    superlite_common::config_dir()
        .and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("restoreWindows")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "one".to_string())
}

/// 시작 때 되살릴 창들 — none 은 없음, one 은 마지막 포커스 창, all 은 전부. 사라진 로컬 root 는 뺀다
/// (원격 ssh:// 는 접속해야 알므로 그대로), root 가 하나도 안 남은 창은 뺀다
fn restorable(open: &[OpenWindow], mode: &str) -> Vec<OpenWindow> {
    let n = match mode {
        "all" => usize::MAX,
        "one" => 1,
        _ => 0,
    };
    open.iter()
        .take(n)
        .filter_map(|w| {
            let active_root = w.active.and_then(|i| w.roots.get(i)).cloned();
            let roots: Vec<PathBuf> =
                w.roots.iter().filter(|r| r.to_string_lossy().starts_with("ssh://") || r.is_dir()).cloned().collect();
            let active = active_root.and_then(|a| roots.iter().position(|r| *r == a));
            (!roots.is_empty()).then_some(OpenWindow { roots, active })
        })
        .collect()
}

/// MRU 갱신 — 있으면 앞으로 당기고 없으면 앞에 넣는다. 상한 초과는 뒤에서 버린다
fn note_recent(recents: &mut Vec<PathBuf>, root: &Path) {
    recents.retain(|r| r != root);
    recents.insert(0, root.to_path_buf());
    recents.truncate(RECENTS_MAX);
}

/// 폴더 열기 진입점들이 부른다 — MRU 에 올리고 저장. 빈 세션 root 와 고정된 root 는 무시
/// (고정은 사용자가 정한 목록이라 MRU 와 섞지 않는다 — 2026-09-07 사용자 결정)
fn remember_recent(state: &AppState, root: &Path) {
    if is_empty_root(Some(root)) {
        return;
    }
    let mut p = state.persisted.lock().unwrap();
    if is_pinned(&p.pinned, root) {
        return;
    }
    note_recent(&mut p.recents, root);
    save_state(state.state_file.as_deref(), &p);
}

/// 세션 탭 표시용 사영 — boot_info 의 sessions·list_sessions 응답·
/// sessions-changed 이벤트 payload 가 전부 이 모양이다
#[derive(Clone, serde::Serialize)]
struct SessionInfo {
    id: String,
    name: String,
    /// null = 루트 없는 빈 세션 — 표시 라벨·시작 페이지 여부는 front 가 이걸로 판단한다
    root: Option<String>,
    /// 서브 창 목록 전용 — 이 창에 있는 그 세션의 미러 id (없으면 미러 없음 = 자리표시 컨텍스트)
    #[serde(skip_serializing_if = "Option::is_none")]
    mirror: Option<String>,
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
        mirror: None,
    }
}

/// 한 창의 세션 탭 목록 — 레지스트리 순서 중 메인 창 소속만. 서브 창은 소속 메인의 목록에
/// 이 창의 미러 id 를 얹어 준다 (스트립은 메인을 비추고 연결은 미러로)
fn infos_for(state: &AppState, label: &str) -> Vec<SessionInfo> {
    let list = state.sessions.lock().unwrap();
    let windows = state.windows.lock().unwrap();
    let groups = state.groups.lock().unwrap();
    let main = groups.main_of(label);
    let is_sub = main != label;
    list.iter()
        .filter(|(id, _)| owns(&windows, id, main))
        .map(|(id, root)| {
            let mut info = info_of(id, root.as_deref());
            if is_sub {
                info.mirror = groups.mirror_in(&windows, label, id);
            }
            info
        })
        .collect()
}

/// 레지스트리 변경 방송 — 창마다 자기 몫의 목록을 보낸다. front 세션 관리자가 reconcile 한다.
/// 열린 창 목록(persisted.open)도 여기서 따라 적는다 — 레지스트리 변경 지점이 전부 이 방송을 지난다
fn emit_sessions(app: &tauri::AppHandle, state: &AppState) {
    sync_open(state);
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
/// 종료된다 — state.json 은 변경마다 즉시 저장돼 있어 종료 훅이 필요 없다.
/// 남은 정리(핸드오프)는 Destroyed → drop_window. 호출자가 sessions·windows 락을 잡지
/// 않은 상태여야 한다
fn close_if_empty(app: &tauri::AppHandle, state: &AppState, label: &str) {
    // 아래 두 `if` 는 groups → windows 순으로 보이지만 조건식 임시 guard 라 겹치지 않는다.
    // 바인딩으로 바꾸려면 규약(windows → groups)대로 잡아야 한다 — set_active_session 과 교착한다
    // 서브 창의 수명은 front 가 정한다 (미러 0 개여도 닫지 않는다)
    if state.groups.lock().unwrap().subs.contains_key(label) {
        return;
    }
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
    let subs = {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        let mut groups = state.groups.lock().unwrap();
        list.retain(|(id, _)| !owns(&windows, id, label));
        windows.retain(|_, w| w != label);
        groups.mirrors.retain(|m, _| windows.contains_key(m));
        groups.subs.remove(label);
        groups.active.remove(label);
        groups.subs_of(label)
    };
    // 메인 창이 닫히면 서브 창도 함께 — destroy 로 (close 는 서브 front 의 onCloseRequested 가
    // 막고 탭을 사라진 메인에 되돌리려 한다)
    for sub in subs {
        if let Some(w) = app.get_webview_window(&sub) {
            let _ = w.destroy();
        }
    }
    state.handoffs.lock().unwrap().remove(label);
    state.zooms.lock().unwrap().remove(label);
    state.focus.lock().unwrap().retain(|l| l != label);
    // 창 X = 정상 종료 — 목록에서 빠져야 다음 시작이 이 창을 되살리지 않는다 (마지막 창이면 빈 목록으로 저장된 뒤 앱 종료)
    sync_open(state);
}

/// 창의 웹뷰 줌 레벨 — 모르는 창(부팅 전·웹)은 저장된 시작값
fn zoom_of(state: &AppState, label: &str) -> i32 {
    let known = state.zooms.lock().unwrap().get(label).copied();
    known.unwrap_or_else(|| state.persisted.lock().unwrap().zoom)
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

/// 창의 메인 창 label — "이 창에 세션 추가" 를 뜻하는 진입로(폴더 열기·+·OS 드롭·그룹 열기)가
/// 서브 창에서 불리면 소속 메인에 추가된다. 락을 잡지 않은 상태에서 부른다
fn main_label(state: &AppState, label: &str) -> String {
    state.groups.lock().unwrap().main_of(label).to_string()
}

/// 메인·서브 창 묶음 전체에 방송 (session-active)
fn emit_group(app: &tauri::AppHandle, state: &AppState, main: &str, event: &str, payload: impl serde::Serialize + Clone) {
    let subs = state.groups.lock().unwrap().subs_of(main);
    let _ = app.emit_to(main, event, payload.clone());
    for sub in subs {
        let _ = app.emit_to(sub.as_str(), event, payload.clone());
    }
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
/// 머신인 native 가 정한다. Windows 는 시스템 드라이브 루트(예: `C:/`), 그 외는 `/`. boot_info 로 전달
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

/// 창 생성 — 첫 창(setup)과 분리로 생기는 창이 같은 빌더를 쓴다. 부팅 정보는 front 가 boot_info 로
/// 묻는다 — 호출 전에 소속 배정이 끝나 있어야 한다. pos 는 논리 좌표 (드롭 지점). zoom 은 이 창의
/// 웹뷰 줌 레벨 — 분리 창은 출처 창 값, 부모 없는 창은 저장된 마지막 값 (ticket zoom-per-window).
/// WHY: 창을 만드는 커맨드는 반드시 async fn — 동기 커맨드는 메인 스레드에서 돌고, Windows 는
///      그 안의 build() 가 이벤트 루프를 기다리며 교착한다 (Tauri 문서 주의). 실측: 새 창이
///      로드되지 않고 출처 창의 IPC 까지 멈춰 닫기·탭 추가가 전부 먹통이 됐다
fn build_window(
    app: &tauri::AppHandle,
    state: &AppState,
    label: &str,
    pos: Option<(f64, f64)>,
    size: Option<(f64, f64)>,
    zoom: i32,
) -> tauri::Result<tauri::WebviewWindow> {
    // WHY: 숨김 기동(visible false → load 후 show)은 쓰지 않는다 — WebView2 가 숨김
    //      상태에서 로딩을 미뤄 오히려 흰 화면이 길어지는 역효과가 실측됐다.
    //      흰 플래시는 창 배경색 + index.html 인라인 배경으로 막는다.
    // WHY: 부팅 정보(relay 주소·세션 목록·창 label 등)는 initialization_script 로 전역에 심지
    //      않는다 — Windows(wry/WebView2)는 초기화 스크립트를 iframe 서브프레임에도 주입해 URL 탭에
    //      연 원격 페이지(자기 웹 프론트 포함)까지 앱 부팅 전역을 보게 됐다 (ticket
    //      app-boot-globals-iframe-leak). front 가 boot_info 커맨드로 묻는다 — Tauri IPC 는 앱 오리진에서만
    //      허용되므로 서브프레임은 자연히 웹 모드다
    let mut b = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        // 창 제목은 productName — 채널 overlay(tauri.dev.conf.json)가 "Superlite-Dev" 로 가른다
        .title(app.package_info().name.clone())
        // 크기는 기본 1200×800 — 보조창 복원(detach_tabs size)만 저장된 크기로
        .inner_size(size.map_or(1200.0, |s| s.0), size.map_or(800.0, |s| s.1))
        // OS 창 헤더 없음 — 창 제어(닫기·최소화·최대화·드래그)는 front TitleBar 가 가진다
        .decorations(false)
        // WHY: Tauri 의 drag-drop 핸들러가 켜져 있으면 WebView2(Windows)가 HTML5 DnD
        //      이벤트를 가로채 내부 DnD(pane 분할·탭·탐색기 드래그)가 DOM 에 도달하지 않는다.
        .disable_drag_drop_handler()
        // WHY: WebView2 152 부터 Windows 의 "입력하는 동안 포인터 숨기기" 를 Chromium 기능
        //      (HideCursorWhileTyping)으로 구현하는데, 숨긴 포인터가 마우스를 움직여도 안 돌아오는
        //      회귀가 있다 (ticket editor-cursor-vanish, WebView2Feedback #5687). 기능을 끈다 —
        //      앞의 셋은 wry 기본값이라 이 호출로 덮이므로 그대로 옮긴다. 다른 OS 는 무시
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HideCursorWhileTyping")
        // 첫 페인트 전 흰 플래시 방지 — 테마 배경(--vscode-editor-background)과 일치
        .background_color(tauri::window::Color(0x1f, 0x1f, 0x1f, 0xff));
    if let Some((x, y)) = pos {
        b = b.position(x, y);
    }
    let window = b.build()?;
    // 창별 배율 — 물려받은 레벨로 뜬다 (0 이면 기본 배율이라 호출 불요)
    state.zooms.lock().unwrap().insert(label.to_string(), zoom);
    if zoom != 0 {
        if let Err(e) = window.set_zoom(zoom_factor(zoom)) {
            eprintln!("superlite: 줌 적용 실패 ({label}): {e}");
        }
    }
    #[cfg(windows)]
    attach_os_drop(app, &window);
    #[cfg(windows)]
    win_icon::apply(&window);
    #[cfg(windows)]
    disable_browser_accelerator_keys(&window);
    #[cfg(windows)]
    win_ime::detach_host_windows(&window);
    Ok(window)
}

/// 브라우저 가속키 끄기 (Windows 전용, ticket url-tab-slow-first-load 곁가지). WebView2 는 Ctrl+P·Ctrl+Shift+P(인쇄)·
/// F5·Ctrl+F 같은 브라우저 기능 키를 기본으로 처리한다. 앱 셸에서는 front 가 keydown 을 잡아 preventDefault 하지만,
/// URL 탭의 iframe 이 포커스를 가지면 키가 cross-origin 프레임으로 가서 앱이 볼 수 없고 Ctrl+Shift+P 가 팔레트 대신
/// 인쇄 대화상자를 띄운다 (웹 데모 실측 2026-09-12). 잃는 것은 F5 새로고침(팔레트 'Developer: Reload Window' 가
/// 있다)·F12 정도 (릴리스 빌드는 devtools 없음). 이동·편집 키(Ctrl+C/V/Z, Home/End 등)는 영향 없다.
/// WHY: wry 의 with_browser_accelerator_keys 를 tauri 2.11 빌더가 노출하지 않아 생성 뒤 Settings3 로 끈다.
///      실패는 로그만 — 92.0.902.0 이전 런타임은 인터페이스가 없어 종전 동작이 남는다
#[cfg(windows)]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let _ = window.with_webview(|webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let Ok(settings) = (unsafe { core.Settings() }) else {
            return;
        };
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };
        if let Err(e) = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) } {
            eprintln!("superlite: 브라우저 가속키 해제 실패: {e}");
        }
    });
}

/// 창 아이콘 (Windows 전용, ticket app-icon-quality). tao 는 창 아이콘을 ICO 첫 항목(16px)의 RGBA 로
/// CreateIcon 해 WM_SETICON 의 ICON_SMALL 에만 넣는다 — ICON_BIG 이 비어 작업 표시줄·Alt+Tab 이 16px 를
/// 늘려 그렸다(흐림·저해상도). 여기서 exe 리소스 ICO(tauri-build 가 id 32512 로 박는다 — bundle.icon 이 있는
/// overlay(tauri.bundle·tauri.dev, 즉 build.sh)로 빌드할 때만. 기본 tauri.conf.json 은 icon [] 이라 맨 cargo
/// 빌드에는 리소스가 없어 아래 로드가 실패 로그를 남긴다)를 창 DPI 의
/// 작은·큰 크기로 LoadImageW 해 둘 다 덮어쓴다. 리소스에서 온 HICON 은 셸이 원본 모듈·리소스를 알아
/// 필요한 크기를 다시 꺼내므로(GetIconInfoEx) 배율이 달라도 ICO 의 맞는 항목이 쓰인다.
/// WHY: 창 생성 시점 DPI 로 한 번만 — 모니터 간 DPI 이동(WM_DPICHANGED)은 다루지 않는다 (ponytail).
///      실패는 로그만 — tao 가 넣은 작은 아이콘이 남는다
#[cfg(windows)]
mod win_icon {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_SHARED, SM_CXICON, SM_CXSMICON, WM_SETICON,
    };

    /// tauri-build(tauri-winres) 가 창 아이콘 ICO 를 넣는 리소스 id — IDI_APPLICATION 과 같은 32512
    const ICON_RESOURCE: usize = 32512;

    pub fn apply(window: &tauri::WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let label = window.label();
        unsafe {
            let Ok(module) = GetModuleHandleW(PCWSTR::null()) else { return };
            let dpi = GetDpiForWindow(hwnd);
            for (kind, metric) in [(ICON_SMALL, SM_CXSMICON), (ICON_BIG, SM_CXICON)] {
                let px = GetSystemMetricsForDpi(metric, dpi);
                // LR_SHARED — 같은 리소스·크기는 시스템이 하나를 공유하고 해제도 맡는다
                match LoadImageW(Some(module.into()), PCWSTR(ICON_RESOURCE as *const u16), IMAGE_ICON, px, px, LR_SHARED) {
                    Ok(h) => {
                        SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(h.0 as isize)));
                    }
                    Err(e) => eprintln!("superlite: 창 아이콘 로드 실패 ({label}, {px}px): {e}"),
                }
            }
        }
    }
}

/// 웹뷰 줌 — action 은 "in"·"out"·"reset". 배율은 창마다 따로다 (2026-09-09 사용자 결정, ticket zoom-per-window —
/// 종전엔 VS Code window.zoomLevel 처럼 앱 공통): 부른 창의 레벨(zooms)만 옮기고 그 창에만 적용한다. 결과는
/// state.json(persisted.zoom)에 마지막 값으로 저장해 재시작 첫 창·두 번째 실행 창의 시작값이 된다.
/// front 의 'View: Zoom In/Out/Reset Zoom'(Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 — Shift 없는 키는 편집기 글꼴 줌)이 부른다 — 웹은 브라우저
/// 줌이 있어 등록하지 않는다 (ticket convenience-features)
#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, state: tauri::State<AppState>, action: String) {
    let label = window.label().to_string();
    let level = {
        let mut zooms = state.zooms.lock().unwrap();
        let level = step_zoom(zooms.get(&label).copied().unwrap_or(0), &action);
        zooms.insert(label.clone(), level);
        level
    };
    {
        let mut p = state.persisted.lock().unwrap();
        p.zoom = level;
        save_state(state.state_file.as_deref(), &p);
    }
    if let Err(e) = window.set_zoom(zoom_factor(level)) {
        eprintln!("superlite: 줌 적용 실패 ({label}): {e}");
    }
}

/// OS 입력기(IME) 전환 — 편집기 vim 모드의 한글 IME 문제 (ticket editor-vim-ime-imswitch, 2026-09-08 사용자 결정):
/// 브라우저 위의 어떤 vim 계층도 편집기 안에서 OS IME 를 이길 수 없어(한글이 켜져 있으면 normal 모드 키가
/// 조합키 Process 로 온다) VSCodeVim 의 im-select 처럼 편집기 밖에서 입력기를 바꾼다. front 의 model/nvim 이
/// non-insert 모드 진입에 enabled=false(영문 강제 — 그때의 상태를 창 단위로 기억), insert 진입·vim 모드 해제에
/// enabled=true(기억한 상태 복원) 로 부른다. Windows 만 — macOS·Linux 는 무동작 (배포 타깃이 Windows, build.sh)
#[tauri::command]
fn set_ime(window: tauri::WebviewWindow, enabled: bool) {
    #[cfg(windows)]
    win_ime::apply(&window, enabled);
    #[cfg(not(windows))]
    let _ = (window, enabled);
}

/// IME 진단 (ticket term-ime-toggle-stuck, 임시) — 터미널에서 한/영 키를 누른 순간의 native 상태 한 줄 (전경 창·
/// 키보드 포커스 HWND·기본 IME 창들의 열림 상태). front terminalHost 가 한/영 keydown 때 부른다. 원인 확정 뒤 지운다.
/// Windows 만 — 다른 OS 는 "n/a"
#[tauri::command]
fn ime_probe(window: tauri::WebviewWindow) -> String {
    #[cfg(windows)]
    return win_ime::probe(&window);
    #[cfg(not(windows))]
    {
        let _ = window;
        "n/a".to_string()
    }
}

/// Windows 전용 IME 열림 상태 제어 — IMM32 의 WM_IME_CONTROL(IMC_GET/SETOPENSTATUS) 을 기본 IME 창에 보낸다.
/// 한국어 IME 는 한/영 토글이 열림 상태다(열림 = 한글, 닫힘 = 영문). 대상은 이 창의 HWND 와 자손 창 전부의
/// 기본 IME 창(중복 제거) — WebView2 의 입력 창(Chrome_WidgetWin_*)은 다른 프로세스 스레드라 우리 스레드의
/// 기본 IME 창만으로는 닿지 않을 수 있어 자손까지 함께 보낸다 (SendMessage 는 프로세스 경계를 넘는다).
/// WHY: ImmGetContext/ImmSetOpenStatus 는 다른 프로세스 창의 컨텍스트를 주지 않아 메시지 방식을 쓴다.
///      복원값은 창 label 별로 한 번만 기억한다 — 영문 강제가 잇따라 와도(편집기마다 attach) 첫 상태를 지킨다
#[cfg(windows)]
mod win_ime {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::Input::Ime::ImmGetDefaultIMEWnd;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, IsChild, SendMessageTimeoutW, GUITHREADINFO,
        SMTO_ABORTIFHUNG, WM_IME_CONTROL,
    };

    const IMC_GETOPENSTATUS: usize = 0x0005;
    const IMC_SETOPENSTATUS: usize = 0x0006;

    /// 창 label → 영문 강제 직전의 열림 상태. 항목이 있으면 강제 중
    static SAVED: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());

    pub fn apply(window: &tauri::WebviewWindow, enabled: bool) {
        let Ok(hwnd) = window.hwnd() else { return };
        let label = window.label().to_string();
        let targets = ime_windows(hwnd);
        if targets.is_empty() {
            eprintln!("superlite: IME 창 없음 ({label})");
            return;
        }
        let mut saved = SAVED.lock().unwrap();
        if enabled {
            // 강제 중이 아니면 되돌릴 것도 없다
            let Some(open) = saved.remove(&label) else { return };
            set_open(&targets, open);
        } else {
            if !saved.contains_key(&label) {
                saved.insert(label, get_open(&targets));
            }
            set_open(&targets, false);
        }
    }

    /// 앱 프로세스 소속 창(tao 최상위 창·wry 의 WebView2 컨테이너 창)에서 IME 를 뗀다 (ticket term-ime-window-topright).
    /// 이 창들은 IME 메시지를 DefWindowProc 로 넘겨 키보드 포커스가 잠시 여기 머문 채 한글이 들어오면 Windows 가
    /// 구식 기본 조합 창을 클라이언트 (0,0) — 자체 제목 표시줄 위 — 에 그린다 (2026-09-13 캡처). 실제 입력 대상인
    /// WebView2 의 입력 창은 다른 프로세스라 ImmAssociateContext 가 닿지 않고 스스로 기본 창을 억제하므로 영향이 없다.
    /// winit 이 창 생성 때 기본으로 하는 것과 같다 (tao 는 하지 않는다). 창 생성 직후 한 번 — 컨테이너 창은 build 에서
    /// 동기로 만들어져 그 시점에 있다
    pub fn detach_host_windows(window: &tauri::WebviewWindow) {
        use windows::Win32::UI::Input::Ime::ImmAssociateContext;
        use windows::Win32::UI::Input::Ime::HIMC;
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
        let Ok(hwnd) = window.hwnd() else { return };
        let me = std::process::id();
        for h in all_windows(hwnd) {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
            if pid == me {
                unsafe { ImmAssociateContext(h, HIMC::default()) };
            }
        }
    }

    fn all_windows(root: HWND) -> Vec<HWND> {
        let mut hwnds = vec![root];
        unsafe extern "system" fn collect(h: HWND, lp: LPARAM) -> BOOL {
            unsafe { (*(lp.0 as *mut Vec<HWND>)).push(h) };
            BOOL(1)
        }
        unsafe {
            let _ = EnumChildWindows(Some(root), Some(collect), LPARAM(&mut hwnds as *mut Vec<HWND> as isize));
        }
        hwnds
    }

    fn ime_windows(root: HWND) -> Vec<HWND> {
        let hwnds = all_windows(root);
        let mut out: Vec<HWND> = Vec::new();
        for h in hwnds {
            let ime = unsafe { ImmGetDefaultIMEWnd(h) };
            if !ime.0.is_null() && !out.contains(&ime) {
                out.push(ime);
            }
        }
        out
    }

    /// WHY: 대상 IME 창은 WebView2 프로세스 소속이라 동기 SendMessage 는 그쪽이 멈추면 메인 스레드까지 끌려간다 —
    ///      상한을 두고, 이미 응답 없는 창이면 바로 포기한다. 시간 초과·실패는 None (읽기는 닫힘으로 친다)
    fn ime_control(h: HWND, cmd: usize, arg: isize) -> Option<isize> {
        let mut result = 0usize;
        let ok = unsafe {
            SendMessageTimeoutW(h, WM_IME_CONTROL, WPARAM(cmd), LPARAM(arg), SMTO_ABORTIFHUNG, IME_TIMEOUT_MS, Some(&mut result))
        };
        (ok.0 != 0).then_some(result as isize)
    }

    const IME_TIMEOUT_MS: u32 = 200;

    fn get_open(targets: &[HWND]) -> bool {
        targets.iter().any(|&h| ime_control(h, IMC_GETOPENSTATUS, 0).is_some_and(|r| r != 0))
    }

    fn set_open(targets: &[HWND], open: bool) {
        for &h in targets {
            ime_control(h, IMC_SETOPENSTATUS, open as isize);
        }
    }

    /// 진단 (ticket term-ime-toggle-stuck, 임시): 전경 창이 이 창인지, 전경 스레드의 키보드 포커스 HWND 의 클래스명과
    /// 이 창의 자손인지(GetGUIThreadInfo(0) 은 프로세스 경계를 넘어 전경 스레드의 포커스를 준다), 이 창·자손의 기본
    /// IME 창별 열림 상태. 한/영 키가 IME 에 닿지 않는 순간 포커스가 어디 있고 열림 상태가 바뀌는지를 가른다
    pub fn probe(window: &tauri::WebviewWindow) -> String {
        let Ok(hwnd) = window.hwnd() else { return "no hwnd".to_string() };
        let mut gti: GUITHREADINFO = unsafe { std::mem::zeroed() };
        gti.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let (focus, fg) = unsafe {
            let _ = GetGUIThreadInfo(0, &mut gti);
            (gti.hwndFocus, GetForegroundWindow())
        };
        let class = |h: HWND| -> String {
            if h.0.is_null() {
                return "null".to_string();
            }
            let mut buf = [0u16; 64];
            let n = unsafe { GetClassNameW(h, &mut buf) }.max(0) as usize;
            String::from_utf16_lossy(&buf[..n])
        };
        let inside = !focus.0.is_null() && (focus == hwnd || unsafe { IsChild(hwnd, focus) }.as_bool());
        let opens: Vec<String> = ime_windows(hwnd)
            .iter()
            .map(|&h| ime_control(h, IMC_GETOPENSTATUS, 0).map_or("?".to_string(), |r| (r != 0).to_string()))
            .collect();
        format!(
            "fg={} focus={}{} ime=[{}]",
            fg == hwnd,
            class(focus),
            if inside { "(inside)" } else { "(OUTSIDE)" },
            opens.join(",")
        )
    }
}

/// 빈 세션 root 판정 — None(로컬 시작 페이지) 또는 경로 없는 원격 `ssh://host`(원격 시작
/// 페이지 — 그 호스트 탐색만, relay 참조). 둘 다 폴더 열기가 제자리 교체하는 대상이다
fn is_empty_root(root: Option<&std::path::Path>) -> bool {
    match root.and_then(|r| r.to_str()) {
        None => true,
        Some(s) => s.strip_prefix("ssh://").is_some_and(|rest| !rest.contains('/')),
    }
}

/// 같은 워크스페이스가 이미 열려 있으면 (세션 id, 소속 창 label). 첫 일치 = 원본 세션 — 같은
/// root 의 미러는 항상 뒤에 온다 (Groups.mirrors 불변식). 호출자가 sessions·windows 락을 잡고 부른다
fn find_open(
    list: &[(String, Option<PathBuf>)],
    windows: &HashMap<String, String>,
    root: &Path,
) -> Option<(String, String)> {
    let (id, _) = list.iter().find(|(_, r)| r.as_deref() == Some(root))?;
    // windows 는 sessions 와 함께 갱신되므로 없을 수 없다 — 방어
    let owner = windows.get(id).cloned().unwrap_or_else(|| MAIN_WINDOW.to_string());
    Some((id.clone(), owner))
}

/// 이미 열린 세션의 창을 앞으로 가져오고 session-focus 로 그 탭에 포커스를 옮긴다. 락 없이 부른다
fn focus_session(app: &tauri::AppHandle, owner: &str, id: &str) {
    if let Some(w) = app.get_webview_window(owner) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit_to(owner, "session-focus", id);
}

/// 새 세션 등록 단일 진입점 — 새 session id 를 발급해 레지스트리에 붙이고(소속 = label)
/// 방송한다. front 는 sessions-changed 를 받아 새 id 로 WS 연결을 열고 그 탭을 활성으로
/// 만든다. dialog·퀵인풋·OS 드롭이 공유한다 (두 번째 실행은 새 창이라 open_second_instance 가
/// 따로 등록한다).
///
/// replace 는 빈 세션 탭 id (시작 페이지에서 열기) — 그 엔트리가 아직 root 없는
/// 채로 있으면 push 대신 그 자리를 교체해 탭 위치를 보존한다. id 는 새로 발급 —
/// front reconcile 이 제거+추가로 자연히 따라온다.
///
/// 같은 워크스페이스가 이미 열려 있으면(어느 창이든) 새 탭 대신 그 창을 앞으로 가져오고
/// session-focus 로 그 탭에 포커스만 옮긴다 (VS Code — 다른 창에 열린 폴더는 그 창으로,
/// find_open·focus_session). 워크스페이스 정체성은 canonicalize 된 로컬 경로 또는
/// ssh://host/path 문자열이다.
/// 에디터·터미널 탭 분리(detach_tabs)는 같은 root 의 두 번째 세션을 의도적으로 만들므로
/// 이 함수를 타지 않는다.
fn open_workspace(app: &tauri::AppHandle, state: &AppState, label: &str, root: PathBuf, replace: Option<&str>) {
    let label = &main_label(state, label);
    // 이미 열려 있어 포커스만 옮기는 경우도 "최근 연 폴더"다
    remember_recent(state, &root);
    {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        if let Some((id, owner)) = find_open(&list, &windows, &root) {
            drop(windows);
            drop(list);
            focus_session(app, &owner, &id);
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

/// 확인 다이얼로그(ticket native-confirm-dialog) — 삭제·이동·dirty 닫기 등 front 의 모든 확인이
/// 앱에서는 VS Code 처럼 OS 메시지 창으로 온다 (front model/dialog.confirm 이 분기, 웹은 내장 창).
/// buttons 는 [확인, (보조), Cancel] 2~3개 — 커스텀 라벨 그대로 (Windows 는 TaskDialog, Cargo.toml 참조).
/// 요청한 창을 부모로 모달. 반환은 고른 버튼의 index — 닫기·Escape·매칭 실패는 마지막(Cancel)
#[tauri::command]
async fn confirm_dialog(window: tauri::WebviewWindow, message: String, detail: Option<String>, buttons: Vec<String>) -> usize {
    let cancel = buttons.len().saturating_sub(1);
    let btns = match buttons.as_slice() {
        [a, b] => rfd::MessageButtons::OkCancelCustom(a.clone(), b.clone()),
        [a, b, c] => rfd::MessageButtons::YesNoCancelCustom(a.clone(), b.clone(), c.clone()),
        _ => return cancel,
    };
    let text = match detail {
        Some(d) if !d.is_empty() => format!("{message}\n\n{d}"),
        _ => message,
    };
    let picked = rfd::AsyncMessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("superlite")
        .set_description(text)
        .set_buttons(btns)
        .set_parent(&window)
        .show()
        .await;
    match picked {
        rfd::MessageDialogResult::Custom(label) => buttons.iter().position(|b| *b == label).unwrap_or(cancel),
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => 0,
        rfd::MessageDialogResult::No => 1.min(cancel),
        rfd::MessageDialogResult::Cancel => cancel,
    }
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

/// 다운로드 완료 알림의 "폴더 열기"(ticket download-conveniences) — OS 파일 관리자로 path 를
/// 드러낸다. 파일이면 그 파일이 든 폴더를 열어 선택 표시(Windows explorer /select, macOS open -R),
/// 폴더면 그 폴더 자체를 연다. Linux 는 선택 표시 없이 폴더 열기(xdg-open). 임의 로컬 경로를
/// 받는 근거는 open_folder_path 와 같다. 프로세스 종료는 기다리지 않는다 — explorer 는
/// 성공해도 종료 코드가 1 이라 결과를 신뢰할 수 없다
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("경로가 없다: {path}"));
    }
    let is_dir = p.is_dir();
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt as _;
        // explorer 는 "/select," 와 경로가 한 인자여야 하고 '/' 구분자를 받지 않는다
        let win = path.replace('/', "\\");
        let mut c = std::process::Command::new("explorer");
        if is_dir {
            c.raw_arg(format!("\"{win}\""));
        } else {
            c.raw_arg(format!("/select,\"{win}\""));
        }
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        if !is_dir {
            c.arg("-R");
        }
        c.arg(&path);
        c
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut cmd = {
        let dir = if is_dir { p } else { p.parent().unwrap_or(p) };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("파일 관리자 실행 실패: {e}"))
}

/// "Open Externally"(ticket open-externally) 사본 폴더 — OS 임시 폴더 아래 superlite-open.
/// 앱 시작 시 통째로 지운다 (외부 앱이 잠근 파일은 남는다 — 오류 무시)
fn open_externally_dir() -> PathBuf {
    std::env::temp_dir().join("superlite-open")
}

/// 편집기 "Open Externally" 의 로컬 사본 경로 — <임시>/superlite-open/<key 해시>/<name>. key 는
/// 원격 파일 경로라 같은 파일을 다시 열면 같은 자리에 덮어쓰고, 이름이 같은 다른 파일과는
/// 섞이지 않는다. name 은 파일명 한 조각이어야 한다 (구분자·'..' 거부 — 사본 폴더 밖으로 못
/// 나간다). 전송은 front 가 local_write 로 조각마다 넘긴다
#[tauri::command]
fn open_externally_target(key: String, name: String) -> Result<String, String> {
    use std::hash::{Hash as _, Hasher as _};
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("파일명이 아니다: '{name}'"));
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    let dir = open_externally_dir().join(format!("{:016x}", h.finish()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name).to_string_lossy().into_owned())
}

/// 사본을 OS 기본 앱으로 연다 (open crate — Windows ShellExecute·macOS open·Linux xdg-open).
/// open_externally_target 이 준 사본 폴더 안의 경로만 받는다 — 임의 로컬 파일 실행 통로가
/// 되지 않게. 종료는 기다리지 않는다
#[tauri::command]
fn open_externally(path: String) -> Result<(), String> {
    let p = Path::new(&path).canonicalize().map_err(|e| format!("사본이 없다: {e}"))?;
    let root = open_externally_dir().canonicalize().map_err(|e| format!("사본 폴더가 없다: {e}"))?;
    if !p.starts_with(&root) {
        return Err(format!("사본 폴더 밖의 경로다: {path}"));
    }
    open::that_detached(&p).map_err(|e| format!("외부 앱 실행 실패: {e}"))
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
    let label = main_label(&state, window.label());
    {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        push_session(&mut list, &mut windows, &label, None);
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
        let mut windows = state.windows.lock().unwrap();
        let mut groups = state.groups.lock().unwrap();
        let Some(i) = list.iter().position(|(sid, _)| sid == &id) else {
            return;
        };
        list.remove(i);
        drop_mirrors_of(&mut list, &mut windows, &mut groups, &id);
        windows.remove(&id)
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
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        let mut groups = state.groups.lock().unwrap();
        // 서브 창의 탭은 출처 창이 이미 되돌려 받았다 (session-recall) — 미러만 지운다
        drop_mirrors_of(&mut list, &mut windows, &mut groups, &id);
        windows.insert(id.clone(), label.clone());
    }
    deliver_handoff(&app, &state, &label, handoff);
    match build_window(&app, &state, &label, Some((x, y)), None, zoom_of(&state, &from)) {
        Err(e) => {
            // 롤백 — 생기지 않은 창 소속으로 세션이 사라지지 않게 되돌린다
            {
                // _list 는 락 순서(sessions → windows) 유지용 — 미사용처럼 보여도 지우지 않는다
                let _list = state.sessions.lock().unwrap();
                state.windows.lock().unwrap().insert(id.clone(), from.clone());
            }
            state.handoffs.lock().unwrap().remove(&label);
            emit_sessions(&app, &state);
            return Err(format!("창 생성 실패: {e}"));
        }
        #[cfg(windows)]
        Ok(w) => vdesk::follow(&app, &from, &w),
        #[cfg(not(windows))]
        Ok(_) => {}
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
        let mut groups = state.groups.lock().unwrap();
        if groups.subs.contains_key(&to_window) {
            return Err("서브 창으로는 세션을 옮길 수 없다".into());
        }
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
        drop_mirrors_of(&mut list, &mut windows, &mut groups, &id);
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

/// 에디터·터미널 탭을 새 서브 창으로 분리 (2026-09-08 개정) — 호출 창의 메인 창 소속 서브 창을
/// 만들고, 출처 세션(핸드오프 fromSession — 메인 세션 또는 미러)의 원본에 대한 미러 세션(같은
/// root, 새 id)을 그 창에 만든다. open_workspace 의 "이미 열림 → 포커스" 규칙을 의도적으로
/// 건너뛴다 (같은 워크스페이스의 두 번째 세션이 목적). 핸드오프 toSession 은 원본 id — 서브 창
/// front 는 세션을 원본 id 로 키잡는다. 터미널은 새 창이 adoptTerminal(와이어 v10)로 출처 세션
/// (fromSession, 데몬 세션 id)에서 가져간다. root 인자는 출처가 아는 root — 레지스트리의
/// 원본 root 가 우선이다. zoom 은 보조창 복원(workspaceState.restoreWorkspace)이 저장된 웹뷰 줌 레벨을
/// 넘기는 자리 — 없으면 출처 창 값을 물려받는다 (ticket zoom-per-window)
#[tauri::command]
async fn detach_tabs(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    root: String,
    x: f64,
    y: f64,
    size: Option<(f64, f64)>,
    zoom: Option<i32>,
    mut handoff: serde_json::Value,
) -> Result<(), String> {
    let root = parse_root(&root)?;
    // 웹뷰가 준 임의 JSON — 객체가 아니면 IndexMut 이 패닉해 상태 mutex 를 poison 시킨다
    let Some(obj) = handoff.as_object_mut() else {
        return Err("핸드오프는 객체여야 한다".into());
    };
    let from_session = obj.get("fromSession").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let state = app.state::<AppState>();
    let main = main_label(&state, window.label());
    let label = new_window_label(&state);
    let (origin, session) = {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        let mut groups = state.groups.lock().unwrap();
        let origin = groups.mirrors.get(&from_session).cloned().unwrap_or(from_session);
        if !owns(&windows, &origin, &main) {
            return Err("이 창 묶음의 세션이 아니다".into());
        }
        let root = list.iter().find(|(id, _)| id == &origin).and_then(|(_, r)| r.clone()).unwrap_or(root);
        groups.subs.insert(label.clone(), main.clone());
        let session = push_session(&mut list, &mut windows, &label, Some(root));
        groups.mirrors.insert(session.clone(), origin.clone());
        (origin, session)
    };
    obj.insert("toSession".into(), serde_json::Value::String(origin));
    deliver_handoff(&app, &state, &label, handoff);
    // 보조창 복원은 저장된 레벨(±ZOOM_MAX 클램프), 그 외는 출처 창 값을 물려받는다
    let zoom = zoom.map_or_else(|| zoom_of(&state, window.label()), |z| z.clamp(-ZOOM_MAX, ZOOM_MAX));
    match build_window(&app, &state, &label, Some((x, y)), size, zoom) {
        Err(e) => {
            // 롤백 — 생기지 않은 창의 세션·미러·핸드오프를 지운다 (front 는 실패를 받아 탭을 되돌린다)
            {
                let mut list = state.sessions.lock().unwrap();
                let mut windows = state.windows.lock().unwrap();
                let mut groups = state.groups.lock().unwrap();
                list.retain(|(sid, _)| sid != &session);
                windows.remove(&session);
                groups.mirrors.remove(&session);
                groups.subs.remove(&label);
            }
            state.handoffs.lock().unwrap().remove(&label);
            return Err(format!("창 생성 실패: {e}"));
        }
        // 분리 창은 출처 창과 같은 가상 데스크톱으로
        #[cfg(windows)]
        Ok(w) => vdesk::follow(&app, window.label(), &w),
        #[cfg(not(windows))]
        Ok(_) => {}
    }
    emit_sessions(&app, &state);
    Ok(())
}

/// 서브 창이 아직 미러가 없는 세션(원본 id)에 탭을 받게 될 때 미러를 만든다 — 다른 창의 탭바
/// 드롭이 자리표시 컨텍스트에 떨어진 경우. 이미 있으면 그 id. 방송으로 front 가 컨텍스트를 교체한다
#[tauri::command]
fn ensure_mirror(app: tauri::AppHandle, window: tauri::WebviewWindow, origin: String) -> Result<String, String> {
    let state = app.state::<AppState>();
    let label = window.label().to_string();
    let (id, created) = {
        let mut list = state.sessions.lock().unwrap();
        let mut windows = state.windows.lock().unwrap();
        let mut groups = state.groups.lock().unwrap();
        let Some(main) = groups.subs.get(&label).cloned() else {
            return Err("서브 창이 아니다".into());
        };
        if !owns(&windows, &origin, &main) {
            return Err("이 창 묶음의 세션이 아니다".into());
        }
        if let Some(m) = groups.mirror_in(&windows, &label, &origin) {
            (m, false)
        } else {
            let root = list.iter().find(|(id, _)| id == &origin).and_then(|(_, r)| r.clone());
            if root.is_none() {
                return Err("빈 세션에는 탭을 둘 수 없다".into());
            }
            let session = push_session(&mut list, &mut windows, &label, root);
            groups.mirrors.insert(session.clone(), origin);
            (session, true)
        }
    };
    if created {
        emit_sessions(&app, &state);
    }
    Ok(id)
}

/// 활성 세션 전환 알림 — 메인·서브 창이 활성 세션을 공유한다 (2026-09-08 개정 — 종전엔 native 가
/// 활성을 몰랐다). 호출 창의 메인 창 단위로 기억하고 묶음 전체에 session-active 로 방송한다
/// (호출 창 포함 — front 는 같은 id 면 무동작). id 는 메인 세션 id (서브 창 스트립도 원본 id 를 쓴다)
#[tauri::command]
fn set_active_session(app: tauri::AppHandle, window: tauri::WebviewWindow, id: String) {
    let state = app.state::<AppState>();
    let main = main_label(&state, window.label());
    {
        let windows = state.windows.lock().unwrap();
        if !owns(&windows, &id, &main) {
            return;
        }
        state.groups.lock().unwrap().active.insert(main.clone(), id.clone());
    }
    emit_group(&app, &state, &main, "session-active", id);
}

/// 부팅 정보 — 창 페이지가 뜰 때 front(model/boot)가 한 번 묻는다 (ticket app-boot-globals-iframe-leak).
/// 종전 initialization_script 전역 여섯 개(__SUPERLITE_WS__·SESSIONS·OPEN_ROOT·WINDOW·OWNER·ACTIVE)를
/// 한 응답으로 합친 것. 세션 목록은 호출 창 소속만(infos_for). active 는 호출 창이 속한 묶음의 현재 활성
/// 세션 — 페이지 로드마다 묻는 값이라 창 새로고침 뒤에도 리로드 전 활성 탭이 그대로 온다 (ticket
/// reload-session-focus 의 active_session 커맨드를 흡수). set_active_session 이 온 적 없는 묶음(새 창)은 null
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootInfo {
    ws: String,
    sessions: Vec<SessionInfo>,
    open_root: String,
    window: String,
    owner: Option<String>,
    active: Option<String>,
}

#[tauri::command]
fn boot_info(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> BootInfo {
    let label = window.label();
    let sessions = infos_for(&state, label);
    let (owner, active) = {
        let groups = state.groups.lock().unwrap();
        (groups.subs.get(label).cloned(), groups.active.get(groups.main_of(label)).cloned())
    };
    BootInfo { ws: state.ws_url.clone(), sessions, open_root: default_open_root(), window: label.to_string(), owner, active }
}

/// 호출 창의 메인 창에 딸린 서브 창 label 들 — 메인 창이 세션을 떠나보내기 전 탭 회수(session-recall)
/// 대상. 서브 창에서 부르면 형제들
#[tauri::command]
fn list_subs(state: tauri::State<AppState>, window: tauri::WebviewWindow) -> Vec<String> {
    let groups = state.groups.lock().unwrap();
    groups.subs_of(groups.main_of(window.label()))
}

/// 창 간 메시지 중계 — 대상 창의 드롭이 출처 창에 이동을 요청하거나(…-move-request), 출처
/// 창이 살아 있는 대상 창에 에디터·터미널 탭 핸드오프를 보낼 때(tabs-handoff), 메인 창이 서브
/// 창에 세션의 탭 회수를 요청하고(session-recall) 서브가 응답할 때(session-recalled) 쓴다.
/// 열기 우선순위(ticket editor-group-open-priority)는 high 그룹 보유를 묶음의 창들에 알리고(open-priority,
/// 늦게 뜬 창의 open-priority-query) high 그룹이 있는 창으로 파일 열기를 넘긴다(open-file-request).
/// native 는 payload 내용을 모른다
#[tauri::command]
fn forward(app: tauri::AppHandle, to_window: String, event: String, payload: serde_json::Value) -> Result<(), String> {
    // 창 간 중계 전용 이벤트만 — 웹뷰가 native 전용 이벤트(sessions-changed 등)를 위조해 다른
    // 창에 보내는 통로가 되지 않게
    const ALLOWED: [&str; 8] = [
        "session-move-request", "tabs-move-request", "tabs-handoff", "session-recall", "session-recalled",
        "open-priority", "open-priority-query", "open-file-request",
    ];
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

/// 메인 창 목록 — 탭 우클릭 "Move to Window …" 메뉴가 자기 외 창을 나열한다. title 은 그 창의
/// 세션 이름들 (빈 세션은 Welcome). 서브 창은 세션을 받을 수 없어 뺀다
#[tauri::command]
fn list_windows(app: tauri::AppHandle, state: tauri::State<AppState>) -> Vec<WindowInfo> {
    let subs: Vec<String> = state.groups.lock().unwrap().subs.keys().cloned().collect();
    let mut labels: Vec<String> = app.webview_windows().keys().filter(|l| !subs.contains(l)).cloned().collect();
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

/// 시작 페이지 목록 — 최근 폴더 MRU 와 고정 그룹. 매 표시마다 부른다 (소실 여부는 그때 검사)
/// 터미널 링크 Ctrl+클릭 (ticket terminal-links)·URL 탭의 외부 열기: http(s) URL 을 OS 기본 브라우저로. 웹뷰 안의
/// window.open 은 새 웹뷰 창이 되거나 막힌다. 스킴은 http(s) 만 — file:·javascript: 같은 것은 거절.
/// 종료를 기다리지 않는다 (브라우저 프로세스가 오래 산다)
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("http(s) URL 이 아니다: {url}"));
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_recents(state: tauri::State<AppState>) -> RecentsInfo {
    let p = state.persisted.lock().unwrap();
    RecentsInfo {
        recents: p.recents.iter().map(|r| recent_entry(r)).collect(),
        pinned: p
            .pinned
            .iter()
            .map(|g| PinGroupInfo { alias: g.alias.clone(), roots: g.roots.iter().map(|r| recent_entry(r)).collect() })
            .collect(),
    }
}

/// 최근 폴더 목록에서 지우기 (시작 페이지 ×). 고정 그룹은 건드리지 않는다
#[tauri::command]
fn forget_recent(state: tauri::State<AppState>, root: String) {
    let mut p = state.persisted.lock().unwrap();
    p.recents.retain(|r| r.to_string_lossy() != root);
    save_state(state.state_file.as_deref(), &p);
}

/// 워크스페이스 상태의 주인 세션인가 — 그 root 의 첫(가장 오래된) 세션만 저장·복원한다. 탭 분리
/// (detach_tabs)로 생긴 같은 root 의 두 번째 세션은 대상이 아니다 (2026-09-08 사용자 결정 — 분리 창은
/// 기억하지 않는다). 첫 세션이 닫히면 남은 세션이 주인이 된다. 반환은 그 root
fn primary_root(state: &AppState, id: &str, label: &str) -> Result<PathBuf, String> {
    owned_by(state, id, label)?;
    let list = state.sessions.lock().unwrap();
    let root = list
        .iter()
        .find(|(sid, _)| sid == id)
        .and_then(|(_, r)| r.clone())
        .filter(|r| !is_empty_root(Some(r)))
        .ok_or_else(|| "빈 세션".to_string())?;
    // "첫 세션" 은 레지스트리(탭) 순서 기준 — 미러가 원본보다 뒤에 온다는 Groups.mirrors 불변식 덕에
    // 원본이 먼저 잡힌다. 탭 순서 이동(move_session)은 창 안에서만 일어나 미러(서브 창)와 섞이지 않는다
    match list.iter().find(|(_, r)| r.as_ref() == Some(&root)) {
        Some((sid, _)) if sid == id => Ok(root),
        _ => Err("이 root 의 첫 세션이 아니다".into()),
    }
}

/// 창 묶음 새로고침 (팔레트 Developer: Reload Window) — 호출 창이 속한 메인 창과 그 서브 창 전부를 네이티브
/// reload 한다 (2026-09-08 사용자 결정: 한 창만이 아니라 묶음이 함께). 세션 레지스트리는 그대로라 같은 id 로
/// 재-attach 하고, 메인은 자기 워크스페이스 몫·서브는 자기 서브 몫에서 탭·배치가 돌아온다 (get_workspace_state
/// 는 살아 있는 서브가 있으면 subs 를 비우지 않는다). 서브를 먼저 — 메인이 먼저 다시 뜨며 서브를 정리하지 않게
#[tauri::command]
fn reload_window(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (main, subs) = {
        let groups = state.groups.lock().unwrap();
        let main = groups.main_of(window.label()).to_string();
        (main.clone(), groups.subs_of(&main))
    };
    for label in subs.iter().chain(std::iter::once(&main)) {
        if let Some(w) = app.get_webview_window(label) {
            w.reload().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 워크스페이스 상태 읽기 — 세션 초기 로드 뒤 front 가 한 번 부른다. 없음·주인 아님은 null.
/// 응답은 {state, subs: [{label,x,y,w,h,zoom, ...스냅샷}]} — subs 는 넘기면서 비운다 (서브 창은 되살아나며
/// 다시 저장하므로, 남겨 두면 다음 열기에 중복 창이 생긴다). 주인 아님은 서브 창 자신의 부팅 포함.
/// 예외는 창 묶음 새로고침(reload_window) — 그 label 의 서브 창이 살아 있고 이 세션의 미러를 아직 갖고 있으면
/// 그 몫은 그 창이 get_workspace_sub_state 로 되살리므로 넘기지도 비우지도 않는다. 종전엔 살아 있는 서브 창이
/// 하나라도 있으면 전부 남겼는데, 다른 세션의 탭만 가진 서브 창이 떠 있는 채 세션을 다시 열면 보조창이
/// 끝내 돌아오지 않았다 (ticket sub-window-restore-broken, 2026-09-13)
/// async: 디스크 쓰기(set)와 같은 이유로 메인 스레드를 피한다 (get 은 짧지만 짝을 맞춘다)
#[tauri::command]
async fn get_workspace_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<serde_json::Value>, String> {
    // 주인이 아니면 오류가 아니라 없음 — front 는 조용히 복원을 건너뛴다
    let Ok(root) = primary_root(&state, &id, window.label()) else {
        return Ok(None);
    };
    // 이 세션의 미러를 가진 살아 있는 서브 창(새로고침 중) — 그 label 의 몫은 그 창의 것
    let reloading: Vec<String> = {
        let windows = state.windows.lock().unwrap();
        let groups = state.groups.lock().unwrap();
        groups.subs_of(groups.main_of(window.label())).into_iter().filter(|l| groups.mirror_in(&windows, l, &id).is_some()).collect()
    };
    let mut p = state.persisted.lock().unwrap();
    let Some(w) = p.workspaces.iter_mut().find(|w| w.root == root) else {
        return Ok(None);
    };
    let (kept, taken): (Vec<SubWorkspaceEntry>, Vec<SubWorkspaceEntry>) =
        std::mem::take(&mut w.subs).into_iter().partition(|s| reloading.contains(&s.label));
    w.subs = kept;
    // 비운 것이 있을 때만 파일에 반영한다
    let changed = !taken.is_empty();
    let subs: Vec<serde_json::Value> = taken
        .into_iter()
        .map(|s| {
            let mut v = s.state;
            if let Some(o) = v.as_object_mut() {
                o.insert("label".into(), s.label.into());
                o.insert("x".into(), s.x.into());
                o.insert("y".into(), s.y.into());
                o.insert("w".into(), s.w.into());
                o.insert("h".into(), s.h.into());
                o.insert("zoom".into(), s.zoom.into());
            }
            v
        })
        .collect();
    let out = serde_json::json!({ "state": w.state.clone(), "subs": subs });
    if changed {
        save_state(state.state_file.as_deref(), &p);
    }
    Ok(Some(out))
}

/// 워크스페이스 상태 저장 — front 가 변경 디바운스·닫기 시점에 통째로 보낸다 (root 는 세션 id 로 안다).
/// async: 변경마다 state.json 을 쓰므로 메인(UI) 스레드에서 디스크를 기다리지 않는다
#[tauri::command]
async fn set_workspace_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let root = primary_root(&state, &id, window.label())?;
    let mut p = state.persisted.lock().unwrap();
    // 서브 창 몫은 메인 저장과 무관하게 유지 — 앞으로 당기며 state 만 바꾼다
    let subs = p.workspaces.iter().position(|w| w.root == root).map(|i| p.workspaces.remove(i).subs).unwrap_or_default();
    p.workspaces.insert(0, WorkspaceEntry { root, state: snapshot, subs });
    p.workspaces.truncate(WORKSPACES_MAX);
    save_state(state.state_file.as_deref(), &p);
    Ok(())
}

/// 서브 창이 자기 몫을 읽는다 (서브 창 새로고침 — 탭은 front 에만 있어 다시 그리려면 저장본이 필요하다).
/// 창 label 로 찾는다 — 새로 만든 서브 창(새 label)은 없음(null)이고 핸드오프가 채운다. 비우지 않는다
#[tauri::command]
async fn get_workspace_sub_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<serde_json::Value>, String> {
    let label = window.label().to_string();
    owned_by(&state, &id, &label)?;
    let (main, origin) = {
        let groups = state.groups.lock().unwrap();
        let (Some(main), Some(origin)) = (groups.subs.get(&label).cloned(), groups.mirrors.get(&id).cloned()) else {
            return Ok(None);
        };
        (main, origin)
    };
    let Ok(root) = primary_root(&state, &origin, &main) else {
        return Ok(None);
    };
    let p = state.persisted.lock().unwrap();
    Ok(p.workspaces
        .iter()
        .find(|w| w.root == root)
        .and_then(|w| w.subs.iter().find(|s| s.label == label))
        .map(|s| s.state.clone()))
}

/// 보조창(서브 창)의 워크스페이스 몫 저장 — 서브 창이 자기 미러 세션 id 로 부른다. native 가 창 위치·크기
/// (논리 px)를 읽어 붙이고 그 root 의 subs 에 label 로 upsert 한다. snapshot null 은 잊기(서브 창 X·마지막 탭
/// 이탈). 원본 세션이 주인(primary_root)이어야 한다
#[tauri::command]
async fn set_workspace_sub_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    snapshot: Option<serde_json::Value>,
) -> Result<(), String> {
    let label = window.label().to_string();
    owned_by(&state, &id, &label)?;
    let (main, origin) = {
        let groups = state.groups.lock().unwrap();
        let Some(main) = groups.subs.get(&label).cloned() else {
            return Err("서브 창이 아니다".into());
        };
        let Some(origin) = groups.mirrors.get(&id).cloned() else {
            return Err("미러 세션이 아니다".into());
        };
        (main, origin)
    };
    let root = primary_root(&state, &origin, &main)?;
    let geom = snapshot.as_ref().map(|_| {
        let scale = window.scale_factor().unwrap_or(1.0);
        let pos = window.outer_position().map(|p| p.to_logical::<f64>(scale)).unwrap_or(tauri::LogicalPosition::new(0.0, 0.0));
        let size = window.inner_size().map(|s| s.to_logical::<f64>(scale)).unwrap_or(tauri::LogicalSize::new(1200.0, 800.0));
        (pos.x, pos.y, size.width, size.height)
    });
    // 창의 웹뷰 줌 레벨도 함께 — 복원 때 detach_tabs 의 zoom 으로 돌아온다 (persisted 락 밖에서 읽는다)
    let zoom = zoom_of(&state, &label);
    let mut p = state.persisted.lock().unwrap();
    let i = match p.workspaces.iter().position(|w| w.root == root) {
        Some(i) => i,
        None => {
            if snapshot.is_none() {
                return Ok(());
            }
            p.workspaces.insert(0, WorkspaceEntry { root, state: serde_json::Value::Null, subs: Vec::new() });
            p.workspaces.truncate(WORKSPACES_MAX);
            0
        }
    };
    let subs = &mut p.workspaces[i].subs;
    subs.retain(|s| s.label != label);
    if let (Some(st), Some((x, y, w, h))) = (snapshot, geom) {
        subs.push(SubWorkspaceEntry { label, x, y, w, h, zoom, state: st });
    }
    save_state(state.state_file.as_deref(), &p);
    Ok(())
}

/// 고정 그룹 목록 통째로 교체 — pin·unpin·순서·그룹 간 이동·별칭을 front 가 계산해 결과 목록을
/// 보낸다 (op 를 늘리는 대신 단일 set — 검증은 normalize_pinned). 고정된 root 는 MRU 에서 뺀다
#[tauri::command]
fn set_pinned(state: tauri::State<AppState>, groups: Vec<PinGroup>) {
    let groups = normalize_pinned(groups);
    let mut p = state.persisted.lock().unwrap();
    p.recents.retain(|r| !is_pinned(&groups, r));
    p.pinned = groups;
    save_state(state.state_file.as_deref(), &p);
}

/// 고정 그룹 정리(순수 함수) — 그룹 안 중복 root 는 앞의 것만, 빈 그룹은 버림, 빈 별칭은 None
fn normalize_pinned(groups: Vec<PinGroup>) -> Vec<PinGroup> {
    groups
        .into_iter()
        .map(|g| {
            let mut roots: Vec<PathBuf> = Vec::new();
            for r in g.roots {
                if !roots.contains(&r) {
                    roots.push(r);
                }
            }
            let alias = g.alias.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
            PinGroup { alias, roots }
        })
        .filter(|g| !g.roots.is_empty())
        .collect()
}

/// 고정 그룹 열기 (시작 페이지 오른쪽 컬럼 제목 클릭) — root 들을 세션 탭으로 한꺼번에 등록한다.
/// 이 창의 탭이 전부 빈 세션이면 그 빈 탭들을 치우고 이 창에 (시작 페이지에서 고르는 명시적
/// 복원), 비어 있지 않은 탭이 있으면 무조건 새 창에 (사용자 결정 — 열려 있는 작업과 섞지 않는다).
/// 이미 어느 창에든 열린 root 는 건너뛴다 (open_workspace 의 중복 금지와 같은 이유). 경로가
/// 소실된 root 도 건너뛰고, 열 것이 하나도 없으면 에러로 알린다.
/// WHY: async — 창을 만드는 커맨드는 메인 스레드에서 돌면 Windows 에서 교착한다 (build_window 참조)
#[tauri::command]
async fn open_group(app: tauri::AppHandle, window: tauri::WebviewWindow, roots: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    open_group_in(&app, &state, window.label(), &roots)?;
    emit_sessions(&app, &state);
    Ok(())
}

/// 시작 페이지 "Open Selected" — 번호를 붙인 그룹들을 번호 순서로 한꺼번에 연다 (ticket
/// window-virtual-desktop). 그룹마다 open_group_in 의 창 배분 규칙을 그대로 탄다: 첫 그룹이 이 창(전부
/// 빈 탭일 때)을 재사용하면 그다음 그룹부터는 이 창이 비어 있지 않으므로 자연히 새 창이 된다.
/// desktop 이 오면(체크박스 "Open each on its virtual desktop") Windows 에서 그 창을 그 순번의 가상
/// 데스크톱으로 옮긴다 — 재사용한 이 창도 옮긴다. 사용자를 전환시키지는 않는다(창만 각자 자리로).
/// 그룹 하나의 실패(전부 열려 있음·소실)는 로그만 남기고 다음으로 — 하나도 못 열었을 때만 Err
#[tauri::command]
async fn open_groups(app: tauri::AppHandle, window: tauri::WebviewWindow, groups: Vec<GroupSpec>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let from = window.label().to_string();
    let mut opened = 0usize;
    let mut last_err: Option<String> = None;
    for g in &groups {
        match open_group_in(&app, &state, &from, &g.roots) {
            Ok(label) => {
                opened += 1;
                #[cfg(windows)]
                if let Some(n) = g.desktop {
                    if let Some(w) = app.get_webview_window(&label) {
                        vdesk::place(&w, n);
                    }
                }
                #[cfg(not(windows))]
                let _ = (label, g.desktop);
            }
            Err(e) => {
                eprintln!("superlite: 그룹 건너뜀 ({:?}): {e}", g.roots);
                last_err = Some(e);
            }
        }
    }
    emit_sessions(&app, &state);
    if opened == 0 {
        return Err(last_err.unwrap_or_else(|| "열 그룹이 없다".into()));
    }
    Ok(())
}

/// open_groups 의 그룹 하나 — roots 와 목표 가상 데스크톱 순번(1부터, None 이면 옮기지 않음)
#[derive(serde::Deserialize)]
struct GroupSpec {
    roots: Vec<String>,
    desktop: Option<u32>,
}

/// 그룹 열기 본체 — open_group·open_groups 가 공유. 반환은 그룹이 열린 창 label (from 재사용 또는 새 창).
/// 방송(emit_sessions)은 호출자가 한다 — open_groups 는 여러 그룹을 등록한 뒤 한 번만 방송한다
fn open_group_in(app: &tauri::AppHandle, state: &AppState, from: &str, roots: &[String]) -> Result<String, String> {
    let from = main_label(state, from);
    let parsed: Vec<PathBuf> = roots.iter().filter_map(|r| parse_root(r).ok()).collect();
    if parsed.is_empty() {
        return Err("열 수 있는 폴더가 없다".into());
    }
    for r in &parsed {
        remember_recent(state, r);
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
            return Err("그룹의 폴더가 모두 이미 열려 있다".into());
        }
        let label = if here_nonempty {
            new_window_label(state)
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
        if let Err(e) = build_window(app, state, &label, None, None, zoom_of(state, &from)) {
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
    Ok(label)
}

/// 가상 데스크톱 배치 (Windows 전용, ticket window-virtual-desktop). 공개 COM IVirtualDesktopManager 만
/// 쓴다 — 창의 데스크톱 조회(GetWindowDesktopId)와 이동(MoveWindowToDesktop). 데스크톱 열거·전환·생성은
/// 비공개 인터페이스(빌드마다 IID 가 바뀜)라 쓰지 않고, 순번 → GUID 는 탐색기가 로그온마다 같은 값으로
/// 데스크톱을 재생성하는 레지스트리 VirtualDesktopIDs(16바이트 GUID 나열)를 읽어 얻는다.
/// WHY: COM 호출은 전용 스레드에서 — Chromium 도 UI 스레드의 중첩 메시지 루프를 피하려 별도 스레드로
///      돌린다. 실패는 전부 로그만 (배치가 앱을 죽이면 안 된다)
#[cfg(windows)]
mod vdesk {
    use windows::core::{w, GUID};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_BINARY};
    use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

    /// 순번(1부터) → 데스크톱 GUID. 그 순번의 데스크톱이 없으면 None
    fn desktop_id(n: u32) -> Option<GUID> {
        let key = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops");
        let val = w!("VirtualDesktopIDs");
        let mut size: u32 = 0;
        let mut buf: Vec<u8>;
        unsafe {
            if RegGetValueW(HKEY_CURRENT_USER, key, val, RRF_RT_REG_BINARY, None, None, Some(&mut size)).is_err() {
                return None;
            }
            buf = vec![0u8; size as usize];
            if RegGetValueW(
                HKEY_CURRENT_USER,
                key,
                val,
                RRF_RT_REG_BINARY,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
            .is_err()
            {
                return None;
            }
            buf.truncate(size as usize);
        }
        let i = (n.checked_sub(1)? as usize).checked_mul(16)?;
        let b = buf.get(i..i + 16)?;
        // 레지스트리는 GUID 를 메모리 배치 그대로(앞 세 필드 리틀엔디언) 둔다
        Some(GUID::from_values(
            u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            u16::from_le_bytes([b[4], b[5]]),
            u16::from_le_bytes([b[6], b[7]]),
            b[8..16].try_into().ok()?,
        ))
    }

    /// 전용 스레드에서 COM 을 열고 매니저로 f 를 실행. HWND 는 Send 가 아니라 호출자가 isize 로 넘긴다
    fn with_manager<R: Send + 'static>(
        f: impl FnOnce(&IVirtualDesktopManager) -> windows::core::Result<R> + Send + 'static,
    ) -> Result<R, String> {
        std::thread::spawn(move || unsafe {
            let init = CoInitializeEx(None, COINIT_MULTITHREADED);
            let r = CoCreateInstance::<_, IVirtualDesktopManager>(&VirtualDesktopManager, None, CLSCTX_ALL)
                .and_then(|m| f(&m))
                .map_err(|e| e.to_string());
            if init.is_ok() {
                CoUninitialize();
            }
            r
        })
        .join()
        .map_err(|_| "COM 스레드 패닉".to_string())?
    }

    /// 창을 n 번(1부터) 가상 데스크톱으로 옮긴다. 그 순번의 데스크톱이 없으면 현재 데스크톱에 남기고 로그만
    pub fn place(window: &tauri::WebviewWindow, n: u32) {
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = hwnd.0 as isize;
        let label = window.label().to_string();
        let Some(id) = desktop_id(n) else {
            eprintln!("superlite: 가상 데스크톱 {n} 없음 — {label} 은 현재 데스크톱에 남긴다");
            return;
        };
        if let Err(e) = with_manager(move |m| unsafe { m.MoveWindowToDesktop(HWND(hwnd as *mut _), &id) }) {
            eprintln!("superlite: 가상 데스크톱 {n} 이동 실패 ({label}): {e}");
        }
    }

    /// 새 창을 출처 창과 같은 가상 데스크톱으로 — 분리 창(detach_session·detach_tabs)이 출처를 따라간다.
    /// OS 기본도 "보고 있는 데스크톱에 생성" 이라 대개 이미 같지만 명시적으로 맞춘다. 출처가 어느
    /// 데스크톱에도 없으면(GUID 0) 그대로 둔다
    pub fn follow(app: &tauri::AppHandle, from: &str, window: &tauri::WebviewWindow) {
        use tauri::Manager;
        let Some(src) = app.get_webview_window(from).and_then(|w| w.hwnd().ok()) else { return };
        let Ok(dst) = window.hwnd() else { return };
        let (src, dst) = (src.0 as isize, dst.0 as isize);
        let label = window.label().to_string();
        if let Err(e) = with_manager(move |m| unsafe {
            let id = m.GetWindowDesktopId(HWND(src as *mut _))?;
            if id == GUID::zeroed() {
                return Ok(());
            }
            m.MoveWindowToDesktop(HWND(dst as *mut _), &id)
        }) {
            eprintln!("superlite: 분리 창 데스크톱 맞추기 실패 ({label}): {e}");
        }
    }
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

/// 두 번째 실행의 인자 → 열 root. argv[1] 이 있으면 그 경로(상대 경로는 두 번째 프로세스의 cwd
/// 기준 — join 은 절대 경로 인자를 그대로 쓴다), 없으면 None = 시작 페이지(빈 세션).
/// 종전(~2026-09-08)에는 인자 없는 실행이 cwd 를 열었다 — 직접 재실행은 첫 기동과 같은 시작
/// 페이지여야 하므로 버렸다 (ticket app-second-launch)
fn second_launch_root(argv: &[String], cwd: &str) -> Option<PathBuf> {
    argv.get(1).map(|arg| PathBuf::from(cwd).join(arg))
}

/// 두 번째 실행 수신 (single-instance) — 새 메인 창을 만들어 argv 의 폴더를 열고, 인자가 없으면
/// 시작 페이지(빈 세션)를 연다 (2026-09-09 사용자 결정, ticket app-second-launch — 종전에는
/// 마지막으로 포커스된 창에 세션 탭을 더했다). 기존 창은 건드리지 않는다. app-installer 의
/// "Superlite로 열기"·직접 재실행이 이 경로를 탄다. 같은 폴더가 이미 열려 있으면 새 창 대신
/// 그 창을 앞으로 가져온다 (open_workspace 와 같은 규칙). 새 창은 저장된 세션을 복원하지 않고
/// 인자 폴더만 연다. 위치·크기는 기본 (build_window).
/// WHY: 창 생성은 이 콜백 밖 스레드에서 — Windows 의 single-instance 콜백은 메인 스레드의
///      WndProc(WM_COPYDATA) 안에서 불린다. 창 생성은 async 커맨드에서만 검증됐고 메인 스레드의
///      동기 컨텍스트 안 build() 는 교착이 실측된 경로라(build_window 주석) 같은 방식으로 뺀다
fn open_second_instance(app: &tauri::AppHandle, argv: Vec<String>, cwd: String) {
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    // 경로 오류는 로그만 — 두 번째 실행의 잘못된 인자가 기존 앱을 죽이면 안 된다
    let root = match second_launch_root(&argv, &cwd) {
        Some(p) => match p.canonicalize() {
            Ok(p) => Some(superlite_common::plain(p)),
            Err(e) => {
                eprintln!("superlite: 두 번째 실행 경로 확인 실패: {e}");
                return;
            }
        },
        None => None,
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        if let Some(root) = &root {
            remember_recent(&state, root);
        }
        let label = {
            let mut list = state.sessions.lock().unwrap();
            let mut windows = state.windows.lock().unwrap();
            if let Some((id, owner)) = root.as_deref().and_then(|r| find_open(&list, &windows, r)) {
                drop(windows);
                drop(list);
                focus_session(&app, &owner, &id);
                return;
            }
            let label = new_window_label(&state);
            push_session(&mut list, &mut windows, &label, root);
            label
        };
        let zoom = state.persisted.lock().unwrap().zoom;
        match build_window(&app, &state, &label, None, None, zoom) {
            Ok(w) => {
                let _ = w.set_focus();
            }
            Err(e) => {
                eprintln!("superlite: 두 번째 실행 창 생성 실패: {e}");
                // 롤백 — 생기지 않은 창 소속으로 세션이 남지 않게 (Destroyed 는 오지 않는다)
                drop_window(&app, &state, &label);
            }
        }
        emit_sessions(&app, &state);
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
            ensure_mirror,
            set_active_session,
            boot_info,
            list_subs,
            forward,
            take_handoff,
            list_windows,
            list_recents,
            forget_recent,
            set_pinned,
            open_group,
            open_groups,
            set_zoom,
            set_ime,
            ime_probe,
            get_workspace_state,
            set_workspace_state,
            set_workspace_sub_state,
            get_workspace_sub_state,
            reload_window,
            pick_save_target,
            confirm_dialog,
            local_write,
            local_mkdir,
            reveal_in_folder,
            open_url,
            open_externally_target,
            open_externally
        ])
        // 창 닫힘(X·close_if_empty) = 그 창의 세션만 정리 (메인 창이면 서브 창도 함께 닫는다)
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::Destroyed => {
                    let state = app.state::<AppState>();
                    drop_window(app, &state, window.label());
                }
                // 포커스 순서 — restoreWindows one 이 고르는 "마지막 창". 서브 창 포커스는 소속 메인의 것
                tauri::WindowEvent::Focused(true) => {
                    let state = app.state::<AppState>();
                    let main = main_label(&state, window.label());
                    let changed = {
                        let mut f = state.focus.lock().unwrap();
                        if f.first() == Some(&main) {
                            false
                        } else {
                            f.retain(|l| l != &main);
                            f.insert(0, main);
                            true
                        }
                    };
                    if changed {
                        sync_open(&state);
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            // 지난 실행의 "Open Externally" 사본 정리 — 외부 앱이 아직 연 파일은 못 지우므로 무시
            let _ = std::fs::remove_dir_all(open_externally_dir());
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
            // 기동 때 한 번 state.json.bak 으로 사본 — 워크스페이스 복원 문제를 조사할 때 "지난 실행이 남긴
            // 저장본" 이 이번 실행의 첫 저장에 덮이지 않게 (ticket term-restore-observe: 재실행 뒤 받은
            // state.json 은 이미 갱신된 뒤라 증거가 되지 못했다). 실패는 무시 — 진단용
            if let Some(p) = &state_file {
                if p.exists() {
                    let _ = std::fs::copy(p, p.with_extension("json.bak"));
                }
            }
            let persisted = load_state(state_file.as_deref());
            // 비정상 종료 복원 — 지난 실행의 열린 창 목록이 남아 있으면 설정대로. argv 폴더가 있으면 그것만 연다
            let restore = if cli_root.is_some() { Vec::new() } else { restorable(&persisted.open, &restore_mode()) };
            app.manage(AppState {
                ws_url,
                sessions,
                windows: Mutex::default(),
                handoffs: Mutex::default(),
                groups: Mutex::default(),
                zooms: Mutex::default(),
                focus: Mutex::default(),
                next_window: AtomicUsize::new(0),
                persisted: Mutex::new(persisted),
                state_file,
            });
            let state = app.state::<AppState>();
            // 초기 세션 등록 — 창을 만들기 전에 끝내야 주입 목록이 완전하다. 되살리는 창은 첫 것이 main,
            // 나머지는 w1… (포커스 최근 순이라 첫 것이 마지막 포커스 창)
            let mut labels = vec![MAIN_WINDOW.to_string()];
            {
                let mut list = state.sessions.lock().unwrap();
                let mut windows = state.windows.lock().unwrap();
                let mut groups = state.groups.lock().unwrap();
                for root in roots {
                    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다
                    let root = superlite_common::plain(root);
                    remember_recent(&state, &root);
                    push_session(&mut list, &mut windows, MAIN_WINDOW, Some(root));
                }
                for (i, w) in restore.iter().enumerate() {
                    let label = if i == 0 { MAIN_WINDOW.to_string() } else { new_window_label(&state) };
                    for (j, root) in w.roots.iter().enumerate() {
                        let id = push_session(&mut list, &mut windows, &label, Some(root.clone()));
                        if w.active == Some(j) {
                            groups.active.insert(label.clone(), id);
                        }
                    }
                    if i > 0 {
                        labels.push(label);
                    }
                }
                if list.is_empty() {
                    push_session(&mut list, &mut windows, MAIN_WINDOW, None);
                }
            }
            let zoom = state.persisted.lock().unwrap().zoom;
            for label in &labels {
                build_window(app.handle(), &state, label, None, None, zoom)?;
            }
            sync_open(&state);
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
    fn second_launch_root_arg_or_start_page() {
        let cwd = if cfg!(windows) { "C:\\work" } else { "/work" };
        // 인자 없음 = 시작 페이지 (cwd 를 열지 않는다)
        assert_eq!(second_launch_root(&["superlite".into()], cwd), None);
        // 상대 경로는 cwd 기준, 절대 경로는 그대로
        assert_eq!(
            second_launch_root(&["superlite".into(), "proj".into()], cwd),
            Some(PathBuf::from(cwd).join("proj"))
        );
        let abs = if cfg!(windows) { "D:\\x" } else { "/x" };
        assert_eq!(second_launch_root(&["superlite".into(), abs.into()], cwd), Some(PathBuf::from(abs)));
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
    fn normalize_pinned_dedups_and_drops_empty() {
        let g = normalize_pinned(vec![
            PinGroup { alias: Some("  ".into()), roots: paths(&["/a", "/b", "/a"]) },
            PinGroup { alias: None, roots: Vec::new() },
            PinGroup { alias: Some(" x ".into()), roots: paths(&["/c"]) },
        ]);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0], PinGroup { alias: None, roots: paths(&["/a", "/b"]) });
        assert_eq!(g[1], PinGroup { alias: Some("x".into()), roots: paths(&["/c"]) });
        assert!(is_pinned(&g, Path::new("/c")));
        assert!(!is_pinned(&g, Path::new("/z")));
    }

    #[test]
    fn state_roundtrip_and_version_gate() {
        let path = std::env::temp_dir().join(format!("superlite-test-{}.json", rand_hex()));
        let p = Persisted {
            version: 2,
            recents: paths(&["/a"]),
            pinned: vec![PinGroup { alias: Some("g".into()), roots: paths(&["/a", "/b"]) }],
            zoom: 2,
            ..Default::default()
        };
        save_state(Some(&path), &p);
        let back = load_state(Some(&path));
        assert_eq!(back.recents, p.recents);
        assert_eq!(back.pinned, p.pinned);
        assert_eq!(back.zoom, 2);
        // zoom·pinned 필드가 없는 기존 version 2 파일은 기본값, 옛 bundles 는 무시 (필드 추가가
        // version 을 올리지 않는다)
        std::fs::write(&path, r#"{"version":2,"recents":["/a"],"bundles":[["/a","/b"]]}"#).unwrap();
        assert_eq!(load_state(Some(&path)).zoom, 0);
        assert!(load_state(Some(&path)).pinned.is_empty());
        std::fs::write(&path, r#"{"version":1,"workspaces":[{"root":"/a"}]}"#).unwrap();
        assert!(load_state(Some(&path)).recents.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn restorable_follows_mode_and_drops_missing_roots() {
        let tmp = std::env::temp_dir();
        let gone = tmp.join("superlite-test-no-such-dir-xyz");
        let open = vec![
            OpenWindow { roots: vec![gone.clone(), tmp.clone(), PathBuf::from("ssh://h/x")], active: Some(1) },
            OpenWindow { roots: vec![tmp.clone()], active: None },
            OpenWindow { roots: vec![gone.clone()], active: Some(0) },
        ];
        assert!(restorable(&open, "none").is_empty());
        let one = restorable(&open, "one");
        assert_eq!(one, vec![OpenWindow { roots: vec![tmp.clone(), PathBuf::from("ssh://h/x")], active: Some(0) }]);
        let all = restorable(&open, "all");
        assert_eq!(all.len(), 2, "root 가 하나도 안 남은 창은 뺀다");
        assert_eq!(all[1], OpenWindow { roots: vec![tmp], active: None });
        assert!(restorable(&open, "bogus").is_empty());
    }

    #[test]
    fn zoom_steps_and_clamps() {
        assert_eq!(step_zoom(0, "in"), 1);
        assert_eq!(step_zoom(0, "out"), -1);
        assert_eq!(step_zoom(5, "reset"), 0);
        assert_eq!(step_zoom(ZOOM_MAX, "in"), ZOOM_MAX);
        assert_eq!(step_zoom(-ZOOM_MAX, "out"), -ZOOM_MAX);
        assert_eq!(step_zoom(3, "bogus"), 3);
        assert_eq!(zoom_factor(0), 1.0);
        assert!((zoom_factor(1) - 1.2).abs() < 1e-9);
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
