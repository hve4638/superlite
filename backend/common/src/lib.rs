//! 백엔드·데몬이 공유하는 IPC 주소. 두 쪽이 어긋나면 백엔드가 데몬을 무한 재기동하므로
//! 한 곳에 둔다.

use std::path::{Path, PathBuf};

/// 데몬 IPC 주소 — unix 는 unix socket 경로, Windows 는 named pipe 이름.
pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("SUPERLIGHT_SOCK") {
        return PathBuf::from(p); // 테스트·개발용 우회 — 검증 없음
    }
    ipc_path()
}

/// 데몬 와이어 버전 — 데몬 메서드 추가·의미 변경 시 올린다. IPC 주소에 들어가므로 와이어가
/// 다른 빌드의 백엔드는 구버전 상주 데몬에 붙지 못하고 제 빌드의 데몬을 띄운다 (구 데몬은
/// 제 주소에서 기존 백엔드를 계속 섬기다 수명 규칙대로 자진 종료).
/// 2: browseDir 추가 — 구버전 상주 데몬이 unknown method 를 돌려줘 웹 폴더 열기 자동완성이
///    조용히 빈 결과("No matching results")로 빠졌다.
/// 3: readFile 이 크기 초과·이진(비 UTF-8)을 에러 대신 구조화된 unopenable 로 반환 —
///    구버전 프론트는 content 없는 성공 응답을 텍스트로 오해하므로 의미 변경이다.
const WIRE_VERSION: u32 = 3;

/// 0700 전용 디렉터리를 만들어 그 안에 소켓을 둔다.
#[cfg(unix)]
fn ipc_path() -> PathBuf {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
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
    dir.join(format!("daemon-{WIRE_VERSION}.sock"))
}

/// named pipe 는 파일시스템 밖 네임스페이스 — 디렉터리·권한 준비가 없다.
/// ponytail: 파이프 이름 네임스페이스는 머신 전역이라, 다른 로컬 사용자가 이 이름을 먼저
///           만들어 두는 선점(가짜 데몬)은 못 막는다 — unix 의 0700 디렉터리와 등가가 아니고,
///           단일 사용자 PC 전제로 수용한다. 공유 머신 대응 시 relay 접속부에 서버 프로세스
///           SID 검증(GetNamedPipeServerProcessId)을 추가한다.
#[cfg(windows)]
fn ipc_path() -> PathBuf {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    PathBuf::from(format!(r"\\.\pipe\superlight-{user}-{WIRE_VERSION}"))
}

/// 데몬 단독 보장용 락 파일 경로 — IPC 주소에서 파생해 SUPERLIGHT_SOCK 우회가 락에도
/// 전파된다 (우회가 격리 인스턴스를 만드는 계약 — check 하니스가 기댄다).
pub fn lock_path(sock: &Path) -> PathBuf {
    #[cfg(unix)]
    return sock.with_extension("lock");
    #[cfg(windows)]
    {
        // pipe 이름은 파일 경로가 아니다 — 평탄화해 %TEMP% 밑 락 파일로.
        // %TEMP% 는 대화형 사용자별 디렉터리다 (서비스 컨텍스트는 MVP 밖)
        let key = sock.to_string_lossy().replace(['\\', '/', ':'], "_");
        std::env::temp_dir().join(format!("code-superlight-{key}.lock"))
    }
}

/// Windows 의 canonicalize 는 verbatim(`\\?\C:\...`) 경로를 준다 — verbatim 은 Win32 경로
/// 파싱('/'→'\' 변환 포함)을 통째로 꺼서, '/' 구분 와이어 상대경로와 join 하면
/// ERROR_INVALID_NAME 이 되고 자식 프로세스 cwd 로도 못 쓴다. 드라이브 경로만 벗긴다.
/// ponytail: UNC(`\\?\UNC\...`) 루트는 형태가 달라 그대로 둔다 — MVP 범위 밖.
pub fn plain(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.as_bytes().get(1) == Some(&b':') {
                return PathBuf::from(rest.to_string());
            }
        }
    }
    p
}
