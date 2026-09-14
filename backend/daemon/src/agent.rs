//! 에이전트 상태 (와이어 v24, ticket agent-hooks-status) — 에이전트 훅(Claude Code hooks)이 셸 심
//! `superlite agent-event` 로 보낸 사건을 tmux 세션 id 단위의 정규화 상태(running / needsInput / idle /
//! exited)로 접고, 마지막 상태를 세션 id 별로 캐시한다. 방송(termAgent)은 main 이 attach 된 모든 세션에
//! 한다 — 프론트가 tmux 세션 id → 열린 탭·카드·사이드바 행으로 사영한다. 캐시는 listTerminals 항목의
//! `agent` 필드로도 나가 늦게 붙는 탭·아무 탭도 안 붙은 세션의 사이드바가 같은 값을 본다.
//!
//! 훅 설치기(agentHooks): 사용자 동의 뒤 이 머신(원격이면 원격) 홈의 `~/.claude/settings.json` 에
//! superlite 항목만 병합 기록·제거한다 (사용자 결정 2026-09-13 — orca 방식). 훅 명령은 SUPERLITE_SOCK
//! 이 없으면 즉시 종료하므로 superlite 밖에서 돌려도 무해하다.
//!
//! ponytail: 캐시는 데몬 수명. exited 뒤 항목도 남는다 (tmux 세션 id 는 단조 증가라 재사용되지 않는다).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

/// 세션 id 별 마지막 상태 — 데몬 전역 (세션·연결과 무관, 요청자는 attach 없이 온다)
static CACHE: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

/// 훅 명령의 표식 — 설치·제거가 자기 항목을 알아보는 문자열
const HOOK_MARK: &str = "superlite agent-event";

/// 정규화 — 훅 이름·payload → (state, detail). None 이면 상태에 반영하지 않는 사건 (idle_prompt 리마인더 등).
/// Claude Code: UserPromptSubmit·PostToolUse·PreToolUse → running (AskUserQuestion·ExitPlanMode 는 needsInput),
/// PermissionRequest·Notification(permission_prompt·elicitation_dialog) → needsInput, Stop → idle,
/// SessionStart → idle (뜬 채 입력 대기), SessionEnd → exited. SubagentStop 은 걸지 않는다
fn normalize(event: &Value) -> Option<(&'static str, Value)> {
    let hook = event["hook_event_name"].as_str()?;
    let mut detail = json!({ "hook": hook });
    let state = match hook {
        "SessionStart" | "Stop" => "idle",
        "SessionEnd" => "exited",
        "UserPromptSubmit" | "PostToolUse" => "running",
        "PermissionRequest" => "needsInput",
        "PreToolUse" => {
            let tool = event["tool_name"].as_str().unwrap_or("");
            detail["tool"] = json!(tool);
            if matches!(tool, "AskUserQuestion" | "ExitPlanMode") { "needsInput" } else { "running" }
        }
        "Notification" => {
            let typ = event["notification_type"].as_str().unwrap_or("");
            if !matches!(typ, "permission_prompt" | "elicitation_dialog") {
                return None;
            }
            detail["type"] = json!(typ);
            if let Some(m) = event["message"].as_str() {
                detail["message"] = json!(m);
            }
            "needsInput"
        }
        _ => return None,
    };
    Some((state, detail))
}

/// 사건 기록 — 캐시 갱신 후 방송할 termAgent 이벤트를 돌려준다. 반영하지 않는 사건은 None
pub(crate) fn record(tmux_id: &str, agent: &str, event: &Value) -> Option<Value> {
    let (state, detail) = normalize(event)?;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let status = json!({ "agent": agent, "state": state, "detail": detail, "at": at });
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(tmux_id.to_string(), status.clone());
    let mut ev = status;
    ev["event"] = json!("termAgent");
    ev["tmuxId"] = json!(tmux_id);
    Some(ev)
}

/// listTerminals 항목에 실을 마지막 상태 (와이어 v24) — 없으면 None (필드 생략)
pub(crate) fn status_of(tmux_id: &str) -> Option<Value> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(tmux_id).cloned()
}

/// Claude Code 훅 설정 경로 — 이 머신의 `~/.claude/settings.json` (원격 데몬이면 원격 홈)
fn claude_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("홈 디렉터리를 모른다 (HOME 없음)")?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

