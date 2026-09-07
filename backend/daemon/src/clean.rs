//! `superlite-daemon --clean` — 문제 데몬 정리. 사용자가 앱에서 명시적으로 승인했을 때만
//! relay 가 부른다 (로컬은 직접, 원격은 ssh exec). 결과는 stdout 에 한 줄씩 — relay 가
//! 그대로 프론트에 보인다.
//!
//! 하는 일:
//! - 현재 와이어 버전: 락 보유자가 있는데 소켓에 붙을 수 없으면 좀비 — pid 파일의 pid 를
//!   종료하고 소켓·락·pid 파일을 지운다. 락 보유자가 없으면 잔재 파일만 지운다. 소켓이
//!   응답하면 손대지 않는다.
//! - 현재 와이어 버전의 두 데몬(파일 daemon-<N>, 터미널 term-<M>) 각각 위 규칙.
//! - 과거 와이어 버전 (unix, 같은 IPC 디렉터리의 daemon*.lock·term*.lock): 락 보유자가 없는 것만 잔재
//!   파일 삭제. 살아 있는 옛 데몬은 건드리지 않는다 — 와이어가 다른 데몬의 공존은 정상이고
//!   (다른 빌드의 백엔드가 쓰는 중일 수 있다), 연결이 없으면 수명 규칙대로 스스로 죽는다.
//! - 헬퍼 배치 캐시 ($HOME/.cache/superlite/bin/<hash>/): 자기 자신이 실행 중인
//!   디렉터리 외 전부 삭제 (다음 접속이 다시 올린다).

use std::path::Path;
use std::time::{Duration, Instant};

pub fn clean_main() {
    let sock = superlite_common::socket_path();
    let term = superlite_common::term_socket_path();
    clean_current(&sock);
    clean_current(&term);
    #[cfg(unix)]
    clean_old_versions(&sock, &term);
    clean_bin_cache();
}

/// 락 시도 — Some(파일) 이면 보유자 없음(이 프로세스가 쥠), None 이면 남이 쥐고 있다
fn try_lock(lock: &Path) -> Option<std::fs::File> {
    let f = superlite_common::open_lock_file(lock).ok()?;
    f.try_lock().ok()?;
    Some(f)
}

fn remove_files(sock: &Path) {
    for p in [
        sock.to_path_buf(),
        superlite_common::lock_path(sock),
        superlite_common::pid_path(sock),
    ] {
        let _ = std::fs::remove_file(p);
    }
}

fn connectable(sock: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::net::UnixStream::connect(sock).is_ok();
    #[cfg(windows)]
    return std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(sock)
        .is_ok();
}

fn clean_current(sock: &Path) {
    let lock = superlite_common::lock_path(sock);
    let name = sock
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(_held) = try_lock(&lock) {
        // 보유자 없음 — 소켓·pid 파일이 남아 있다면 crash 잔재
        remove_files(sock);
        println!("{name}: 데몬 없음 — 잔재 파일 정리");
        return;
    }
    if connectable(sock) {
        println!("{name}: 데몬 정상 응답 — 손대지 않음");
        return;
    }
    let pid = std::fs::read_to_string(superlite_common::pid_path(sock))
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    let Some(pid) = pid else {
        println!("{name}: 락 보유자가 소켓에 응답하지 않으나 pid 를 모름 (pid 파일 없음 — 구 빌드 데몬) — 정리 불가");
        return;
    };
    kill(pid);
    // 락은 프로세스 종료와 함께 풀린다 — 풀릴 때까지 잠깐 기다린다
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Some(_held) = try_lock(&lock) {
            remove_files(sock);
            println!("{name}: 좀비 데몬 종료 (pid {pid}) — 잔재 파일 정리");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("{name}: pid {pid} 종료 요청 후에도 락이 풀리지 않음 — 정리 실패");
}

#[cfg(unix)]
fn clean_old_versions(sock: &Path, term: &Path) {
    let Some(dir) = sock.parent() else { return };
    let current = [
        superlite_common::lock_path(sock),
        superlite_common::lock_path(term),
    ];
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let fname = e.file_name().to_string_lossy().into_owned();
        let ours = fname.starts_with("daemon") || fname.starts_with("term");
        if !ours || !fname.ends_with(".lock") || current.contains(&p) {
            continue;
        }
        let old_sock = p.with_extension("sock");
        match try_lock(&p) {
            Some(_held) => {
                remove_files(&old_sock);
                println!("{fname}: 옛 버전 잔재 — 파일 정리");
            }
            None => println!(
                "{fname}: 옛 버전 데몬 살아 있음 — 손대지 않음 (연결이 없으면 스스로 종료)"
            ),
        }
    }
}

/// 헬퍼 배치 캐시 — 자기 실행 파일이 든 디렉터리만 남긴다. 자기 자신이 캐시 밖(로컬 빌드)에서
/// 실행됐으면 건드리지 않는다 — 이 머신이 남의 원격일 때 올라온 헬퍼는 로컬 정리의 대상이 아니다
fn clean_bin_cache() {
    let Some(bin) = superlite_common::cache_dir().map(|d| d.join("bin")) else {
        return;
    };
    let own = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let Some(own) = own.filter(|o| {
        o.parent().and_then(|p| p.canonicalize().ok()).as_deref()
            == bin.canonicalize().ok().as_deref()
    }) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&bin) else {
        return;
    };
    let mut n = 0;
    for e in entries.flatten() {
        let p = e.path();
        if p.canonicalize().ok().as_deref() == Some(own.as_path()) {
            continue;
        }
        if std::fs::remove_dir_all(&p).is_ok() {
            n += 1;
        }
    }
    if n > 0 {
        println!("헬퍼 캐시: 옛 바이너리 {n}개 삭제");
    }
}

fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
}
