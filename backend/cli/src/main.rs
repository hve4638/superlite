//! `superlite <동사> [인자…]` — superlite 터미널 안에서 에디터를 조작하는 셸 심 (ticket
//! cli-control-discussion). 동사를 해석하지 않는다: argv 를 그대로 데몬의 frontRequest 에 실어
//! 그 터미널을 보는 프론트 세션으로 보내고, 응답 한 줄을 기다린다 (와이어 v9 통로 —
//! `{"id","method":"frontRequest","params":{"session","tty","method":<동사>,"params":{args,cwd}}}`).
//! 동사 목록과 의미는 프론트(front/src/model/host.ts handleRequest)가 정한다 — 새 동사는 심을
//! 고치지 않고 프론트에만 더한다. 좌표는 데몬이 PTY 환경에 심은 SUPERLITE_SOCK(이 터미널의
//! 데몬 — 원격이면 원격 데몬)·SUPERLITE_SESSION(폴백)과 자기 tty (데몬 resolve_requester 가
//! "지금 이 터미널을 보는 세션" 을 고른다). 데몬 바이너리와 별개의 소형 바이너리 — 데몬 옆
//! `cli/` 폴더에 `superlite` 와 `sl` 링크로 놓이고 데몬이 그 폴더를 PATH 앞에 넣는다.
//! 종료 코드: 0 성공(result 가 문자열이면 stdout 에), 1 에러(stderr), 2 사용법.
//!
//! 예외 동사 `agent-event` (ticket agent-hooks-status): 에이전트 훅(Claude Code hooks 등)이 부른다.
//! frontRequest 가 아니라 데몬 직접 요청 `agentEvent` 로 간다 — 상태는 응답이 필요 없고 그 tmux 세션을
//! 보는 모든 프론트에 방송돼야 하며, 프론트가 없어도 데몬이 세션 id 별 마지막 상태를 캐시해야 한다
//! (사용자 결정 2026-09-13). stdin JSON 을 그대로 싣고 `--agent <이름>` 만 읽는다. 에이전트를 붙잡지
//! 않도록 0.5초 타임아웃, 어떤 실패도 조용히 exit 0 (훅 실패가 에이전트 화면에 오류로 뜨지 않게).

use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(verb) = args.next().filter(|v| !v.starts_with('-')) else {
        eprintln!("Usage: superlite <verb> [args...]  (e.g. superlite open <path>, superlite download <path...> [--wait])");
        std::process::exit(2);
    };
    let rest: Vec<String> = args.collect();
    if verb == "agent-event" {
        agent_event(&rest);
        return;
    }
    let Ok(sock) = std::env::var("SUPERLITE_SOCK") else {
        eprintln!("superlite: SUPERLITE_SOCK 없음 — superlite 앱의 터미널 안에서만 쓸 수 있다");
        std::process::exit(1);
    };
    let session = std::env::var("SUPERLITE_SESSION").ok();
    let tty = ctty_name();
    if session.is_none() && tty.is_none() {
        eprintln!("superlite: 세션 좌표 없음 (SUPERLITE_SESSION·tty 둘 다 없음)");
        std::process::exit(1);
    }
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let req = serde_json::json!({
        "id": 1, "method": "frontRequest",
        "params": {"session": session, "tty": tty, "method": verb, "params": {"args": rest, "cwd": cwd}},
    });
    let line = match roundtrip(&sock, &format!("{req}\n")) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("superlite: 데몬 접속 실패 {sock}: {e}");
            std::process::exit(1);
        }
    };
    let resp: serde_json::Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("superlite: 응답 해석 실패");
            std::process::exit(1);
        }
    };
    if let Some(e) = resp["error"].as_str() {
        eprintln!("superlite: {e}");
        std::process::exit(1);
    }
    if let Some(s) = resp["result"].as_str() {
        println!("{s}");
    }
}

