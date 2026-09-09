//! 내장 tmux 통합 — 터미널의 "꺼지지 않는 실행 요소"를 tmux 서버에 위임한다 (ticket
//! term-list-reconnect 2026-09-07 결정, ws decision/process-topology.md 같은 날짜 개정). 데몬은 PTY
//! 안에서 tmux 클라이언트(attach-session)를 띄울 뿐이고, 셸 생존·스크롤백·다중 attach·detach 는
//! 전부 tmux 서버 몫이다. 세션 원장도 tmux 다 — 별도 DB 없이 세션 환경변수
//! SUPERLITE_TMUX_WORKSPACE_PATH 가 워크스페이스를 가리키고 기본 키는 #{session_id}.
//! 서버는 -L <SLUG> 전용 소켓 (SUPERLITE_TMUX_SOCK 이면 -S 그 경로 — check 하니스 격리).
//! unix 전용 — Windows 는 plain(PTY 직접, 앱 종료와 함께 죽는다. 사용자 결정 2026-09-07).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::err;

/// 세션 환경변수 — 이 세션이 어느 워크스페이스 것인가 (역방향 조회 키)
pub(crate) const ENV_ROOT: &str = "SUPERLITE_TMUX_WORKSPACE_PATH";
const BASE_CONF: &str = include_str!("tmux-base.conf");

/// 이 데몬의 터미널 방식 — 데몬당 한 번 판정 (tmux -V)
pub(crate) enum Mode {
    Tmux { bin: PathBuf },
    /// unix 인데 tmux 를 못 찾았다/못 돌렸다 — 경고와 함께 종전 PTY 직접 실행으로 대체
    Plain { error: Option<String> },
    /// Windows — 터미널 보존 없음, 경고도 없음
    Unsupported,
}

pub(crate) fn mode() -> &'static Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    MODE.get_or_init(probe)
}

/// attach 응답의 terminal 필드 — 프론트가 사이드바 아이콘·경고 배지를 정한다
pub(crate) fn mode_json() -> Value {
    match mode() {
        Mode::Tmux { .. } => json!({"mode": "tmux"}),
        Mode::Plain { error } => json!({"mode": "plain", "error": error}),
        Mode::Unsupported => json!({"mode": "unsupported"}),
    }
}

fn probe() -> Mode {
    if cfg!(windows) {
        return Mode::Unsupported;
    }
    // 개발·검증용 강제 plain — raw PTY 의미(배압·detach 버퍼)를 재는 check 스크립트가 쓴다
    if std::env::var("SUPERLITE_TMUX").is_ok_and(|v| v == "0") {
        return Mode::Plain { error: None };
    }
    let mut tried = Vec::new();
    for c in candidates() {
        match std::process::Command::new(&c).arg("-V").output() {
            Ok(o) if o.status.success() => return Mode::Tmux { bin: c },
            Ok(o) => tried.push(format!("{}: {}", c.display(), String::from_utf8_lossy(&o.stderr).trim())),
            Err(e) => tried.push(format!("{}: {e}", c.display())),
        }
    }
    Mode::Plain { error: Some(format!("tmux 를 찾지 못했다 ({})", tried.join("; "))) }
}

/// tmux 바이너리 후보 — 우회 env → 데몬 옆 `tmux`(원격 헬퍼 폴더에 같이 올린 것) → 데몬 옆
/// `tmux-<os>-<arch>`(앱 설치본 daemon/ 배치) → PATH
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(p) = std::env::var("SUPERLITE_TMUX_BIN") {
        v.push(PathBuf::from(p));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        v.push(dir.join("tmux"));
        v.push(dir.join(format!("tmux-{}-{}", std::env::consts::OS, std::env::consts::ARCH)));
    }
    v.push(PathBuf::from("tmux"));
    v.into_iter().filter(|p| !p.is_absolute() || p.is_file()).collect()
}

fn socket_args() -> Vec<OsString> {
    match std::env::var_os("SUPERLITE_TMUX_SOCK") {
        Some(p) => vec!["-S".into(), p],
        None => vec!["-L".into(), superlite_common::SLUG.into()],
    }
}

fn conf_dir() -> PathBuf {
    superlite_common::cache_dir().unwrap_or_else(std::env::temp_dir).join("tmux")
}

