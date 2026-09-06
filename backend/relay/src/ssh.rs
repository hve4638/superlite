//! SSH 원격 접속 — 시스템 OpenSSH subprocess 로 원격 데몬에 닿는 통로
//! (ws docs/decision/remote-ssh.md). SSH 프로토콜을 직접 구현하지 않는다: 인증·
//! ~/.ssh/config·ProxyJump 는 ssh 바이너리에 위임하고, exec 채널(원격 명령의
//! stdin/stdout) 위에서 데몬 와이어를 그대로 말한다 — 포트 포워딩 불요.
//!
//! 원격 요구: sshd + 비대화형 인증(BatchMode — 키·agent 전제, 대화형 2FA 는 v0 밖) +
//! 바이너리 업로드·실행 가능한 unix 원격. 헬퍼는 별도 바이너리가 아니라 데몬 자신의
//! --pipe 모드다 — "헬퍼가 곧 원격의 데몬" 대칭 (decision 2026-08-31). 데몬 바이너리는
//! 원격 OS·아키텍처에 맞는 것을 고른다 — 로컬 조회와 같은 규칙으로 앱 옆
//! daemon/<os>-<arch> (remote_daemon_bin → lib daemon_bin_for).

use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

/// `ssh://<host>/<절대경로>` 파싱 — 원격 워크스페이스 root 표기 (프론트·레지스트리 공용).
/// host 는 ~/.ssh/config 별칭 또는 user@host. 경로 유효성은 원격 데몬 attach 가 최종 검증.
/// 경로 없는 `ssh://<host>` 는 루트 없는 원격 빈 세션 (path "") — 시작 페이지 + 그 호스트
/// 탐색만 (relay 가 홈에 watch:false 로 attach).
pub fn parse_remote(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix("ssh://")?;
    let (host, path) = match rest.find('/') {
        Some(slash) => rest.split_at(slash),
        None => (rest, ""),
    };
    if host.is_empty() || !host_ok(host) {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

/// host 가 ssh argv 로 안전한가 — '-' 선두는 ssh 옵션으로 해석된다 (옵션 주입 봉쇄).
/// 개행은 원격 명령 문자열의 줄 경계를 깨뜨린다.
fn host_ok(host: &str) -> bool {
    !host.starts_with('-') && !host.contains(['\n', '\r'])
}

/// ~/.ssh/config 를 Host 블록 단위로 읽는다 (읽기 전용) — (별칭, 옵션 줄들) 을 파일 순서로.
/// 와일드카드 패턴(*·?)과 부정(!)은 접속 대상 이름이 아니라 제외한다. Include 는 v0 미지원.
/// 옵션 줄은 공백 정규화된 "Key Value" 형 — 고정 스냅샷·drift 비교·`ssh -o` 재투입에 그대로
/// 쓴다 (ssh -o 는 config 와 같은 "Key Value" 표기를 받는다). Host 블록 밖(전역) 옵션은
/// ssh 가 config 에서 직접 읽으므로 스냅샷 대상이 아니다.
pub fn config_blocks() -> Vec<(String, Vec<String>)> {
    let Some(home) = home_dir() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    // 현재 Host 줄의 별칭들이 out 에서 차지하는 인덱스 — 옵션 줄을 각 별칭 블록에 복사
    let mut cur: Vec<usize> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = strip_keyword(line, "host") {
            // "Host a b" — 공백 구분 다중 별칭 ("Host=a" 형 '=' 구분은 드물어 v0 미지원)
            cur.clear();
            for name in rest.split_whitespace() {
                if name.contains(['*', '?', '!']) || out.iter().any(|(h, _)| h == name) {
                    continue;
                }
                out.push((name.to_string(), Vec::new()));
                cur.push(out.len() - 1);
            }
            continue;
        }
        if strip_keyword(line, "match").is_some() {
            cur.clear();
            continue;
        }
        let norm = line.split_whitespace().collect::<Vec<_>>().join(" ");
        for &i in &cur {
            out[i].1.push(norm.clone());
        }
    }
    out
}

// ---------------------------------------------------------------- 즐겨찾기·고정·최근 상태

/// superlite 가 별도로 관리하는 원격 탐색기 상태 (백엔드 머신의 설정 파일) — 즐겨찾기(선택적
/// 고정 스냅샷)·pane 접힘·호스트별 최근 폴더. ~/.ssh/config 는 건드리지 않는다.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct RemoteState {
    #[serde(default)]
    favorites: Vec<Favorite>,
    #[serde(default)]
    panes: Panes,
    /// host → 최근 연 폴더 (최신순, RECENT_MAX)
    #[serde(default)]
    recent: std::collections::BTreeMap<String, Vec<String>>,
    /// 구 형식(2026-09-02 이전 고정 목록) — 읽을 때 favorites 로 옮긴다
    #[serde(default, skip_serializing)]
    pinned: Vec<Favorite>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Favorite {
    host: String,
    /// 고정(fix) 시점의 config 블록 옵션 줄 — 있으면 접속 시 `-o` 로 재투입하므로 config 에서
    /// 사라져도 접속되고, config 가 바뀌어도 이 저장본이 우선한다. None = 고정 안 함
    #[serde(default)]
    options: Option<Vec<String>>,
    /// '이 경고 숨김' 으로 인정한 config 상태 키 — 그 상태인 동안만 drift 표시를 끈다
    #[serde(default)]
    ack: Option<String>,
}

/// pane 접힘 상태 — 전역 (새 창에도 반영). 즐겨찾기가 비면 무시된다 (host_list 참조)
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Panes {
    pub favorite: bool,
    pub all: bool,
}

impl Default for Panes {
    fn default() -> Self {
        Panes { favorite: true, all: true }
    }
}

const RECENT_MAX: usize = 10;

/// 원격 탐색기 한 항목 — 프론트 응답 형태
#[derive(serde::Serialize)]
pub struct HostEntry {
    pub name: String,
    pub favorite: bool,
    pub pinned: bool,
    /// 고정 저장본과 현재 config 블록이 다름 (사라짐 포함) — 인정(ack)한 상태면 false
    pub drift: bool,
    /// config 에 없고 고정도 안 됨 (즐겨찾기만 남은 host) — 접속 시도는 ssh 가 거절한다
    pub missing: bool,
}

/// 원격 탐색기 전체 응답 — FAVORITE pane(즐겨찾기 순), ALL pane(config 순, 즐겨찾기 표시),
/// pane 접힘, 호스트별 최근 폴더
#[derive(serde::Serialize)]
pub struct HostList {
    pub favorites: Vec<HostEntry>,
    pub all: Vec<HostEntry>,
    pub panes: Panes,
    pub recent: std::collections::BTreeMap<String, Vec<String>>,
}

fn state_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".config")));
    Some(base?.join("superlite").join("remote.json"))
}