/// Claude Code 훅 항목 — 이벤트별 [{matcher?, hooks:[{type:command, command, timeout}]}]. 명령은 sh 로 실행되며
/// SUPERLITE_SOCK·심이 없으면 아무것도 하지 않고 exit 0 — superlite 밖에서 돌린 claude 에 오류가 뜨지 않게
fn claude_hook_entries() -> Vec<(&'static str, Value)> {
    const EVENTS: [&str; 8] = [
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd",
    ];
    let command = format!("if [ -n \"$SUPERLITE_SOCK\" ] && command -v superlite >/dev/null 2>&1; then {HOOK_MARK} --agent claude; fi; exit 0");
    EVENTS
        .iter()
        .map(|ev| (*ev, json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] })))
        .collect()
}

/// 훅 설치·제거 (agentHooks{agent, action: install|uninstall}) — settings.json 을 읽어 hooks 의 각 이벤트에서
/// 표식(HOOK_MARK)이 든 항목만 지우고, install 이면 우리 항목을 뒤에 붙인다. 사용자 항목은 그대로.
/// 파일·hooks 가 없으면 만든다. 반환 {path, installed}
pub(crate) fn hooks(agent: &str, action: &str) -> Result<Value, String> {
    if agent != "claude" {
        return Err(format!("지원하지 않는 에이전트: {agent}"));
    }
    let path = claude_settings_path()?;
    let mut root: Value = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| format!("{} 해석 실패: {e}", path.display()))?,
        Ok(_) => json!({}),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("{} 읽기 실패: {e}", path.display())),
    };
    if !root.is_object() {
        return Err(format!("{} 의 최상위가 객체가 아니다", path.display()));
    }
    if !root["hooks"].is_object() {
        root["hooks"] = json!({});
    }
    let hooks = root["hooks"].as_object_mut().unwrap();
    let ours = |entry: &Value| {
        entry["hooks"]
            .as_array()
            .is_some_and(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(HOOK_MARK))))
    };
    for (_, entries) in hooks.iter_mut() {
        if let Some(arr) = entries.as_array_mut() {
            arr.retain(|e| !ours(e));
        }
    }
    let install = match action {
        "install" => true,
        "uninstall" => false,
        _ => return Err(format!("알 수 없는 action: {action}")),
    };
    if install {
        for (ev, entry) in claude_hook_entries() {
            let slot = hooks.entry(ev).or_insert_with(|| json!([]));
            if !slot.is_array() {
                *slot = json!([]);
            }
            slot.as_array_mut().unwrap().push(entry);
        }
    }
    hooks.retain(|_, v| v.as_array().is_some_and(|a| !a.is_empty()));
    if hooks.is_empty() {
        root.as_object_mut().unwrap().remove("hooks");
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{} 생성 실패: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&path, text).map_err(|e| format!("{} 쓰기 실패: {e}", path.display()))?;
    Ok(json!({ "path": path.to_string_lossy(), "installed": install }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_claude_events() {
        let s = |v: Value| normalize(&v).map(|(s, _)| s);
        assert_eq!(s(json!({"hook_event_name": "UserPromptSubmit"})), Some("running"));
        assert_eq!(s(json!({"hook_event_name": "PreToolUse", "tool_name": "Bash"})), Some("running"));
        assert_eq!(s(json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"})), Some("needsInput"));
        assert_eq!(s(json!({"hook_event_name": "PermissionRequest"})), Some("needsInput"));
        assert_eq!(s(json!({"hook_event_name": "Notification", "notification_type": "idle_prompt"})), None);
        assert_eq!(s(json!({"hook_event_name": "Notification", "notification_type": "permission_prompt"})), Some("needsInput"));
        assert_eq!(s(json!({"hook_event_name": "Stop"})), Some("idle"));
        assert_eq!(s(json!({"hook_event_name": "SessionEnd"})), Some("exited"));
        assert_eq!(s(json!({"hook_event_name": "SubagentStop"})), None);
        assert_eq!(s(json!({})), None);
    }

    #[test]
    fn hooks_install_merges_and_uninstall_restores() {
        let dir = std::env::temp_dir().join(format!("superlite-agent-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let path = dir.join(".claude").join("settings.json");
        std::fs::write(&path, r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}"#).unwrap();
        std::env::set_var("HOME", &dir);
        hooks("claude", "install").unwrap();
        hooks("claude", "install").unwrap(); // 두 번 설치해도 항목은 하나
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["model"], "opus");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "echo mine");
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains(HOOK_MARK));
        assert!(v["hooks"]["PermissionRequest"].is_array());
        hooks("claude", "uninstall").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(v["hooks"].get("PermissionRequest").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
