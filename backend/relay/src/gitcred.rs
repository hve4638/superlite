//! git 자격 저장소 (ticket scm-subrepo-credential, 2026-09-08 결정: 앱·웹 모두 VS Code SecretStorage
//! 수준) — 토큰은 이 머신(relay 가 도는 사용자 머신)의 OS 키체인에 둔다: keyring 크레이트로 Windows
//! 자격 증명 관리자·macOS Keychain·Linux Secret Service. 목록(호스트·사용자명·라벨)은 키체인이
//! 열거를 지원하지 않아 config_dir/git-credentials.json 에 따로 든다. 키체인이 없는 환경(헤드리스
//! linux — D-Bus 세션 없음)은 토큰도 그 파일에 둔다 (unix 0600, 항목의 `insecure` 표식 — 프론트가
//! 대화상자에 안내). VS Code 도 키체인 부재 시 같은 강등을 한다.
//!
//! 앱은 relay 를 내장하고 웹은 이 relay 에 붙으므로 저장 경로가 하나다. 프론트(gitauth)는 브라우저
//! 저장소에 토큰을 남기지 않고 git 이 물을 때마다 받아 메모리로만 쓴다 — 접속한 브라우저마다 사본이
//! 남거나 XSS 로 읽히는 localStorage 를 피한다. ssh 원격 워크스페이스도 로컬 relay 의 이 저장소에서
//! 원격 git 으로 요청 때만 전달된다. 인증·CORS 는 /ssh/* 와 같다 (lib.rs 핸들러).
//!
//! ponytail: 호스트별 항목 하나. 키체인 호출은 블로킹이라 spawn_blocking.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 키체인 service 이름 — 채널별 분리 (dev·stable 이 서로의 토큰을 보지 않게)
fn service() -> String {
    format!("{}-git", superlite_common::SLUG)
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Item {
    host: String,
    username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    /// 키체인 강등분만 — 키체인에 넣었으면 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
}

fn path() -> Option<PathBuf> {
    superlite_common::config_dir().map(|d| d.join("git-credentials.json"))
}

fn load() -> Vec<Item> {
    path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(items: &[Item]) -> Result<(), String> {
    let p = path().ok_or("설정 디렉터리 없음")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn entry(host: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&service(), host).map_err(|e| e.to_string())
}

/// 키체인 사용 가능 여부 — 없는 항목 조회가 NoEntry 로 돌아오면 있는 것, 플랫폼 오류면 없는 것.
/// 호출마다 재판정 (데스크톱 세션이 나중에 생길 수 있다)
fn keychain_available() -> bool {
    match keyring::Entry::new(&service(), "__probe__").and_then(|e| e.get_password()) {
        Ok(_) | Err(keyring::Error::NoEntry) => true,
        Err(_) => false,
    }
}

/// GET 목록 — {keychain, items:[{host, username, label?, insecure}]} (토큰 없음)
pub(crate) async fn list() -> Value {
    tokio::task::spawn_blocking(|| {
        let items: Vec<Value> = load()
            .iter()
            .map(|i| json!({"host": i.host, "username": i.username, "label": i.label, "insecure": i.secret.is_some()}))
            .collect();
        json!({"keychain": keychain_available(), "items": items})
    })
    .await
    .unwrap_or_else(|e| json!({"keychain": false, "items": [], "error": e.to_string()}))
}

/// 호스트 하나의 자격 — {username, secret, label?} 또는 null
pub(crate) async fn get(host: String) -> Value {
    tokio::task::spawn_blocking(move || {
        let Some(item) = load().into_iter().find(|i| i.host == host) else { return Value::Null };
        let secret = match &item.secret {
            Some(s) => s.clone(),
            None => match entry(&host).and_then(|e| e.get_password().map_err(|e| e.to_string())) {
                Ok(s) => s,
                Err(_) => return Value::Null,
            },
        };
        json!({"username": item.username, "secret": secret, "label": item.label})
    })
    .await
    .unwrap_or(Value::Null)
}

/// 저장 — 키체인에 먼저, 실패하면 파일에 (insecure). 반환 {insecure}
pub(crate) async fn set(host: String, username: String, label: Option<String>, secret: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let in_keychain = entry(&host).and_then(|e| e.set_password(&secret).map_err(|e| e.to_string())).is_ok();
        let mut items: Vec<Item> = load().into_iter().filter(|i| i.host != host).collect();
        items.push(Item { host, username, label, secret: (!in_keychain).then_some(secret) });
        save(&items)?;
        Ok(json!({"insecure": !in_keychain}))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn delete(host: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if let Ok(e) = entry(&host) {
            let _ = e.delete_credential();
        }
        let items: Vec<Item> = load().into_iter().filter(|i| i.host != host).collect();
        save(&items)
    })
    .await
    .map_err(|e| e.to_string())?
}