fn load_state() -> RemoteState {
    let mut st: RemoteState = state_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // 구 형식 이전 — 고정이었던 host 는 고정된 즐겨찾기로
    for p in st.pinned.drain(..) {
        if !st.favorites.iter().any(|f| f.host == p.host) {
            st.favorites.push(p);
        }
    }
    st
}

fn save_state(st: &RemoteState) -> Result<(), String> {
    let p = state_path().ok_or("설정 디렉터리를 알 수 없음")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_vec_pretty(st).unwrap()).map_err(|e| e.to_string())
}

/// config 블록 상태의 비교 키 — 부재와 "옵션 없는 블록" 을 구분한다
fn block_key(block: Option<&[String]>) -> String {
    match block {
        None => "\u{0}absent".into(),
        Some(lines) => lines.join("\n"),
    }
}

/// 원격 탐색기 목록. favorites 는 즐겨찾기 순서(고정 항목은 config 에서 사라져도 남고 저장본으로
/// 접속, 고정 안 한 항목은 missing 표시), all 은 config 순서 전체(즐겨찾기 여부 표시).
/// panes 는 즐겨찾기가 비면 저장값과 무관하게 favorite 닫힘·all 열림.
pub fn host_list() -> HostList {
    let st = load_state();
    let blocks = config_blocks();
    let favorites: Vec<HostEntry> = st
        .favorites
        .iter()
        .map(|f| {
            let cur = blocks.iter().find(|(h, _)| *h == f.host).map(|(_, o)| o.as_slice());
            let key = block_key(cur);
            let drift = match &f.options {
                Some(opts) => key != block_key(Some(opts)) && f.ack.as_deref() != Some(key.as_str()),
                None => false,
            };
            HostEntry {
                name: f.host.clone(),
                favorite: true,
                pinned: f.options.is_some(),
                drift,
                missing: cur.is_none() && f.options.is_none(),
            }
        })
        .collect();
    let all = blocks
        .iter()
        .map(|(h, _)| HostEntry {
            name: h.clone(),
            favorite: st.favorites.iter().any(|f| f.host == *h),
            pinned: false,
            drift: false,
            missing: false,
        })
        .collect();
    let panes = if favorites.is_empty() { Panes { favorite: false, all: true } } else { st.panes };
    HostList { favorites, all, panes, recent: st.recent }
}