fn user_conf_path() -> PathBuf {
    conf_dir().join("user.conf")
}

/// base.conf 를 캐시 폴더에 (재)기록하고 경로를 돌려준다 — 내용이 같으면 쓰지 않는다.
/// 끝에 사용자 conf source 한 줄을 붙여 사용자 값이 기본값을 덮게 한다
fn base_conf_path() -> Result<PathBuf, String> {
    let dir = conf_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join("base.conf");
    let content = format!("{BASE_CONF}\nsource-file -q \"{}\"\n", user_conf_path().display());
    if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
        std::fs::write(&path, content).map_err(err)?;
    }
    Ok(path)
}

/// 공통 앞부분 `tmux -L <SLUG> -f base.conf` — TMUX·TMUX_PANE 은 지운다 (데몬이 tmux 안에서
/// 떴더라도 클라이언트가 중첩 경고를 내지 않게)
pub(crate) fn base_args() -> Result<Vec<OsString>, String> {
    let mut a = socket_args();
    a.push("-f".into());
    a.push(base_conf_path()?.into());
    Ok(a)
}

fn command(bin: &Path) -> Result<std::process::Command, String> {
    let mut c = std::process::Command::new(bin);
    c.env_remove("TMUX").env_remove("TMUX_PANE").args(base_args()?);
    Ok(c)
}

fn async_command(bin: &Path) -> Result<tokio::process::Command, String> {
    let mut c = tokio::process::Command::new(bin);
    c.env_remove("TMUX").env_remove("TMUX_PANE").args(base_args()?);
    Ok(c)
}

fn out_text(o: std::process::Output) -> Result<String, String> {
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim_end().to_string())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).trim().to_string())
    }
}

/// 세션 이름 — 워크스페이스 폴더명 + 번호. tmux 이름 규칙('.'·':' 금지)에 맞춰 치환
fn session_name(root: &Path, n: u32) -> String {
    let folder = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "term".into());
    let clean: String = folder
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("{clean}-{n}")
}

