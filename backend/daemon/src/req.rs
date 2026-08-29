//! RPC 요청 처리 — fs 읽기/쓰기(etag 낙관적 충돌 검사)·rg 검색·git 상태/커밋.
//! 모든 경로는 safe_join 관문을 지난다.

use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

use crate::err;

/// (mtime_ms, size) 기반 etag — VS Code 와 동일한 구성. 내용 해시가 아니라 stat 스냅샷이다.
fn file_etag(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        // mtime 미지원 fs 에선 0 — etag 가 크기 전용으로 강등된다 (리눅스에선 사실상 없음)
        .unwrap_or(0);
    format!("{mtime}-{}", meta.len())
}

// WHY: 요청은 태스크로 병렬 처리된다 — etag 검사→쓰기가 다른 쓰기와 끼어들면 검사가 무의미.
// ponytail: 전역 쓰기 락 + 락 안 블로킹 fs 호출 — 병목이 실측되면 경로별 락 + spawn_blocking.
static WRITE_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// 트리(readDir)에서 숨기는 basename — VS Code files.exclude 기본값.
/// node_modules 는 VS Code 기본과 동일하게 트리에 보인다.
/// ponytail: 설정 시스템이 없어 하드코딩 — 사용자 설정이 생기면 여기로 합류.
const FILES_EXCLUDED: [&str; 5] = [".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"];

/// 검색·listFiles 공통 rg 인자 — VS Code 와 동일하게 dotfile 을 포함(--hidden)하되
/// files.exclude + search.exclude 기본값(node_modules 등)을 글롭으로 제외한다.
/// ignore 파일은 워크스페이스 안의 것만 존중한다 — VS Code 기본과 동일
/// (useIgnoreFiles=true, useParentIgnoreFiles/useGlobalIgnoreFiles=false).
/// --no-require-git 만 주면 부모·글로벌 gitignore 까지 새어 들어와 파일이 조용히 사라진다.
const RG_EXCLUDE_ARGS: [&str; 20] = [
    "--hidden",
    "--no-require-git",
    "--no-ignore-parent",
    "--no-ignore-global",
    "-g", "!**/.git",
    "-g", "!**/.svn",
    "-g", "!**/.hg",
    "-g", "!**/.DS_Store",
    "-g", "!**/Thumbs.db",
    "-g", "!**/node_modules",
    "-g", "!**/bower_components",
    "-g", "!**/*.code-search",
];