/// 상태 변경 한 번 — op: fav·unfav·pin·unpin·ack·refresh·forget·pane. 성공 시 갱신된 목록.
/// pin 은 즐겨찾기에서만(사용자 결정) config 블록을 스냅샷, unfav 는 고정도 함께 버린다.
/// ack = 현재 config 상태를 인정(경고만 끈다), refresh = 저장본을 현재 config 로 교체.
/// forget 은 최근 폴더 한 줄 제거(q.path), pane 은 접힘 상태(q.host = favorite|all, q.open = 0|1).
pub fn update_state(op: &str, q: &std::collections::HashMap<String, String>) -> Result<HostList, String> {
    let host = q.get("host").map(String::as_str).unwrap_or("");
    if host.is_empty() || !host_ok(host) {
        return Err("잘못된 host".into());
    }
    let mut st = load_state();
    let cur = || {
        config_blocks().into_iter().find(|(h, _)| h == host).map(|(_, o)| o)
    };
    fn fav_of<'a>(st: &'a mut RemoteState, host: &str) -> Option<&'a mut Favorite> {
        st.favorites.iter_mut().find(|f| f.host == host)
    }
    match op {
        "fav" => {
            if !st.favorites.iter().any(|f| f.host == host) {
                st.favorites.push(Favorite { host: host.to_string(), options: None, ack: None });
            }
        }
        "unfav" => st.favorites.retain(|f| f.host != host),
        "pin" => {
            let options = cur().ok_or("~/.ssh/config 에 없는 host")?;
            let f = fav_of(&mut st, host).ok_or("즐겨찾기가 아닌 host 는 고정할 수 없음")?;
            if f.options.is_none() {
                f.options = Some(options);
                f.ack = None;
            }
        }
        "unpin" => {
            let f = fav_of(&mut st, host).ok_or("즐겨찾기가 아닌 host")?;
            f.options = None;
            f.ack = None;
        }
        "ack" | "refresh" => {
            let block = cur();
            let f = fav_of(&mut st, host).filter(|f| f.options.is_some()).ok_or("고정되지 않은 host")?;
            if op == "ack" {
                f.ack = Some(block_key(block.as_deref()));
            } else {
                f.options = Some(block.ok_or("~/.ssh/config 에 없는 host")?);
                f.ack = None;
            }
        }
        "forget" => {
            let path = q.get("path").map(String::as_str).unwrap_or("");
            if let Some(list) = st.recent.get_mut(host) {
                list.retain(|p| p != path);
                if list.is_empty() {
                    st.recent.remove(host);
                }
            }
        }
        "pane" => {
            let open = q.get("open").map(String::as_str) == Some("1");
            match host {
                "favorite" => st.panes.favorite = open,
                "all" => st.panes.all = open,
                _ => return Err("알 수 없는 pane".into()),
            }
        }
        _ => return Err("알 수 없는 op".into()),
    }
    save_state(&st)?;
    Ok(host_list())
}