/// 새 tmux 세션 (detached) — 반환 (session_id, name). 이름 충돌은 번호를 올려 재시도.
/// env 는 세션 환경변수(-e)로 — 셸 심 좌표(SUPERLITE_SOCK·SESSION)와 워크스페이스 역방향 키
pub(crate) fn new_session(bin: &Path, root: &Path, env: &[(&str, String)]) -> Result<(String, String), String> {
    let mut last = String::new();
    for n in 1..=99u32 {
        let name = session_name(root, n);
        let mut c = command(bin)?;
        c.args(["new-session", "-d", "-s", &name, "-c"]).arg(root).args(["-P", "-F", "#{session_id}"]);
        for (k, v) in env {
            c.arg("-e").arg(format!("{k}={v}"));
        }
        match out_text(c.output().map_err(err)?) {
            Ok(id) => return Ok((id, name)),
            Err(e) if e.contains("duplicate session") => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(format!("세션 이름 소진: {last}"))
}

/// pane 의 tty 로 그 pane 이 속한 세션 id (askpass 요청자 좌표 해석 — 요청자는 tmux 안의 셸 자식이라
/// 자기 tty 만 안다). 없거나 서버 부재면 None
pub(crate) fn session_of_pane(bin: &Path, tty: &str) -> Option<String> {
    let out = command(bin).ok()?.args(["list-panes", "-a", "-F", "#{pane_tty}\t#{session_id}"]).output().ok()?;
    out_text(out).ok()?.lines().find_map(|l| {
        let (t, sid) = l.split_once('\t')?;
        (t == tty).then(|| sid.to_string())
    })
}

/// 세션 이름 조회 (attach 시 프론트 탭 제목) — 실패면 id 그대로
pub(crate) fn name_of(bin: &Path, id: &str) -> String {
    command(bin)
        .and_then(|mut c| c.args(["display-message", "-p", "-t", id, "#{session_name}"]).output().map_err(err))
        .and_then(out_text)
        .unwrap_or_else(|_| id.to_string())
}

fn no_server(e: &str) -> bool {
    e.contains("no server running") || e.contains("No such file or directory")
}

/// 살아 있는 세션 목록 — root 를 주면 그 워크스페이스 것만, None 이면 전부 (ENV_ROOT 없는 세션은
/// 우리 것이 아니라 제외). [{id, name, root, attached, activity, created, command}]
pub(crate) async fn list(bin: &Path, root: Option<&Path>) -> Result<Vec<Value>, String> {
    const FMT: &str = "#{session_id}\t#{session_name}\t#{session_attached}\t#{session_activity}\t#{session_created}\t#{pane_current_command}";
    let o = async_command(bin)?.args(["ls", "-F", FMT]).output().await.map_err(err)?;
    let text = match out_text(o) {
        Ok(t) => t,
        Err(e) if no_server(&e) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let want = root.map(|r| r.to_string_lossy().into_owned());
    let mut out = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 6 {
            continue;
        }
        let env = async_command(bin)?.args(["show-environment", "-t", f[0], ENV_ROOT]).output().await.map_err(err)?;
        let Some(r) = out_text(env).ok().and_then(|s| s.split_once('=').map(|(_, v)| v.to_string())) else {
            continue;
        };
        if want.as_deref().is_some_and(|w| w != r) {
            continue;
        }
        out.push(json!({
            "id": f[0], "name": f[1], "root": r,
            "attached": f[2].parse::<u64>().unwrap_or(0),
            "activity": f[3].parse::<u64>().unwrap_or(0) * 1000,
            "created": f[4].parse::<u64>().unwrap_or(0) * 1000,
            "command": f[5],
        }));
    }
    Ok(out)
}

/// 특정 클라이언트(그 pty tty)를 clean detach 하는 인자 — tmux 세션·pane 은 산다. 탭 닫기
/// 정리(term::kill_term)가 tmux::bin() 과 함께 쓴다. SIGHUP·master 급종료는 그 pane 까지 죽인다
pub(crate) fn detach_args(tty: &str) -> Vec<OsString> {
    let mut a = socket_args();
    a.push("detach-client".into());
    a.push("-t".into());
    a.push(tty.into());
    a
}

/// tmux 바이너리 경로 (Tmux 모드일 때만) — kill_term 의 detach 명령용
pub(crate) fn bin() -> Option<&'static Path> {
    match mode() {
        Mode::Tmux { bin } => Some(bin.as_path()),
        _ => None,
    }
}

/// tty 의 클라이언트가 tmux 클라이언트 목록에서 사라질 때까지 (또는 timeout) 블로킹.
/// detach-client 뒤 이 시점까지 기다린 뒤에야 pty(master)를 닫아야 한다 — 클라이언트 프로세스가
/// 종료(child.wait)해도 tmux 서버가 detach 처리를 끝내기 전이면, master 닫힘이 그 pane 까지 죽인다
/// (실측 2026-09-07). 동기 blocking (kill_term 의 전용 스레드에서 부른다)
pub(crate) fn wait_client_gone(bin: &Path, tty: &str, timeout: std::time::Duration) {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let out = std::process::Command::new(bin)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .args(socket_args())
            .args(["list-clients", "-F", "#{client_tty}"])
            .output();
        let present = out
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| l == tty))
            .unwrap_or(false);
        if !present || std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}

pub(crate) async fn kill(bin: &Path, id: &str) -> Result<(), String> {
    let o = async_command(bin)?.args(["kill-session", "-t", id]).output().await.map_err(err)?;
    out_text(o).map(|_| ())
}

pub(crate) async fn rename(bin: &Path, id: &str, name: &str) -> Result<(), String> {
    let o = async_command(bin)?.args(["rename-session", "-t", id, name]).output().await.map_err(err)?;
    out_text(o).map(|_| ())
}

/// 클라이언트의 tmux.conf 를 사용자 conf 로 기록하고, 서버가 떠 있으면 즉시 적용 (source-file).
/// 반환: tmux 가 낸 경고·오류 텍스트 (문법 오류를 프론트가 알림으로 보인다). 서버 없음은 빈 문자열
pub(crate) async fn apply_conf(bin: &Path, content: &str) -> Result<String, String> {
    let path = user_conf_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    std::fs::write(&path, content).map_err(err)?;
    let o = async_command(bin)?.arg("source-file").arg(&path).output().await.map_err(err)?;
    match out_text(o) {
        Ok(t) => Ok(t),
        Err(e) if no_server(&e) => Ok(String::new()),
        Err(e) => Ok(e), // 설정 오류는 실패가 아니라 사용자에게 보일 메시지
    }
}