pub(crate) async fn handle_req(method: &str, p: &Value, root: &Path) -> Result<Value, String> {
    match method {
        "workspace" => Ok(json!({
            "name": root.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
            "rootPath": root.to_string_lossy(),
        })),
        "readDir" => {
            let rel = p["path"].as_str().unwrap_or("");
            let dir = safe_join(root, rel)?;
            let mut out = Vec::new();
            for ent in std::fs::read_dir(&dir).map_err(err)? {
                let ent = ent.map_err(err)?;
                let name = ent.file_name().to_string_lossy().into_owned();
                if FILES_EXCLUDED.contains(&name.as_str()) {
                    continue;
                }
                let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                // WHY: file_type() 은 심링크를 안 따라간다 — node_modules 의 심링크 디렉터리가
                //      file 로 보인다. metadata() 는 따라간다 (깨진 링크는 file 취급).
                let is_dir = std::fs::metadata(ent.path()).map(|m| m.is_dir()).unwrap_or(false);
                let kind = if is_dir { "directory" } else { "file" };
                out.push(json!({"name": name, "path": path, "kind": kind}));
            }
            Ok(Value::Array(out))
        }
        "readFile" => {
            let path = safe_join(root, req_path(p)?)?;
            let _g = WRITE_LOCK.lock().await;
            // WHY: stat 이 read 뒤면 etag 가 내용보다 새것일 수 있다 — 그 etag 로 저장하면
            //      최신 내용을 조용히 덮는다. stat 먼저면 최악이 스퓨리어스 충돌(내용 비교
            //      탈출구가 거른다). 데몬 자신의 쓰기와는 락으로 안 겹친다.
            let meta = std::fs::metadata(&path).map_err(err)?;
            // 크기 상한이 있는 호출(undo 캡처 등)은 읽기 전에 거른다 — 대용량을 읽어
            // 나른 뒤 버리는 낭비 방지
            if let Some(max) = p["maxBytes"].as_u64() {
                if meta.len() > max {
                    return Err(format!("maxBytes 초과: {} > {max}", meta.len()));
                }
            }
            let content = std::fs::read_to_string(&path).map_err(err)?;
            Ok(json!({"content": content, "etag": file_etag(&meta)}))
        }
        "stat" => {
            let path = safe_join(root, req_path(p)?)?;
            // WHY: readFile 과 같은 락 — orphan 재검증의 응답 순서가 쓰기와의 직렬화에 기댄다
            let _g = WRITE_LOCK.lock().await;
            let meta = std::fs::metadata(&path).map_err(err)?;
            // 정규 파일 전용 — 같은 경로의 디렉토리에 성공하면 재검증이 "파일 실존" 으로 오판한다
            if !meta.is_file() {
                return Err("정규 파일이 아니다".into());
            }
            Ok(json!({"etag": file_etag(&meta)}))
        }
        "writeFile" => {
            // WHY: content 누락을 "" 로 해석하면 깨진 요청이 파일을 비운다 — 명시적 에러
            let content = p["content"].as_str().ok_or("content 필요")?;
            let path = safe_join(root, req_path(p)?)?;
            let _g = WRITE_LOCK.lock().await;
            // 낙관적 충돌 검사 (VS Code FILE_MODIFIED_SINCE 상당). etag 없으면 무조건 쓴다
            // (덮어쓰기·신규 파일). 파일이 사라진 경우는 쓰기로 진행 — 저장이 파일을 되살린다.
            if let Some(expected) = p["etag"].as_str() {
                match std::fs::metadata(&path) {
                    // etag 불일치라도 디스크가 이미 쓰려는 내용이면 충돌이 아니다 (탈출구).
                    // read 실패(EISDIR 등)는 충돌로 위장하지 않고 에러로 낸다.
                    Ok(meta) => {
                        if file_etag(&meta) != expected
                            && std::fs::read(&path).map_err(err)? != content.as_bytes()
                        {
                            return Ok(json!({"conflict": true}));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(err(e)), // 권한 등 — "없음" 으로 오독하면 검사가 무단 통과
                }
            }
            std::fs::write(&path, content).map_err(err)?;
            Ok(json!({"etag": file_etag(&std::fs::metadata(&path).map_err(err)?)}))
        }
        "createFile" => {
            let path = safe_join(root, req_path(p)?)?;
            let _g = WRITE_LOCK.lock().await;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(err)?; // "a/b/c.ts" 중첩 생성 (VS Code 동일)
            }
            // WHY: 배타적 생성 — write("") 로 때우면 "새 파일" 이 기존 파일을 조용히 비운다
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(err)?;
            Ok(Value::Null)
        }
        "createDir" => {
            let path = safe_join(root, req_path(p)?)?;
            let _g = WRITE_LOCK.lock().await;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
            // WHY: mkdir -p 로 때우면 "이미 있던 폴더" 에도 성공해 undo(재귀 삭제)가 남의
            //      내용을 지운다 — 생성이 배타적이어야 "내가 만든 것만 지운다" 가 성립한다
            std::fs::create_dir(&path).map_err(err)?;
            Ok(Value::Null)
        }
        "rename" => {
            let from_rel = p["from"].as_str().ok_or("from 필요")?;
            let to_rel = p["to"].as_str().ok_or("to 필요")?;
            if from_rel.is_empty() || to_rel.is_empty() {
                return Err("빈 경로 — 루트는 rename 대상이 아니다".into());
            }
            let from = safe_join(root, from_rel)?;
            let to = safe_join(root, to_rel)?;
            let _g = WRITE_LOCK.lock().await;
            // WHY: std::fs::rename 은 기존 파일을 소리 없이 덮는다 — 대상 존재는 명시적 에러.
            //      symlink_metadata: 깨진 심링크도 "존재" 다 (덮으면 링크가 사라진다)
            if std::fs::symlink_metadata(&to).is_ok() {
                return Err(format!("이미 존재: {to_rel}"));
            }
            std::fs::rename(&from, &to).map_err(err)?;
            Ok(Value::Null)
        }
        "delete" => {
            let rel = req_path(p)?;
            if rel.is_empty() {
                return Err("빈 경로 — 루트는 지울 수 없다".into());
            }
            let path = safe_join(root, rel)?;
            let _g = WRITE_LOCK.lock().await;
            // 루트 안을 가리키는 심링크는 링크 자신을 지운다 (is_dir() 은 링크를 따라가므로
            // symlink_metadata). 루트 밖을 가리키는 링크는 safe_join 이 거른다 — fail-closed.
            let meta = std::fs::symlink_metadata(&path).map_err(err)?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&path).map_err(err)?;
            } else {
                std::fs::remove_file(&path).map_err(err)?;
            }
            Ok(Value::Null)
        }
        "listFiles" => {
            // 부팅이 이 호출을 await 하므로 실패 시 앱이 안 뜬다 — exit 1(0건)은 성공이다
            let mut args = vec!["--files"];
            args.extend(RG_EXCLUDE_ARGS);
            let out = run_rg(root, &args).await?;
            Ok(json!(out.lines().map(crate::wire_rel).collect::<Vec<_>>()))
        }
        "search" => search(root, p).await,
        // git repo 가 아니어도 앱은 떠야 한다 — 빈 상태로 강등
        "gitStatus" => Ok(git_status(root)
            .await
            .unwrap_or_else(|_| json!({"branch": "", "head": "", "dirty": false, "changes": []}))),
        "gitOriginalContent" => {
            let path = req_path(p)?;
            safe_join(root, path)?; // 검증만 — git 에는 상대 경로를 그대로 넘긴다
            // untracked/신규 파일이면 git show 가 실패한다 → 빈 문자열 (계약)
            match run(root, "git", &["show", &format!("HEAD:{path}")]).await {
                Ok(s) => Ok(json!(s)),
                Err(_) => Ok(json!("")),
            }
        }
        "gitCommit" => {
            run(root, "git", &["add", "-A"]).await?;
            run(root, "git", &["commit", "-m", p["message"].as_str().unwrap_or("")]).await?;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown method: {method}")),
    }
}