/// 최근 폴더 기록 — relay 가 원격 attach 성공(데몬이 돌려준 정규화 경로) 시 부른다.
/// 최신을 앞에, 중복 제거, RECENT_MAX 초과는 버림. 저장 실패는 로그만 (접속에는 무관)
pub fn record_recent(host: &str, path: &str) {
    let mut st = load_state();
    let list = st.recent.entry(host.to_string()).or_default();
    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(RECENT_MAX);
    if let Err(e) = save_state(&st) {
        eprintln!("backend: 최근 폴더 저장 실패: {e}");
    }
}

/// ssh_config 키워드는 대소문자 무관 — 키워드 뒤 공백까지 확인해 "Hostname" 오인을 막는다
fn strip_keyword<'a>(line: &'a str, kw: &str) -> Option<&'a str> {
    let (head, rest) = line.split_at_checked(kw.len())?;
    (head.eq_ignore_ascii_case(kw) && rest.starts_with([' ', '\t'])).then_some(rest)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// 공통 ssh 명령 골격 — BatchMode(프롬프트 대신 실패) + unix 는 ControlMaster 연결 공유
/// (같은 호스트 두 번째부터 핸드셰이크 없이 즉시 — 수명 자체 구현 대신 OpenSSH 위임,
/// decision/process-topology.md 개정). Windows OpenSSH 는 ControlMaster 미지원이라 뺀다
/// — 접속마다 인증할 뿐 동작은 같다. opts 는 ssh_opts 로 접속 시작 시 한 번 읽어 넘긴다
fn ssh_cmd(host: &str, opts: &[String]) -> Command {
    let mut c = Command::new("ssh");
    c.arg("-o").arg("BatchMode=yes");
    #[cfg(unix)]
    {
        // 마스터 소켓은 데몬 IPC 와 같은 0700 디렉터리 — 타 사용자 탈취 방지가 이미 돼 있다
        let dir = superlite_common::socket_path();
        let dir = dir.parent().unwrap_or(std::path::Path::new("/tmp"));
        c.arg("-o").arg("ControlMaster=auto");
        c.arg("-o").arg(format!("ControlPath={}/ssh-%C", dir.display()));
        c.arg("-o").arg("ControlPersist=60");
    }
    for line in opts {
        c.arg("-o").arg(line);
    }
    c.arg(host);
    // CREATE_NO_WINDOW(0x08000000) — GUI 앱(콘솔 없음)이 콘솔 프로그램을 spawn 하면 Windows 가
    // 새 콘솔 창을 만들어 접속마다 빈 창이 깜빡인다. stdio 는 전부 파이프라 콘솔이 필요 없다
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c
}

/// 호스트의 고정 저장본 ssh 옵션 — config 보다 명령줄 -o 가 우선하므로 config 가 바뀌거나
/// 사라져도 고정 시점 설정으로 접속한다 (사용자 결정: 고정 = 저장본으로 접속). 고정 안 한
/// 호스트는 빈 목록. 접속 한 번에 remote.json 을 한 번만 읽도록 호출자가 넘긴다
pub fn ssh_opts(host: &str) -> Vec<String> {
    load_state().favorites.into_iter().find(|f| f.host == host).and_then(|f| f.options).unwrap_or_default()
}

