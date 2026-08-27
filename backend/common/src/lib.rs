//! 백엔드·데몬이 공유하는 IPC 주소. 두 쪽이 어긋나면 백엔드가 데몬을 무한 재기동하므로
//! 한 곳에 둔다.

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;

/// 데몬 unix socket 경로. 0700 전용 디렉터리를 만들어 그 안에 둔다.
/// ponytail: unix 전용 — Windows 는 named pipe `\\.\pipe\superlight-<사용자>` 로 분기 예정
/// (_docs/decision/process-topology.md).
pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("SUPERLIGHT_SOCK") {
        return PathBuf::from(p); // 테스트·개발용 우회 — 검증 없음
    }
    let base = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    let dir = base.join(format!("code-superlight-{user}"));
    let mut b = std::fs::DirBuilder::new();
    b.mode(0o700);
    let _ = b.create(&dir); // 이미 있으면 무시 — 아래 권한 검사가 방어한다
    // WHY: /tmp fallback 은 world-writable — 남이 선점했거나 열린 디렉터리면 소켓 하이재킹
    //      (가짜 데몬에 파일·터미널 전부 노출)이 가능하다. 조용히 넘어가지 않고 죽는다.
    let mode = std::fs::metadata(&dir).map(|m| m.permissions().mode()).unwrap_or(0);
    assert!(mode & 0o077 == 0, "IPC 디렉터리 권한 이상 (0700 이어야 한다): {}", dir.display());
    dir.join("daemon.sock")
}
