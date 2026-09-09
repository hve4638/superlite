//! `superlite-daemon --clean` — 문제 데몬 정리. 사용자가 앱에서 명시적으로 승인했을 때만
//! relay 가 부른다 (로컬은 직접, 원격은 ssh exec). 결과는 stdout 에 한 줄씩 — relay 가
//! 그대로 프론트에 보인다.
//!
//! 하는 일:
//! - 현재 와이어 버전: 락 보유자가 있는데 소켓에 붙을 수 없으면 좀비 — pid 파일의 pid 를
//!   종료하고 소켓·락·pid 파일을 지운다. 락 보유자가 없으면 잔재 파일만 지운다. 소켓이
//!   응답하면 손대지 않는다.
//! - 다른 빌드 (unix, 같은 IPC 디렉터리의 daemon*.lock): 락 보유자가 없는 것만 잔재
//!   파일 삭제. 살아 있는 다른 빌드의 데몬은 건드리지 않는다 — 빌드가 다른 데몬의 공존은 정상이고
//!   (다른 빌드의 백엔드가 쓰는 중일 수 있다), 연결이 없으면 수명 규칙대로 스스로 죽는다.
//! - 헬퍼 배치 캐시 ($HOME/.cache/superlite/bin/<build>/): 데몬이 돌고 있는(락을 쥔) 빌드 폴더
//!   외 전부 삭제 (다음 접속이 다시 올린다). 데몬 기동 직후에도 같은 정리를 한다 (main.rs).

use std::path::Path;
use std::time::{Duration, Instant};

pub fn clean_main() {
    let sock = crate::sock();
    clean_current(&sock);
    #[cfg(unix)]
    clean_other_builds(&sock);
    let n = clean_bin_cache();
    if n > 0 {
        println!("헬퍼 캐시: 다른 빌드 {n}개 삭제");
    }
}

/// 락 시도 — Some(파일) 이면 보유자 없음(이 프로세스가 쥠), None 이면 남이 쥐고 있다
fn try_lock(lock: &Path) -> Option<std::fs::File> {
    let f = superlite_common::open_lock_file(lock).ok()?;
    f.try_lock().ok()?;
    Some(f)
}

fn remove_files(sock: &Path) {
    for p in [sock.to_path_buf(), superlite_common::lock_path(sock), superlite_common::pid_path(sock)] {
        let _ = std::fs::remove_file(p);
    }
}

fn connectable(sock: &Path) -> bool {
    #[cfg(unix)]
    return std::os::unix::net::UnixStream::connect(sock).is_ok();
    #[cfg(windows)]
    return std::fs::OpenOptions::new().read(true).write(true).open(sock).is_ok();
}

fn clean_current(sock: &Path) {
    let lock = superlite_common::lock_path(sock);
    let name = sock.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
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
        println!("{name}: 락 보유자가 소켓에 응답하지 않으나 pid 를 모름 (pid 파일 없음) — 정리 불가");
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
fn clean_other_builds(sock: &Path) {
    let Some(dir) = sock.parent() else { return };
    let current = superlite_common::lock_path(sock);
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let fname = e.file_name().to_string_lossy().into_owned();
        if !fname.starts_with("daemon") || !fname.ends_with(".lock") || p == current {
            continue;
        }
        let old_sock = p.with_extension("sock");
        match try_lock(&p) {
            Some(_held) => {
                remove_files(&old_sock);
                println!("{fname}: 다른 빌드 잔재 — 파일 정리");
            }
            None => println!("{fname}: 다른 빌드 데몬 살아 있음 — 손대지 않음 (연결이 없으면 스스로 종료)"),
        }
    }
}

/// 헬퍼 배치 캐시 — 데몬이 돌고 있는 빌드 폴더만 남긴다. 폴더 이름이 곧 빌드 식별(build_id)이라
/// 그 빌드의 락 파일(daemon-<build>.lock) 보유 여부가 "돈다" 의 판정이다 — 락 파일이 없으면 뜬 적
/// 없는 빌드, 있는데 안 잡히면 죽은 빌드. 이에 더해 IPC 디렉터리의 모든 락 보유자(pid 파일)의 실행 파일
/// 위치(/proc/<pid>/exe, linux)도 "도는 폴더" 다 — 주소가 와이어 번호(daemon-19)였던 옛 빌드의 데몬은
/// 해시 이름의 락이 없어 이것 없이는 실행 중인 폴더가 지워진다 (0.2.2 이하 잔존 데몬 — 지워져도
/// 프로세스는 살지만 그 데몬의 credential helper 경로가 깨진다). macOS 는 /proc 이 없어 옛 빌드
/// 폴더를 못 가린다 — ponytail, 옛 빌드가 사라지면 소멸하는 경로.
/// 자기 폴더는 항상 남긴다 (--clean 은 락을 쥔 쪽이 아니다).
/// 최근 60초 안에 바뀐 폴더는 건너뛴다 — 다른 백엔드의 업로드(mkdir → cat → mv)가 진행 중일 수 있다.
/// 자기 자신이 캐시 밖(로컬 빌드)에서 실행됐으면 무동작 — 이 머신이 남의 원격일 때 올라온 헬퍼는
/// 로컬 정리의 대상이 아니다. 데몬 기동 직후(main.rs)와 --clean 이 같이 쓴다 — 지운 수를 돌려준다
/// (출력은 호출자 몫: --clean 은 stdout, 데몬은 로그)
pub fn clean_bin_cache() -> usize {
    let Some(bin) = superlite_common::cache_dir().map(|d| d.join("bin")) else { return 0 };
    let own = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok()).and_then(|p| p.parent().map(Path::to_path_buf));
    let Some(own) = own.filter(|o| o.parent().and_then(|p| p.canonicalize().ok()).as_deref() == bin.canonicalize().ok().as_deref()) else { return 0 };
    let Ok(entries) = std::fs::read_dir(&bin) else { return 0 };
    let running = running_exe_dirs();
    let mut n = 0;
    for e in entries.flatten() {
        let p = e.path();
        let canon = p.canonicalize().ok();
        if canon.as_deref() == Some(own.as_path()) || canon.is_some_and(|c| running.contains(&c)) {
            continue;
        }
        let fresh = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d < Duration::from_secs(60));
        if fresh {
            continue;
        }
        let id = e.file_name().to_string_lossy().into_owned();
        let lock = superlite_common::lock_path(&superlite_common::socket_path(&id));
        if lock.exists() && try_lock(&lock).is_none() {
            continue; // 그 빌드의 데몬이 돌고 있다
        }
        if std::fs::remove_dir_all(&p).is_ok() {
            n += 1;
        }
    }
    n
}

/// IPC 디렉터리의 락 보유 데몬들이 실행 중인 디렉터리 (canonical) — linux 의 /proc/<pid>/exe 로.
/// 그 외 플랫폼·실패는 빈 집합
fn running_exe_dirs() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    #[cfg(target_os = "linux")]
    {
        let Ok(entries) = std::fs::read_dir(superlite_common::ipc_dir()) else { return out };
        for e in entries.flatten() {
            let p = e.path();
            let fname = e.file_name().to_string_lossy().into_owned();
            if !fname.starts_with("daemon") || !fname.ends_with(".lock") || try_lock(&p).is_some() {
                continue;
            }
            let pid = std::fs::read_to_string(p.with_extension("pid")).ok().and_then(|s| s.trim().parse::<u32>().ok());
            let Some(pid) = pid else { continue };
            if let Some(dir) = std::fs::read_link(format!("/proc/{pid}/exe")).ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
                out.push(dir);
            }
        }
    }
    out
}

fn kill(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
    }
}