/// 원격 명령 1회 실행 — stdin 을 다 써넣고 닫은 뒤 종료를 기다린다.
/// write 실패는 무시한다: 원격이 stdin 을 안 읽고 죽는 경로인데, 그때는 어차피
/// status 가 실패라 에러가 그쪽에서 드러난다.
async fn run_ssh(host: &str, opts: &[String], cmd: &str, stdin_data: &[u8]) -> Result<std::process::Output, String> {
    let mut child = ssh_cmd(host, opts).arg(cmd).spawn().map_err(|e| format!("ssh 실행 실패: {e}"))?;
    let mut si = child.stdin.take().unwrap();
    let _ = si.write_all(stdin_data).await;
    let _ = si.shutdown().await;
    drop(si);
    child.wait_with_output().await.map_err(|e| e.to_string())
}

fn ssh_err(out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let last = stderr.lines().last().unwrap_or("").trim();
    if last.is_empty() {
        format!("ssh 실패 (exit {:?})", out.status.code())
    } else {
        last.to_string()
    }
}

/// 원격 기본 정보 — 홈 경로와 OS·아키텍처. 접속마다 exec 한 번 (ControlMaster 덕에 왕복
/// 하나 값, Windows 는 핸드셰이크 하나). os/arch 는 데몬 바이너리 선택 키.
#[derive(Clone)]
pub struct RemoteInfo {
    pub home: String,
    /// std::env::consts::OS 표기 (linux·macos) — uname -s 를 정규화
    pub os: String,
    /// std::env::consts::ARCH 표기 (x86_64·aarch64) — uname -m 을 정규화
    pub arch: String,
}

