//! 클라이언트(이 백엔드 머신) 설정 파일 — tmux 프로필과 ~/.ssh/config (ticket config-editors).
//! 프론트 편집기 탭이 HTTP 로 읽고 쓴다 (데몬 와이어 밖). tmux 는 프로필 여럿 중 하나(active)를
//! 접속 중인 데몬에 적용하는 구조 — `config_dir()/tmux/profiles/<이름>.conf` + `tmux/active`.
//! `default` 는 내장 기본 설정(common TMUX_BASE_CONF) 그 자체 — 읽기 전용이고 디스크에 두지 않는다.
//! 프로필은 default 를 복사해 파생한 완전한 설정이다 (데몬은 프로필이 있으면 내장값 대신 그것을 -f 로 쓴다).
//! 종전 단일 `config_dir()/tmux.conf`(내장값 뒤에 덧붙던 사용자 설정)는 첫 사용 때 내장값 + 그 내용을
//! 이어 붙인 `migrated` 프로필로 옮기고 active 로 삼는다 — 동작이 그대로 보존된다.

use std::path::PathBuf;

use serde::Serialize;

pub const DEFAULT: &str = "default";
const MIGRATED: &str = "migrated";

fn tmux_dir() -> Option<PathBuf> {
    superlite_common::config_dir().map(|d| d.join("tmux"))
}

/// 프로필 폴더 보장 + 옛 tmux.conf 이관(폴더가 없을 때 한 번)
fn profiles_dir() -> Result<PathBuf, String> {
    let tmux = tmux_dir().ok_or("설정 폴더 없음")?;
    let dir = tmux.join("profiles");
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let old = tmux.parent().unwrap().join("tmux.conf");
        if let Ok(user) = std::fs::read_to_string(&old) {
            if !user.trim().is_empty() {
                let to = dir.join(format!("{MIGRATED}.conf"));
                let content = format!("{}\n# ---- migrated from tmux.conf ({}) ----\n{user}", superlite_common::TMUX_BASE_CONF, old.display());
                std::fs::write(&to, content).map_err(|e| format!("{}: {e}", to.display()))?;
                set_active(MIGRATED)?;
            }
            let _ = std::fs::remove_file(&old);
        }
    }
    Ok(dir)
}

/// 프로필 이름 = 파일 stem — 경로 조작이 안 되게 영숫자·-·_·. 만, 선두 . 금지
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 디스크 프로필 경로 — default 는 디스크에 없으므로 오류 (호출측이 먼저 가른다)
pub fn profile_path(name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("프로필 이름이 올바르지 않음: {name:?}"));
    }
    if name == DEFAULT {
        return Err("default 프로필은 내장 기본값이라 파일이 없음".into());
    }
    Ok(profiles_dir()?.join(format!("{name}.conf")))
}

/// 현재 적용 프로필 — active 파일이 없거나 가리키는 프로필이 사라졌으면 default
pub fn active_name() -> String {
    let named = tmux_dir()
        .and_then(|d| std::fs::read_to_string(d.join("active")).ok())
        .map(|s| s.trim().to_string())
        .filter(|n| n == DEFAULT || profile_path(n).is_ok_and(|p| p.is_file()));
    named.unwrap_or_else(|| DEFAULT.to_string())
}

/// 접속 직후 데몬에 밀어 넣을 내용 — default 와 읽기 실패는 빈 내용 (데몬이 내장 기본값으로 뜬다)
pub fn active_content() -> String {
    let name = active_name();
    if name == DEFAULT {
        return String::new();
    }
    profile_path(&name).ok().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default()
}

/// default 는 내장 기본값 원문
pub fn read_profile(name: &str) -> Result<String, String> {
    if name == DEFAULT {
        return Ok(superlite_common::TMUX_BASE_CONF.to_string());
    }
    let p = profile_path(name)?;
    std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))
}

pub fn write_profile(name: &str, content: &str) -> Result<(), String> {
    if name == DEFAULT {
        return Err("default 프로필은 읽기 전용 — 새 프로필을 만들어 편집".into());
    }
    let p = profile_path(name)?;
    std::fs::write(&p, content).map_err(|e| format!("{}: {e}", p.display()))
}

/// GET /tmux-conf/profiles 응답 — 프론트 폼(select)과 탭 툴팁(실제 경로)의 재료
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub active: String,
    /// default 가 먼저, 나머지는 이름순
    pub names: Vec<String>,
    /// 프로필 폴더 절대 경로 — 툴팁용
    pub dir: String,
    /// ~/.ssh/config 절대 경로 — 툴팁용 (홈을 모르면 빈 문자열)
    pub ssh_config: String,
}

pub fn list() -> Result<Profiles, String> {
    let dir = profiles_dir()?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let stem = p.file_stem()?.to_str()?.to_string();
            (p.extension().is_some_and(|x| x == "conf") && valid_name(&stem) && stem != DEFAULT).then_some(stem)
        })
        .collect();
    names.sort();
    names.insert(0, DEFAULT.to_string());
    Ok(Profiles {
        active: active_name(),
        names,
        dir: dir.display().to_string(),
        ssh_config: ssh_config_path().map(|p| p.display().to_string()).unwrap_or_default(),
    })
}

/// POST /tmux-conf/profiles?op=&name=&from= — create(default 복사 = 내장 기본값 템플릿)·clone(from 복사)·
/// delete(default 불가, active 였으면 default 로)·select. 응답은 갱신된 목록. 적용은 프론트 몫
/// (relay 는 연결을 모아 두지 않는다)
pub fn update(op: &str, name: &str, from: &str) -> Result<Profiles, String> {
    match op {
        "create" | "clone" => {
            let path = profile_path(name)?;
            if path.exists() {
                return Err(format!("이미 있는 프로필: {name}"));
            }
            let content = read_profile(if op == "clone" { from } else { DEFAULT })?;
            std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        "delete" => {
            let path = profile_path(name)?;
            std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            if active_name() == name {
                set_active(DEFAULT)?;
            }
        }
        "select" => {
            if name != DEFAULT && !profile_path(name)?.is_file() {
                return Err(format!("없는 프로필: {name}"));
            }
            set_active(name)?;
        }
        _ => return Err(format!("알 수 없는 op: {op}")),
    }
    list()
}

fn set_active(name: &str) -> Result<(), String> {
    let p = tmux_dir().ok_or("설정 폴더 없음")?.join("active");
    std::fs::write(&p, name).map_err(|e| format!("{}: {e}", p.display()))
}

// ---- ~/.ssh/config — 원격 탐색기 호스트 목록의 원본 (ssh.rs 가 읽는다). 편집기 탭이 통째로 읽고 쓴다

pub fn ssh_config_path() -> Option<PathBuf> {
    crate::ssh::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// 없으면 빈 내용 (첫 편집으로 만든다), 그 외 읽기 실패는 오류
pub fn read_ssh_config() -> Result<String, String> {
    let p = ssh_config_path().ok_or("홈 폴더 없음")?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

/// ~/.ssh 가 없으면 만들고(unix 0700), 새로 만드는 config 는 0600 — ssh 가 권한을 따지는 파일
pub fn write_ssh_config(content: &str) -> Result<(), String> {
    let p = ssh_config_path().ok_or("홈 폴더 없음")?;
    let dir = p.parent().unwrap();
    let fresh = !p.exists();
    if !dir.is_dir() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    std::fs::write(&p, content).map_err(|e| format!("{}: {e}", p.display()))?;
    #[cfg(unix)]
    if fresh {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
