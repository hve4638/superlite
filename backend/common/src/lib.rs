//! 백엔드·데몬이 공유하는 IPC 주소. 두 쪽이 어긋나면 백엔드가 데몬을 무한 재기동하므로
//! 한 곳에 둔다.

use std::path::{Path, PathBuf};

/// 데몬 IPC 주소 — unix 는 unix socket 경로, Windows 는 named pipe 이름. `build` 는 데몬 빌드 식별
/// (build_id) — 주소에 들어가므로 백엔드는 항상 제 빌드의 데몬에만 붙고, 빌드가 다른 상주 데몬은
/// 제 주소에서 기존 클라이언트를 계속 섬기다 수명 규칙대로 자진 종료한다 (ticket update-compat).
/// 죽이는 절차는 없다 — tmux 서버는 데몬 밖이라 터미널은 빌드가 바뀌어도 이어진다.
pub fn socket_path(build: &str) -> PathBuf {
    if let Ok(p) = std::env::var("SUPERLITE_SOCK") {
        return PathBuf::from(p); // 테스트·개발용 우회 — 검증 없음
    }
    ipc_path(build)
}

/// 데몬 빌드 식별 — 데몬 바이너리 내용의 FNV-1a 64 (16진 16자). 원격 헬퍼 폴더
/// `$HOME/.cache/<SLUG>/bin/<id>/` 의 이름과 같은 값이라 "어느 빌드가 도는가" 의 키 하나로 IPC
/// 주소·락·헬퍼 캐시가 묶인다. 커밋 해시(-dirty 가 전부 같다)·빌드 시각(build.rs 는 HEAD 변경 때만
/// 다시 돈다)이 아니라 내용 해시인 이유다. 데몬은 자기 실행 파일로, 백엔드는 spawn 할 데몬
/// 바이너리로 계산한다 — 두 값이 같아야 접속이 된다.
///
/// 종전(~2026-09-09)에는 주소가 WIRE_VERSION(프로토콜 번호, 마지막 19)으로만 갈렸다 — 프로토콜이
/// 그대로인 데몬 수정은 상주 데몬이 살아 있는 한 배포되지 않았다 (0.2.2 실사용 사고). 와이어
/// 이력 주석은 그 시점 git 이력의 이 파일에 있다. 프론트·백엔드·데몬은 한 빌드로 배포되므로
/// 프로토콜 번호를 대조할 상대가 없어 상수 자체를 없앴다.
pub fn build_id(bin: &Path) -> std::io::Result<String> {
    Ok(format!("{:016x}", fnv64(&std::fs::read(bin)?)))
}

