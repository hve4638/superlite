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

use std::io::{BufRead, BufReader, Write};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(verb) = args.next().filter(|v| !v.starts_with('-')) else {
        eprintln!("사용법: superlite <동사> [인자…]  (예: superlite open <경로>, superlite download <경로…> [--wait])");
        std::process::exit(2);
    };
    let rest: Vec<String> = args.collect();
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

/// 요청 한 줄 쓰고 응답 한 줄 읽기 — 데몬은 요청자 연결을 attach 없이 받아 응답 후 끊는다
fn roundtrip(sock: &str, req: &str) -> std::io::Result<String> {
    #[cfg(unix)]
    let mut stream = std::os::unix::net::UnixStream::connect(sock)?;
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

/// 이 프로세스의 제어 터미널 경로 (stderr→stdin→stdout — 파이프에 물려도 하나는 tty 다).
/// Windows 는 tty 개념이 없어 None — 세션 id 환경변수만으로 찾는다
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
    }
    None
}