async fn search(root: &Path, p: &Value) -> Result<Value, String> {
    let query = p["query"].as_str().unwrap_or("");
    if query.is_empty() {
        return Ok(json!([]));
    }
    let mut args = vec!["--json", "--fixed-strings"];
    args.extend(RG_EXCLUDE_ARGS);
    if !p["opts"]["caseSensitive"].as_bool().unwrap_or(false) {
        args.push("--ignore-case");
    }
    args.extend(["--", query]);
    let out = run_rg(root, &args).await?;
    let mut files: Vec<(String, Vec<Value>)> = Vec::new();
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"] != "match" {
            continue;
        }
        let d = &v["data"];
        // 비UTF-8 라인/경로는 rg 가 text 대신 bytes(base64) 를 내보낸다 — 표시 불가, 건너뜀
        let (Some(path), Some(text)) = (d["path"]["text"].as_str(), d["lines"]["text"].as_str())
        else {
            continue;
        };
        let path = crate::wire_rel(path);
        let text = text.trim_end_matches(['\n', '\r']);
        // WHY: rg 오프셋은 바이트, 프론트(SearchView)의 slice 는 UTF-16 코드유닛 —
        //      한글 주석 라인에서 하이라이트가 어긋나므로 여기서 변환한다
        let col =
            |b: &Value| text.get(..b.as_u64().unwrap_or(0) as usize).map_or(0, |s| s.encode_utf16().count());
        let m = json!({
            "line": d["line_number"].as_u64().unwrap_or(1).saturating_sub(1),
            "lineText": text,
            "ranges": d["submatches"].as_array().cloned().unwrap_or_default().iter()
                .map(|s| json!([col(&s["start"]), col(&s["end"])])).collect::<Vec<_>>(),
        });
        match files.last_mut() {
            Some((last, ms)) if *last == path => ms.push(m),
            _ => files.push((path, vec![m])),
        }
    }
    Ok(Value::Array(
        files.into_iter().map(|(path, ms)| json!({"path": path, "matches": ms})).collect(),
    ))
}