/// FNV-1a 64 — 빌드 식별·배치 디렉터리 키용 내용 해시. 비적대적 용도(캐시 무효화)라 충분하고
/// 의존성이 없다
pub fn fnv64(data: &[u8]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for &b in data {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// 릴리스 버전 — 루트 Cargo.toml `[workspace.package] version` 하나에서 온다 (crate 4개가 상속).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 빌드된 git 커밋 (짧은 해시, 미커밋 변경 시 `-dirty`, git 부재 시 `unknown`) — build.rs 가 굽는다
pub const COMMIT: &str = env!("SUPERLITE_COMMIT");
/// 빌드 시각 (UTC ISO-8601) — build.rs 가 굽는다
pub const BUILT_AT: &str = env!("SUPERLITE_BUILT_AT");
/// 릴리스 채널 — build.rs 가 `SUPERLITE_CHANNEL` 로 굽는다. 빈 문자열이 stable. dev·stable
/// 설치본이 한 PC 에 공존하도록 이름이 고정된 자원을 채널별로 가르는 근거 (ticket
/// release-channel). 앱 쪽 이름(설치 폴더·identifier·exe)은 app/tauri.<channel>.conf.json 이 같은
/// 채널로 가른다 — build.sh --channel 이 둘을 함께 준다
pub const CHANNEL: &str = env!("SUPERLITE_CHANNEL");
/// 이름이 고정된 자원의 이름 줄기 — stable `superlite`, 그 외 `superlite-<channel>`. IPC 폴더·
/// 파이프·캐시·설정 폴더(relay remote.json)·원격 헬퍼 폴더가 전부 이걸 쓴다
pub const SLUG: &str = env!("SUPERLITE_SLUG");

/// 내장 tmux 기본 설정 (tmux-base.conf) — 데몬이 프로필 없이 뜰 때의 설정이자, relay 가 편집기 탭에
/// 읽기 전용 `default` 프로필로 보이고 새 프로필의 템플릿으로 복사하는 원문 (ticket config-editors)
pub const TMUX_BASE_CONF: &str = include_str!("tmux-base.conf");

/// `--version` 한 줄 — 데몬·백엔드가 같은 표기를 쓴다 (헬퍼 업로드 로그·버그 리포트용).
/// 예: `superlite-daemon 0.1.0 (8700a11f2, built 2026-09-06T05:00:00Z)`,
/// dev 채널은 `superlite-daemon 0.1.0 dev (…)`
pub fn version_line(bin: &str) -> String {
    let ch = if CHANNEL.is_empty() { String::new() } else { format!(" {CHANNEL}") };
    format!("{bin} {VERSION}{ch} ({COMMIT}, built {BUILT_AT})")
}

/// 0700 전용 IPC 디렉터리 `<runtime>/<SLUG>-<user>` — 데몬 소켓·락·pid 파일과 relay 의 ssh
/// ControlMaster 소켓이 산다. SUPERLITE_SOCK 우회 시 그 파일의 디렉터리
#[cfg(unix)]
pub fn ipc_dir() -> PathBuf {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if let Ok(p) = std::env::var("SUPERLITE_SOCK") {
        return PathBuf::from(p).parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/tmp"));
    }
    let base = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    let dir = base.join(format!("{SLUG}-{user}"));
    let mut b = std::fs::DirBuilder::new();
    b.mode(0o700);
    let _ = b.create(&dir); // 이미 있으면 무시 — 아래 권한 검사가 방어한다
    // WHY: /tmp fallback 은 world-writable — 남이 선점했거나 열린 디렉터리면 소켓 하이재킹
    //      (가짜 데몬에 파일·터미널 전부 노출)이 가능하다. 조용히 넘어가지 않고 죽는다.
    let mode = std::fs::metadata(&dir).map(|m| m.permissions().mode()).unwrap_or(0);
    assert!(mode & 0o077 == 0, "IPC 디렉터리 권한 이상 (0700 이어야 한다): {}", dir.display());
    dir
}

/// 소켓 파일은 IPC 디렉터리 밑 `daemon-<build>.sock`. 파일명 줄기 "daemon" 은 daemon
/// clean.rs(clean_other_builds)가 다른 빌드의 락 파일을 고르는 접두이기도 하다 — 바꾸면 그쪽도 같이.
#[cfg(unix)]
fn ipc_path(build: &str) -> PathBuf {
    ipc_dir().join(format!("daemon-{build}.sock"))
}

/// named pipe 는 파일시스템 밖 네임스페이스 — 디렉터리·권한 준비가 없다.
/// ponytail: 파이프 이름 네임스페이스는 머신 전역이라, 다른 로컬 사용자가 이 이름을 먼저
///           만들어 두는 선점(가짜 데몬)은 못 막는다 — unix 의 0700 디렉터리와 등가가 아니고,
///           단일 사용자 PC 전제로 수용한다. 공유 머신 대응 시 relay 접속부에 서버 프로세스
///           SID 검증(GetNamedPipeServerProcessId)을 추가한다.
#[cfg(windows)]
fn ipc_path(build: &str) -> PathBuf {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    PathBuf::from(format!(r"\\.\pipe\{SLUG}-{user}-{build}"))
}

/// 데몬 단독 보장용 락 파일 경로 — IPC 주소에서 파생해 SUPERLITE_SOCK 우회가 락에도
/// 전파된다 (우회가 격리 인스턴스를 만드는 계약 — check 하니스가 기댄다).
pub fn lock_path(sock: &Path) -> PathBuf {
    #[cfg(unix)]
    return sock.with_extension("lock");
    #[cfg(windows)]
    {
        // pipe 이름은 파일 경로가 아니다 — 평탄화해 %TEMP% 밑 락 파일로.
        // %TEMP% 는 대화형 사용자별 디렉터리다 (서비스 컨텍스트는 MVP 밖)
        let key = sock.to_string_lossy().replace(['\\', '/', ':'], "_");
        std::env::temp_dir().join(format!("superlite-{key}.lock"))
    }
}

/// 락 파일 열기 — 데몬 기동(acquire_lock)과 `--clean` 의 보유자 탐지(try_lock)가 같은 규칙.
/// truncate(false) 가 계약: 락을 쥐지 못한 쪽이 열기만으로 내용을 비우면 안 된다
pub fn open_lock_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create(true).truncate(false).open(path)
}

/// 이 머신의 superlite 설정 디렉터리 — unix `$XDG_CONFIG_HOME|~/.config`/<SLUG>, Windows
/// `%APPDATA%`/<SLUG>. relay 의 remote.json 과 클라이언트 tmux.conf 가 산다 (채널별 분리)
pub fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    Some(base?.join(SLUG))
}

/// 이 머신의 superlite 캐시 디렉터리 `$HOME/.cache/<SLUG>` (stable 은 superlite) — 헬퍼
/// 배치(bin/)와 데몬 로그가 산다. 원격 셸이 해석하는 같은 경로 문자열은 relay ssh.rs 가 따로 든다
pub fn cache_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".cache").join(SLUG))
}

/// 데몬 로그 파일 `$HOME/.cache/<SLUG>/daemon.log` (append) — 데몬을 띄우는 쪽(relay
/// spawn_daemon 의 Windows 경로, 원격 헬퍼 spawn_self_daemon)이 stderr 로 물린다. unix 의 relay 는
/// stderr 를 상속시킨다. 실패면 None (호출측이 null 로)
pub fn daemon_log_file() -> Option<std::fs::File> {
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().append(true).create(true).open(dir.join("daemon.log")).ok()
}

/// 락 보유 데몬의 pid 파일 — 락 파일과 나란히 (`daemon-<build>.pid`). 락을 쥔 쪽만 쓴다.
/// WHY: 락 파일 자체에 pid 를 적지 않는다 — Windows 의 배타 락(LockFileEx)은 다른 프로세스의
///      읽기까지 막아 `--clean` 이 보유자를 알 수 없고, unix 는 락 없이 열어도 되지만 두
///      플랫폼이 한 규칙을 쓰는 쪽이 낫다. 락 없이 열리는 별도 파일이면 어느 쪽에서든 읽힌다
pub fn pid_path(sock: &Path) -> PathBuf {
    lock_path(sock).with_extension("pid")
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
