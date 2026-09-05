//! 연결별 파일 감시 — root 재귀 inotify, 75ms 집계·경로별 coalesce, 상한 초과 시 overflow 강등.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// 워처 슬롯 — 등록(트리 walk)이 blocking 태스크에서 끝나면 여기 담긴다.
/// 연결 종료로 이 Arc 가 떨어지면 워처(및 집계 태스크)도 함께 정리된다.
pub(crate) type WatcherSlot = Arc<Mutex<Option<notify::RecommendedWatcher>>>;

/// 워처 이벤트 배치 상한 — 넘으면 경로 나열 대신 overflow(전체 리프레시 신호)로 강등.
/// 대량 변경(브랜치 전환 등)은 경로를 다 나르는 것보다 전체 리프레시가 싸다.
const WATCH_BATCH_CAP: usize = 1_000;

/// root 재귀 감시 시작. 이벤트는 75ms 집계·경로별 coalesce 후 fsChanges 로 tx 에 푸시.
/// 등록이 끝나면 워처를 slot 에 담는다 — slot 이 drop 되면 감시·집계 태스크가 함께 끝난다.
/// 심링크는 따라가지 않는다 (attach root 봉쇄와 일관 — 루트 밖 경로가 이벤트로 새지 않게).
/// ponytail: 재귀 watch 는 제외 없이 전부 inotify 에 등록한다 — 거대 node_modules 에서
///           watch 한도(fs.inotify.max_user_watches) 고갈 가능. 워처는 연결(attach) 단위라
///           같은 폴더를 연 창이 N 개면 등록도 N 배다 (다중 창 이후). 문제되면 디렉터리
///           단위 비재귀 watch + 제외 목록으로 전환.
pub(crate) fn start_watcher(root: PathBuf, tx: UnboundedSender<String>, slot: WatcherSlot) {
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
            let rel = crate::wire_rel(&rel.to_string_lossy());
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
