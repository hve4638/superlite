//! 백엔드·데몬이 공유하는 IPC 주소. 두 쪽이 어긋나면 백엔드가 데몬을 무한 재기동하므로
//! 한 곳에 둔다.

use std::path::{Path, PathBuf};

/// 데몬 IPC 주소 — unix 는 unix socket 경로, Windows 는 named pipe 이름.
pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("SUPERLITE_SOCK") {
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
/// 4: writeFile 에 encoding='base64' 추가 — 구버전 데몬은 미지 파라미터를 무시하고 base64
///    문자열을 텍스트로 그대로 써서 이미지 저장이 조용히 깨진다.
/// 5: readFile 에 encoding='base64' 추가 (writeFile 과 대칭) — 구버전 데몬은 미지 파라미터를
///    무시하고 UTF-8 검증으로 이진을 unopenable 로 돌려줘 이미지 뷰어가 조용히 안내 화면으로
///    빠진다.
/// 6: 대형 payload 바이너리 프레임 — daemon→relay 에 0x00 매직+길이 접두 프레임 추가,
///    relay 가 WS 바이너리로 재프레이밍, readFile 대형 응답이 JSON 대신 이 통로를 탄다
///    (텍스트는 deflate-raw 압축). 구버전 relay 는 0x00 프레임을 줄로 오독해 연결이 깨진다.
/// 7: attach 에 watch=false 추가 (탐색 전용 attach — 재귀 워처 생략). 구버전 데몬은 미지
///    파라미터를 무시하고 원격 홈 전체에 워처를 걸어 빈 원격 세션이 조용히 무거워진다.
/// 8: SCM 스테이징 — gitStage/gitUnstage/gitDiscard/gitLog/gitBranches/gitCheckout 추가,
///    gitCommit 이 인덱스만 커밋, gitStatus 항목에 staged 플래그. 구버전 데몬은 새 메서드를
///    unknown 으로 삼키고 gitCommit 이 전체 스테이징으로 동작해 부분 커밋이 조용히 깨진다.
/// 9: 데몬→프론트 요청 통로 — 소켓 요청자의 frontRequest 를 세션 프론트에 request 이벤트로
///    전달하고 requestReply 로 응답을 되돌린다 + PTY 에 SUPERLITE_SOCK·SUPERLITE_SESSION 주입.
///    구버전 데몬은 frontRequest 를 attach 전 요청으로 거부하고 환경변수도 없어 셸 심이 조용히
///    실패한다.
/// 10: adoptTerminal 추가 — 같은 root 의 다른 세션이 소유한 터미널을 이 세션으로 옮긴다
///    (탭을 다른 창으로 끌어 옮기기). 구버전 데몬은 미지 메서드를 일반 경로로 넘겨 에러로
///    응답하므로 이동이 조용히 실패한다.
/// 11: readFile 범위 읽기(offset, encoding=base64 전용 — 크기 상한을 타지 않고 offset 부터
///    maxBytes 만큼) + stat 응답에 size. hex 뷰어가 GB 파일을 청크로 본다. 구버전 데몬은
///    offset 을 무시하고 파일 전체(또는 large)를 돌려줘 뷰가 조용히 어긋난다.
/// 12: listFiles 제거, quickOpen(pattern, fresh) 추가 — 빠른 열기 목록은 데몬이 세션 캐시로
///    들고 프론트는 패턴별 상위 결과만 받는다 (VS Code 방식). 종전엔 init 이 목록 전체(홈
///    디렉터리 5만 파일 4MB)를 날라 저속 링크에서 뒤따르는 readDir 응답을 수 초 막았다.
///    구버전 데몬은 quickOpen 을 모르는 메서드로 에러 응답해 Ctrl+P 가 비어 보인다.
/// 13: gitRepos(저장소 자동 탐색) + readDir 디렉토리 항목 repo 표식 + git* 전부 repo 파라미터
///    (루트 상대 디렉토리, 생략은 루트). 하위 폴더·중첩 저장소를 SCM 이 저장소별로 다룬다.
///    구버전 데몬은 gitRepos 를 모르는 메서드로 에러 응답해 SCM 뷰가 비어 보인다.
/// 14: writeFile 에 append(base64 청크 업로드의 후속 조각 — etag 검사 없이 끝에 덧붙인다).
///    탐색기 업로드(ticket explorer-download)가 큰 파일을 4MB 조각으로 나른다. 구버전 데몬은
///    append 를 무시하고 매 조각으로 파일을 덮어써 마지막 조각만 남는다.
pub const WIRE_VERSION: u32 = 14;

/// 릴리스 버전 — 루트 Cargo.toml `[workspace.package] version` 하나에서 온다 (crate 4개가 상속).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// 빌드된 git 커밋 (짧은 해시, 미커밋 변경 시 `-dirty`, git 부재 시 `unknown`) — build.rs 가 굽는다
pub const COMMIT: &str = env!("SUPERLITE_COMMIT");
/// 빌드 시각 (UTC ISO-8601) — build.rs 가 굽는다
pub const BUILT_AT: &str = env!("SUPERLITE_BUILT_AT");

/// `--version` 한 줄 — 데몬·백엔드가 같은 표기를 쓴다 (헬퍼 업로드 로그·버그 리포트용).
/// 예: `superlite-daemon 0.1.0 (8700a11f2, built 2026-09-06T05:00:00Z, wire 13)`
pub fn version_line(bin: &str) -> String {
    format!("{bin} {VERSION} ({COMMIT}, built {BUILT_AT}, wire {WIRE_VERSION})")
}

/// 0700 전용 디렉터리를 만들어 그 안에 소켓을 둔다.
#[cfg(unix)]
fn ipc_path() -> PathBuf {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let base = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    let dir = base.join(format!("superlite-{user}"));
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
    PathBuf::from(format!(r"\\.\pipe\superlite-{user}-{WIRE_VERSION}"))
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

/// 이 머신의 superlite 캐시 디렉터리 `$HOME/.cache/superlite` — 헬퍼 배치(bin/)와
/// 데몬 로그가 산다. 원격 셸이 해석하는 같은 경로 문자열은 relay ssh.rs 가 따로 든다
pub fn cache_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".cache").join("superlite"))
}

/// 데몬 로그 파일 `$HOME/.cache/superlite/daemon.log` (append) — 데몬을 띄우는 쪽(relay
/// spawn_daemon, 원격 헬퍼 spawn_self_daemon)이 stderr 로 물린다. 실패면 None (호출측이 null 로)
pub fn daemon_log_file() -> Option<std::fs::File> {
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().append(true).create(true).open(dir.join("daemon.log")).ok()
}

/// 락 보유 데몬의 pid 파일 — 락 파일과 나란히 (`daemon-<N>.pid`). 락을 쥔 쪽만 쓴다.
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