/// 접속 단계 통보 채널 — relay 가 프론트에 connectStage 이벤트로 흘린다 (ssh-connect-status).
/// (단계, 부가 바이트 수 — upload 만). None 이면 통보 없음 (clean_remote 등)
pub type StageTx = tokio::sync::mpsc::UnboundedSender<(&'static str, Option<u64>)>;

fn stage(tx: Option<&StageTx>, s: &'static str, bytes: Option<u64>) {
    if let Some(tx) = tx {
        let _ = tx.send((s, bytes));
    }
}

pub async fn probe_remote(host: &str, opts: &[String], tx: Option<&StageTx>) -> Result<RemoteInfo, String> {
    if !host_ok(host) {
        return Err("잘못된 host".into());
    }
    stage(tx, "ssh", None);
    let out = run_ssh(host, opts, r#"printf '%s
' "$HOME" "$(uname -s)" "$(uname -m)""#, b"").await?;
    if !out.status.success() {
        return Err(ssh_err(&out));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let home = lines.next().unwrap_or("").trim_end_matches('/').to_string();
    let os = lines.next().unwrap_or("").trim().to_ascii_lowercase();
    let arch = lines.next().unwrap_or("").trim().to_string();
    if home.is_empty() || os.is_empty() || arch.is_empty() {
        return Err("원격 정보($HOME·uname) 확인 실패".into());
    }
    let os = match os.as_str() {
        "darwin" => "macos".into(),
        o => o.to_string(),
    };
    let arch = match arch.as_str() {
        "arm64" => "aarch64".into(),
        "amd64" => "x86_64".into(),
        a => a.to_string(),
    };
    Ok(RemoteInfo { home, os, arch })
}

/// `~` 표기 해석 — 프론트는 원격 홈 경로를 모르므로 세션 root 를 `ssh://host/~`(홈) 또는
/// `ssh://host/~/sub` 로 적는다. attach 직전 원격 $HOME(probe_remote)으로 치환한다.
/// '~' 가 아니면 그대로.
pub fn expand_home(home: &str, path: &str) -> String {
    match path.strip_prefix("/~").filter(|r| r.is_empty() || r.starts_with('/')) {
        Some(rest) => format!("{home}{rest}"),
        None => path.to_string(),
    }
}

/// 원격 OS·아키텍처용 데몬 바이너리 — 로컬 조회와 같은 규칙(앱 옆 `daemon/<os>-<arch>`,
/// crate::daemon_bin_for). Windows 배포 세트가 musl 정적 daemon/linux-x86_64 를 동봉한다
/// (build.sh). 없으면 무엇을 어디에 둬야 하는지 알린다
fn remote_daemon_bin(info: &RemoteInfo) -> Result<PathBuf, String> {
    crate::daemon_bin_for(&info.os, &info.arch)
}

/// 원격 헬퍼(=데몬 바이너리) 배치 보장 — 없으면 로컬 산출물을 ssh stdin 으로 업로드.
/// 디렉터리 키는 버전이 아니라 바이너리 내용 해시 — 개발 중 재빌드가 곧 재배포이고,
/// 다른 빌드끼리 섞이지 않는다 (와이어 버전 대조가 필요 없어진다).
/// 반환: 원격 셸이 해석할 경로 식 ("$HOME/..." — 원격 홈 경로를 이쪽에서 모른다).
/// 올리는 바이너리는 원격 OS·아키텍처에 맞춘다 (remote_daemon_bin).
pub async fn ensure_remote_bin(
    host: &str,
    opts: &[String],
    info: &RemoteInfo,
    tx: Option<&StageTx>,
) -> Result<String, String> {
    let bin = remote_daemon_bin(info)?;
    let data = std::fs::read(&bin)
        .map_err(|e| format!("데몬 바이너리 읽기 실패 {}: {e}", bin.display()))?;
    let dir = format!("$HOME/.cache/superlite/bin/{:016x}", fnv64(&data));
    let target = format!("{dir}/superlite-daemon");
    stage(tx, "helper", None);
    // 존재 검사와 업로드를 나눈다 — 한 번에 하면 이미 있을 때도 stdin 으로 바이너리를 다
    // 보내게 된다 (원격이 안 읽으면 전송이 어중간히 끊긴다). ControlMaster 덕에 두 번째
    // exec 는 왕복 하나 값이다.
    let probe = run_ssh(host, opts, &format!(r#"test -x "{target}""#), b"").await?;
    if !probe.status.success() {
        if probe.status.code() != Some(1) {
            return Err(ssh_err(&probe)); // exit 1 은 "없음", 그 외(255 등)는 접속 실패
        }
        stage(tx, "upload", Some(data.len() as u64));
        // $$(원격 셸 pid)로 임시명 충돌 방지 — 동시 접속 둘이 같은 파일을 쓰지 않게
        let up = format!(
            r#"mkdir -p "{dir}" && cat > "{target}.$$" && chmod +x "{target}.$$" && mv "{target}.$$" "{target}""#
        );
        let out = run_ssh(host, opts, &up, &data).await?;
        if !out.status.success() {
            return Err(format!("헬퍼 업로드 실패: {}", ssh_err(&out)));
        }
        eprintln!("backend: ssh {host} — 헬퍼 업로드 완료 ({} bytes)", data.len());
    }
    Ok(target)
}

/// 원격 데몬으로의 파이프 연결 — 배치된 헬퍼 경로(ensure_remote_bin 결과)로
/// `ssh host superlite-daemon --pipe`. 반환된 child 의 stdin/stdout 이 데몬 와이어다
/// (relay 가 로컬 소켓 자리에 물린다). kill_on_drop: relay 종료 = ssh 종료 → 원격 --pipe 가
/// EOF 로 물러나고 원격 데몬은 세션을 detach 로 돌린다 (재접속 약속은 원격 데몬의 세션
/// grace 가 지킨다). attach 를 보내기 전까지는 어느 경로·세션에도 묶이지 않는다 — Spares 가
/// 미리 만들어 두는 근거.
pub fn pipe_conn(host: &str, opts: &[String], bin: &str, tx: Option<&StageTx>) -> Result<Child, String> {
    if !host_ok(host) {
        return Err("잘못된 host".into());
    }
    stage(tx, "daemon", None);
    let mut c = ssh_cmd(host, opts);
    c.arg(format!(r#""{bin}" --pipe"#));
    // 헬퍼 stderr 는 relay 가 읽어 백엔드 로그로 흘리고 마지막 줄을 실패 사유로 쓴다 (lib.rs relay)
    c.stderr(Stdio::piped());
    c.kill_on_drop(true);
    c.spawn().map_err(|e| format!("ssh 실행 실패: {e}"))
}

// ---------------------------------------------------------------- 예비 파이프

/// 호스트별 예비 파이프 (ticket ssh-spare-pipe). 같은 호스트 두 번째 접속도 ~500ms 걸렸다 —
/// ControlMaster 가 아끼는 것은 인증뿐이고 relay 는 접속마다 ssh exec 3회(probe·test -x·
/// --pipe)를 직렬로 새로 했다 (각각 로컬 ssh spawn + 원격 sshd 셸 fork, 마지막은 원격 헬퍼
/// 기동까지). 그래서 접속 결과(attach 전 ssh child + 원격 정보 + 헬퍼 경로)를 호스트마다
/// 하나씩 미리 만들어 둔다. attach 는 소비자가 보내므로 경로·세션·watch 와 무관하게 어떤
/// 접속이든 소비할 수 있다 (재-attach 는 데몬이 거부 — 예비는 attach 없이 보관).
///
/// 만료: 예비가 살아 있는 동안 원격 데몬은 연결 수 ≥1 이라 유휴 종료하지 않는다
/// (daemon-cleanup 의 취지와 충돌). 그 호스트의 실제 접속이 0 이 된 뒤 SPARE_SECS 가 지나면
/// 항목을 버린다 — kill_on_drop → 원격 헬퍼 EOF 종료 → 원격 데몬은 기존 grace 규칙으로
/// 물러난다. 기본 300초 = 원격 세션 grace 와 같은 "재접속 약속" 창.
#[derive(Default)]
pub struct Spares(std::sync::Mutex<std::collections::HashMap<String, HostState>>);

#[derive(Default)]
struct HostState {
    spare: Option<Held>,
    /// 이 호스트의 실제 접속 수 (enter 가드)
    active: usize,
    /// active 가 0 이 된 시각 — 만료 태스크는 이 값이 그대로일 때만 버린다
    idle_since: Option<std::time::Instant>,
}

/// 소비자에게 넘기는 예비 — child 는 stdin/stdout 이 온전한 attach 전 ssh
pub struct Spare {
    pub child: Child,
    pub info: RemoteInfo,
    pub bin: String,
}

/// 보관 중인 예비 — stdin 은 ping 태스크가 쥔다. 데몬은 10분 무입력 연결을 죽은 것으로 보고
/// 닫으므로 예비도 relay 처럼 30초 ping 을 보낸다. take 가 stop 으로 멈추고 stdin 을 돌려받는다
struct Held {
    spare: Spare,
    stop: tokio::sync::oneshot::Sender<()>,
    stdin: tokio::sync::oneshot::Receiver<tokio::process::ChildStdin>,
}

impl Held {
    fn new(mut child: Child, info: RemoteInfo, bin: String) -> Held {
        let mut si = child.stdin.take().unwrap();
        let (stop, mut stop_rx) = tokio::sync::oneshot::channel();
        let (back, stdin) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let mut ping = tokio::time::interval(std::time::Duration::from_secs(30));
            ping.tick().await;
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    _ = ping.tick() => {
                        if si.write_all(b"{\"method\":\"ping\"}\n").await.is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = back.send(si);
        });
        Held { spare: Spare { child, info, bin }, stop, stdin }
    }
}

/// enter 의 반환 가드 — drop 이 leave (relay 의 어느 반환 경로든 놓치지 않게)
pub struct Enter {
    spares: std::sync::Arc<Spares>,
    host: String,
}

impl Drop for Enter {
    fn drop(&mut self) {
        let mut map = self.spares.0.lock().unwrap();
        let Some(st) = map.get_mut(&self.host) else { return };
        st.active -= 1;
        if st.active > 0 {
            return;
        }
        let now = std::time::Instant::now();
        st.idle_since = Some(now);
        drop(map);
        let (spares, host) = (self.spares.clone(), self.host.clone());
        tokio::spawn(async move {
            tokio::time::sleep(spare_secs()).await;
            let mut map = spares.0.lock().unwrap();
            // 사이에 접속이 있었으면(idle_since 갱신·해제) 그쪽의 만료 태스크가 맡는다
            if map.get(&host).is_some_and(|st| st.idle_since == Some(now)) {
                map.remove(&host);
                eprintln!("backend: ssh {host} — 예비 파이프 만료");
            }
        });
    }
}

fn spare_secs() -> std::time::Duration {
    let secs = std::env::var("SUPERLITE_SPARE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    std::time::Duration::from_secs(secs)
}

impl Spares {
    /// 실제 접속 시작 — 가드가 살아 있는 동안 이 호스트의 예비는 만료되지 않는다
    pub fn enter(self: &std::sync::Arc<Self>, host: &str) -> Enter {
        let mut map = self.0.lock().unwrap();
        let st = map.entry(host.to_string()).or_default();
        st.active += 1;
        st.idle_since = None;
        Enter { spares: self.clone(), host: host.to_string() }
    }

    /// 예비 소비 — ssh 가 이미 죽었으면(네트워크 단절·원격 데몬 종료) None: 호출자는 기존
    /// 접속 경로로 간다. ping 태스크를 멈추고 stdin 을 child 에 되돌려 온전한 child 로 넘긴다
    pub async fn take(&self, host: &str) -> Option<Spare> {
        let Held { mut spare, stop, stdin } = self.0.lock().unwrap().get_mut(host)?.spare.take()?;
        if !matches!(spare.child.try_wait(), Ok(None)) {
            return None;
        }
        let _ = stop.send(());
        spare.child.stdin = Some(stdin.await.ok()?);
        Some(spare)
    }

    /// 예비 보충 — 슬롯이 비어 있을 때만 pipe_conn 한 번. spawn 은 fork 만이라 즉시 돌아오고
    /// 원격 헬퍼 기동은 뒤에서 진행된다 (소비가 먼저 오면 attach 줄이 파이프에서 기다릴 뿐).
    /// 접속 성립 직후 부른다
    pub fn fill(&self, host: &str, opts: &[String], info: RemoteInfo, bin: String) {
        let mut map = self.0.lock().unwrap();
        let st = map.entry(host.to_string()).or_default();
        if st.spare.is_some() {
            return;
        }
        match pipe_conn(host, opts, &bin, None) {
            Ok(c) => st.spare = Some(Held::new(c, info, bin)),
            Err(e) => eprintln!("backend: ssh {host} — 예비 파이프 실패: {e}"),
        }
    }
}

/// 원격 문제 데몬 정리 — 헬퍼 배치 보장 후 `ssh host superlite-daemon --clean`. 헬퍼가
/// 곧 원격의 데몬이므로 정리 명령도 같은 바이너리다. 반환은 --clean 의 stdout
pub async fn clean_remote(host: &str) -> Result<String, String> {
    if !host_ok(host) {
        return Err("잘못된 host".into());
    }
    let opts = ssh_opts(host);
    let info = probe_remote(host, &opts, None).await?;
    let bin = ensure_remote_bin(host, &opts, &info, None).await?;
    let out = run_ssh(host, &opts, &format!(r#""{bin}" --clean"#), b"").await?;
    if !out.status.success() {
        return Err(format!("원격 정리 실패: {}", ssh_err(&out)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// FNV-1a 64 — 배치 디렉터리 키용 내용 해시. 비적대적 용도(캐시 무효화)라 충분하고
/// 의존성이 없다
fn fnv64(data: &[u8]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for &b in data {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}