async fn git_status(root: &Path) -> Result<Value, String> {
    // WHY: core.quotePath 기본값이 비ASCII 경로를 C-quote("\355...") 로 내보낸다 — 끈다.
    // ponytail: 따옴표·제어문자 포함 경로는 여전히 quote 됨 — 완전 해결은 -z(NUL 구분) 파싱
    let out = run(root, "git", &["-c", "core.quotePath=false", "status", "--porcelain=v2", "--branch"]).await?;
    let mut branch = String::new();
    let mut head = String::new();
    let mut changes = Vec::new();
    for line in out.lines() {
        if let Some(b) = line.strip_prefix("# branch.head ") {
            branch = b.to_string();
            continue;
        }
        // HEAD 커밋 해시 — 프론트 diff original 캐시의 무효화 키. unborn 은 "(initial)" → 빈 문자열
        if let Some(o) = line.strip_prefix("# branch.oid ") {
            head = if o == "(initial)" { String::new() } else { o.to_string() };
            continue;
        }
        let (kind, path) = if let Some(rest) = line.strip_prefix("? ") {
            ("untracked", rest.to_string())
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy = &line[2..4];
            let kind = if xy.contains('A') {
                "added"
            } else if xy.contains('D') {
                "deleted"
            } else {
                "modified"
            };
            // porcelain v2: '1' 은 9번째 필드부터 경로, '2'(rename) 는 score 가 껴서 10번째.
            // rename 은 "새경로\t원경로" — 새 경로만 취한다.
            let n = if line.starts_with("1 ") { 9 } else { 10 };
            let path = line
                .splitn(n, ' ')
                .nth(n - 1)
                .unwrap_or("")
                .split('\t')
                .next()
                .unwrap_or("")
                .to_string();
            (kind, path)
        } else {
            continue;
        };
        changes.push(json!({"path": path, "kind": kind}));
    }
    Ok(json!({"branch": branch, "head": head, "dirty": !changes.is_empty(), "changes": changes}))
}

/// rg 전용 — exit code 계약이 0=매치, 1=무매치(정상), 2+=에러다
async fn run_rg(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new("rg")
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(err)?;
    match out.status.code() {
        Some(0 | 1) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

async fn run(root: &Path, bin: &str, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new(bin)
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(err)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if stderr.is_empty() {
            // git 은 "nothing to commit" 을 stdout 로 낸다 — 빈 에러 대신 그걸 보여준다.
            // (rg 매치 0건은 stdout 도 비어 있어 Err("") 유지 — search/listFiles 가 의존)
            Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(stderr)
        }
    }
}

fn req_path(p: &Value) -> Result<&str, String> {
    p["path"].as_str().ok_or_else(|| "path 필요".into())
}

/// 루트 이탈 방지 — 렉시컬 검사에 더해 심링크를 해소한 실제 경로가 루트 안인지 확인한다.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("경로 이탈: {rel}"));
    }
    let joined = root.join(rel);
    // WHY: 트리 안의 심링크가 루트 밖을 가리킬 수 있다 (root 는 main 에서 canonicalize 됨).
    //      신규 경로(writeFile·createFile 의 중첩 생성)는 아직 없는 구간을 지나므로,
    //      가장 가까운 실존 조상을 해소해 검사한다 — 실존 조상이 밖을 가리키면 이탈이다.
    let real = {
        let mut probe = joined.as_path();
        loop {
            match probe.canonicalize() {
                // plain: root 도 plain — verbatim 을 안 벗기면 starts_with 가 항상 어긋난다
                Ok(r) => break Ok(superlight_common::plain(r)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => match probe.parent() {
                    Some(parent) => probe = parent,
                    None => break Err(e),
                },
                Err(e) => break Err(e),
            }
        }
    };
    match real {
        Ok(r) if r.starts_with(root) => Ok(joined),
        Ok(_) => Err(format!("경로 이탈: {rel}")),
        Err(e) => Err(e.to_string()),
    }
}