/// 에이전트 훅 → 데몬 `agentEvent` (ticket agent-hooks-status). stdin 의 훅 JSON(hook_event_name 등)을
/// 그대로 event 에 싣는다. 좌표는 일반 동사와 같은 tty·SUPERLITE_SESSION — 훅 프로세스는 stdin·stdout·
/// stderr 가 전부 파이프라 ttyname 이 실패하므로 ctty_name 이 /proc/self/stat 의 제어 tty 로 폴백한다.
/// 어떤 경우에도 exit 0·무출력: 훅 명령의 실패는 에이전트 화면에 오류로 뜬다
fn agent_event(rest: &[String]) {
    let Ok(sock) = std::env::var("SUPERLITE_SOCK") else { return };
    let agent = rest
        .iter()
        .position(|a| a == "--agent")
        .and_then(|i| rest.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let event: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let req = serde_json::json!({
        "id": 1, "method": "agentEvent",
        "params": {
            "session": std::env::var("SUPERLITE_SESSION").ok(), "tty": ctty_name(),
            "agent": agent, "event": event,
        },
    });
    let _ = roundtrip_timeout(&sock, &format!("{req}\n"), Some(Duration::from_millis(500)));
}

/// 요청 한 줄 쓰고 응답 한 줄 읽기 — 데몬은 요청자 연결을 attach 없이 받아 응답 후 끊는다
fn roundtrip(sock: &str, req: &str) -> std::io::Result<String> {
    roundtrip_timeout(sock, req, None)
}

/// roundtrip 본체 — timeout 이 있으면 읽기·쓰기 상한 (unix 소켓만, Windows 파일 핸들은 상한 없음)
fn roundtrip_timeout(sock: &str, req: &str, timeout: Option<Duration>) -> std::io::Result<String> {
    #[cfg(unix)]
    let mut stream = std::os::unix::net::UnixStream::connect(sock)?;
    #[cfg(unix)]
    {
        stream.set_read_timeout(timeout)?;
        stream.set_write_timeout(timeout)?;
    }
    #[cfg(windows)]
    let _ = timeout;
    // Windows named pipe 는 CreateFile 로 열린다 — 바이트 모드 양방향 파일 핸들
    #[cfg(windows)]
    let mut stream = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(sock)?;
    stream.write_all(req.as_bytes())?;
    stream.flush()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    if line.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "응답 없음",
        ));
    }
    Ok(line)
}

/// 이 프로세스의 제어 터미널 경로 (stderr→stdin→stdout — 파이프에 물려도 보통 하나는 tty 다).
/// 셋 다 파이프면(에이전트 훅) Linux 의 /proc/self/stat tty_nr 로 제어 tty 를 찾는다 — cmux 가 proc_bsdinfo
/// e_tdev 로 하는 것과 같은 대응. Windows 는 tty 개념이 없어 None — 세션 id 환경변수만으로 찾는다
fn ctty_name() -> Option<String> {
    #[cfg(unix)]
    {
        for fd in [2, 0, 1] {
            // SAFETY: ttyname 은 정적 버퍼를 돌려준다 — 단일 스레드 시점에 즉시 복사한다
            let p = unsafe { libc::ttyname(fd) };
            if !p.is_null() {
                return Some(
                    unsafe { std::ffi::CStr::from_ptr(p) }
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        return proc_ctty();
    }
    #[allow(unreachable_code)]
    None
}

/// /proc/<pid>/stat 의 tty_nr → /dev/pts/N (pts major 136~143). 자기 프로세스에 제어 tty 가 없으면(Claude Code 는
/// 훅을 detached — setsid — 로 띄워 tty_nr 이 0 이다, 실측 2026-09-13) 부모를 따라 올라가며 처음 만나는 제어 tty 를
/// 쓴다 — 훅 sh 의 부모가 pane 안의 에이전트 프로세스라 그 tty 가 곧 pane tty 다. Linux 밖·pts 아님·없음은 None
#[cfg(unix)]
fn proc_ctty() -> Option<String> {
    let mut pid = std::process::id();
    for _ in 0..32 {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm 필드는 괄호 안에 공백이 올 수 있다 — 마지막 ')' 뒤부터 나눈다
        let rest = &stat[stat.rfind(')')? + 1..];
        let mut it = rest.split_whitespace();
        let ppid: u32 = it.nth(1)?.parse().ok()?;
        let tty_nr: u64 = it.nth(2)?.parse().ok()?;
        if tty_nr != 0 {
            let major = (tty_nr >> 8) & 0xfff;
            let minor = (tty_nr & 0xff) | ((tty_nr >> 12) & 0xfff00);
            if !(136..=143).contains(&major) {
                return None;
            }
            let path = format!("/dev/pts/{}", (major - 136) * 256 + minor);
            return std::path::Path::new(&path).exists().then_some(path);
        }
        if ppid <= 1 {
            return None;
        }
        pid = ppid;
    }
    None
}
