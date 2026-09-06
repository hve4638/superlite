//! 빌드 정보 — git 커밋(짧은 해시, 미커밋 변경이 있으면 -dirty)과 빌드 시각을 env 로 굽는다.
//! 데몬·relay·앱이 같은 crate 의 값을 읽으므로 세 바이너리의 표기가 어긋나지 않는다.
//!
//! 재실행 조건은 HEAD·가리키는 ref 파일 — 커밋이 바뀌면 다시 돈다. 작업 트리 변경(dirty)은
//! 감지 대상이 아니라 마지막 실행 시점 값이 남는다. ponytail: 저장소 전체를 감시하면 매 빌드가
//! 전체 재빌드가 되므로 두지 않는다 — 배포 빌드(build.sh)는 이 파일을 touch 해 강제 재실행한다.
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let commit = match git(&["rev-parse", "--short", "HEAD"]) {
        Some(h) => {
            let dirty = git(&["status", "--porcelain", "--untracked-files=no"])
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if dirty { format!("{h}-dirty") } else { h }
        }
        None => "unknown".into(), // git 부재·tarball — 버전만으로 식별한다
    };
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        // 워크트리의 HEAD 는 refs/heads/<branch> 를 가리킨다 — ref 파일은 공용 git dir 에 있다
        if let (Some(common), Some(r)) =
            (git(&["rev-parse", "--git-common-dir"]), git(&["symbolic-ref", "-q", "HEAD"]))
        {
            println!("cargo:rerun-if-changed={common}/{r}");
            println!("cargo:rerun-if-changed={common}/packed-refs");
        }
    }
    println!("cargo:rustc-env=SUPERLITE_COMMIT={commit}");
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=SUPERLITE_BUILT_AT={}", utc_iso(secs));
}

/// UNIX 초 → `YYYY-MM-DDTHH:MM:SSZ` (chrono 의존 없이 — civil-from-days 알고리즘)
fn utc_iso(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}
