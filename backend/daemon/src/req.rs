//! RPC 요청 처리 — fs 읽기/쓰기(etag 낙관적 충돌 검사)·rg 검색·git 상태/스테이징/커밋/로그/브랜치.
//! 모든 경로는 safe_join 관문을 지난다.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};
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
//      읽기(readFile·stat)도 같은 락 — stat→read 의 etag 정합과 orphan 재검증의 응답 순서가
//      쓰기와의 직렬화에 기댄다. 그래서 '쓰기 락' 이 아니라 파일 시스템 락이다.
// ponytail: 전역 락 + 락 안 블로킹 fs 호출 — 병목이 실측되면 경로별 락 + spawn_blocking.
//           읽은 뒤의 인코딩(deflate·base64)은 락 밖에서 한다.
static FS_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// readFile 의 기본 크기 상한 — VS Code 의 텍스트 편집기 상한(50MB)과 동일. 초과는 에러가
/// 아니라 unopenable(large) 반환이다 — 프론트가 탭을 열고 실측 크기와 함께 안내를 띄운다.
const READ_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// 트리(readDir)에서 숨기는 basename — VS Code files.exclude 기본값.
/// node_modules 는 VS Code 기본과 동일하게 트리에 보인다.
/// ponytail: 설정 시스템이 없어 하드코딩 — 사용자 설정이 생기면 여기로 합류.
const FILES_EXCLUDED: [&str; 5] = [".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"];

/// 검색(rg)·quickOpen 걷기(ignore 크레이트) 공통 제외 글롭 — files.exclude + search.exclude 기본값
/// (node_modules 등). rg 의 -g 와 ignore::overrides 는 같은 글롭 문법·같은 부정(!) 의미다.
const EXCLUDE_GLOBS: [&str; 8] = [
    "!**/.git",
    "!**/.svn",
    "!**/.hg",
    "!**/.DS_Store",
    "!**/Thumbs.db",
    "!**/node_modules",
    "!**/bower_components",
    "!**/*.code-search",
];

/// 검색의 rg 인자 — VS Code 와 동일하게 dotfile 을 포함(--hidden)하되 EXCLUDE_GLOBS 를 제외한다.
/// ignore 파일은 워크스페이스 안의 것만 존중한다 — VS Code 기본과 동일
/// (useIgnoreFiles=true, useParentIgnoreFiles/useGlobalIgnoreFiles=false).
/// --no-require-git 만 주면 부모·글로벌 gitignore 까지 새어 들어와 파일이 조용히 사라진다.
/// quickOpen 걷기의 WalkBuilder 설정(list_files)은 이 인자들의 라이브러리 대응이다.
fn rg_exclude_args() -> Vec<&'static str> {
    let mut args = vec![
        "--hidden",
        "--no-require-git",
        "--no-ignore-parent",
        "--no-ignore-global",
    ];
    for g in EXCLUDE_GLOBS {
        args.extend(["-g", g]);
    }
    args
}

/// readFile 응답 — 소형은 종전 JSON, 대형은 바이너리 payload 프레임 (와이어 v6).
/// meta 는 content 를 제외한 result 필드(etag 등)이고, main.rs 가 payload 명세와 합쳐
/// 헤더를 만든다. enc/typ 는 프론트의 복원 절차 지시: enc=deflate-raw 면 해제 후,
/// typ=text 면 UTF-8 디코드, typ=base64 면 base64 재인코딩(종전 계약 유지).
pub(crate) enum ReadOut {
    Json(Value),
    Payload {
        meta: Value,
        body: Vec<u8>,
        enc: &'static str,
        typ: &'static str,
    },
}

/// payload 프레임 최소 크기 — 미만은 JSON 경로 유지 (소형 응답까지 이원화하지 않는다).
/// 압축·프레이밍 이득이 고정 비용을 넘는 지점의 보수적 근사.
const PAYLOAD_MIN_BYTES: usize = 4096;

/// base64 요청분의 응답 — 대형은 부풀림(1.33x) 없이 원본 바이트를 payload 로, 소형은 base64 JSON
fn base64_out(bytes: Vec<u8>, meta: &std::fs::Metadata) -> ReadOut {
    if bytes.len() >= PAYLOAD_MIN_BYTES {
        return ReadOut::Payload {
            meta: json!({"etag": file_etag(meta)}),
            body: bytes,
            enc: "raw",
            typ: "base64",
        };
    }
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    ReadOut::Json(json!({"content": b64, "etag": file_etag(meta)}))
}

pub(crate) async fn read_file(p: &Value, root: &Path) -> Result<ReadOut, String> {
    let path = file_path(root, req_path(p)?)?;
    let _g = FS_LOCK.lock().await;
    // WHY: stat 이 read 뒤면 etag 가 내용보다 새것일 수 있다 — 그 etag 로 저장하면
    //      최신 내용을 조용히 덮는다. stat 먼저면 최악이 스퓨리어스 충돌(내용 비교
    //      탈출구가 거른다). 데몬 자신의 쓰기와는 락으로 안 겹친다.
    let meta = std::fs::metadata(&path).map_err(err)?;
    // 크기 초과·이진(비 UTF-8)은 에러가 아니라 구조화된 사유다 — 실존하는 파일이므로
    // 탭은 열려야 하고, 사유·크기는 안내 화면 문구가 된다. 상한 검사는 읽기 전 —
    // 대용량을 읽어 나른 뒤 버리는 낭비 방지 (maxBytes 는 undo 캡처 등 호출측 상한)
    let max = p["maxBytes"].as_u64().unwrap_or(READ_MAX_BYTES);
    // 범위 읽기(와이어 v11) — hex 뷰어 청크. 크기 상한을 타지 않고 offset 부터 max 바이트만
    // 나른다 (EOF 넘어가면 짧게·빈 채로). base64 전용 — 텍스트 경로는 UTF-8 경계가 깨진다
    if let Some(offset) = p["offset"].as_u64() {
        if p["encoding"].as_str() != Some("base64") {
            return Err("offset 은 encoding=base64 전용".into());
        }
        use std::io::{Read as _, Seek as _};
        let mut f = std::fs::File::open(&path).map_err(err)?;
        f.seek(std::io::SeekFrom::Start(offset)).map_err(err)?;
        let mut bytes = Vec::new();
        f.take(max).read_to_end(&mut bytes).map_err(err)?;
        return Ok(base64_out(bytes, &meta));
    }
    if meta.len() > max {
        return Ok(ReadOut::Json(json!({
            "unopenable": {"kind": "large", "size": meta.len()},
            "etag": file_etag(&meta),
        })));
    }
    // encoding=base64 는 이진 읽기 (이미지 뷰어 등) — 대형은 base64 부풀림(1.33x) 없이
    // 원본 바이트를 payload 로 나른다 (프론트가 base64 로 복원해 종전 계약 유지)
    let b64 = match p["encoding"].as_str() {
        Some("base64") => true,
        Some(other) => return Err(format!("지원하지 않는 encoding: {other}")),
        None => false,
    };
    let bytes = std::fs::read(&path).map_err(err)?;
    drop(_g); // 파일은 다 읽었다 — 인코딩(수 MB 면 수십 ms)은 다른 요청을 막지 않고
    if b64 {
        return Ok(base64_out(bytes, &meta));
    }
    match String::from_utf8(bytes) {
        Ok(content) => {
            if content.len() >= PAYLOAD_MIN_BYTES {
                // deflate-raw: 브라우저 DecompressionStream('deflate-raw') 대응 (zlib 헤더 없음)
                use std::io::Write as _;
                let mut enc =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                enc.write_all(content.as_bytes()).map_err(err)?;
                let body = enc.finish().map_err(err)?;
                return Ok(ReadOut::Payload {
                    meta: json!({"etag": file_etag(&meta)}),
                    body,
                    enc: "deflate-raw",
                    typ: "text",
                });
            }
            Ok(ReadOut::Json(
                json!({"content": content, "etag": file_etag(&meta)}),
            ))
        }
        Err(_) => Ok(ReadOut::Json(json!({
            "unopenable": {"kind": "binary"},
            "etag": file_etag(&meta),
        }))),
    }
}

pub(crate) async fn handle_req(method: &str, p: &Value, root: &Path) -> Result<Value, String> {
    match method {
        "workspace" => Ok(json!({
            "name": root.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
            "rootPath": root.to_string_lossy(),
        })),
        "readDir" => {
            let rel = p["path"].as_str().unwrap_or("");
            // 절대 경로(와이어 v15) — 폴더 탭이 워크스페이스 밖을 탐색한다. 허용 근거는 browseDir 과
            // 같다 (인증 경계는 relay). 항목 path 도 절대('/' 구분)이고 repo 표식은 달지 않는다 —
            // git RPC 는 루트 상대라 밖의 저장소를 다룰 수 없다
            let abs = Path::new(rel).is_absolute();
            let dir = if abs { file_path(root, rel)? } else { safe_join(root, rel)? };
            let rel = rel.trim_end_matches(['/', '\\']);
            let mut out = Vec::new();
            for ent in std::fs::read_dir(&dir).map_err(err)? {
                let ent = ent.map_err(err)?;
                let name = ent.file_name().to_string_lossy().into_owned();
                if FILES_EXCLUDED.contains(&name.as_str()) {
                    continue;
                }
                let path = if rel.is_empty() && !abs {
                    name.clone()
                } else {
                    format!("{rel}/{name}")
                };
                // WHY: file_type() 은 심링크를 안 따라간다 — node_modules 의 심링크 디렉터리가
                //      file 로 보인다. metadata() 는 따라간다 (깨진 링크는 file 취급).
                let meta = std::fs::metadata(ent.path()).ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let kind = if is_dir { "directory" } else { "file" };
                let mut item = json!({"name": name, "path": path, "kind": kind});
                // mtime(ms)·size(파일만) — 폴더 탭 자세히 보기 열 (와이어 v15). metadata 는 이미 읽었다
                if let Some(m) = &meta {
                    if let Ok(t) = m.modified() {
                        if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                            item["mtime"] = json!(d.as_millis() as u64);
                        }
                    }
                    if !is_dir {
                        item["size"] = json!(m.len());
                    }
                }
                // repo(와이어 v13): 자식 .git 이 있는 디렉토리 — 트리 펼침이 곧 하위 저장소 인식이다
                // (.git 자체는 FILES_EXCLUDED 로 숨겨져 프론트가 직접 볼 수 없다). 루트 첫 나열이
                // 직계 자식 저장소를, 이후 펼침이 더 깊은 저장소를 알린다. 최초 탐색은 gitRepos
                if is_dir && !abs && is_repo(&ent.path()) {
                    item["repo"] = json!(true);
                }
                out.push(item);
            }
            Ok(Value::Array(out))
        }
        // readFile 은 main.rs 가 read_file 로 직접 라우팅한다 — 대형 응답이 JSON 이 아니라
        // 바이너리 payload 프레임을 타야 해서 반환형(ReadOut)이 다르다
        "stat" => {
            let path = file_path(root, req_path(p)?)?;
            // WHY: readFile 과 같은 락 — orphan 재검증의 응답 순서가 쓰기와의 직렬화에 기댄다
            let _g = FS_LOCK.lock().await;
            let meta = std::fs::metadata(&path).map_err(err)?;
            // 정규 파일 전용 — 같은 경로의 디렉토리에 성공하면 재검증이 "파일 실존" 으로 오판한다
            if !meta.is_file() {
                return Err("정규 파일이 아니다".into());
            }
            // size(와이어 v11) — hex 뷰어가 범위 읽기 전에 전체 길이를 안다
            Ok(json!({"etag": file_etag(&meta), "size": meta.len()}))
        }
        "writeFile" => {
            // WHY: content 누락을 "" 로 해석하면 깨진 요청이 파일을 비운다 — 명시적 에러
            let content = p["content"].as_str().ok_or("content 필요")?;
            // encoding=base64 는 이진 쓰기 (클립보드 이미지 저장 등) — 부재 시 UTF-8 텍스트 그대로
            let bytes: std::borrow::Cow<[u8]> = match p["encoding"].as_str() {
                Some("base64") => {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(content)
                        .map_err(err)?
                        .into()
                }
                Some(other) => return Err(format!("지원하지 않는 encoding: {other}")),
                None => content.as_bytes().into(),
            };
            let path = file_path(root, req_path(p)?)?;
            let _g = FS_LOCK.lock().await;
            // append(와이어 v14) — 청크 업로드의 후속 조각. 첫 조각은 append 없이 써 파일을
            // 새로 만들고(truncate), 이후 조각은 etag 검사 없이 끝에 덧붙인다
            if p["append"].as_bool() == Some(true) {
                use std::io::Write as _;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(&path)
                    .map_err(err)?;
                f.write_all(&bytes).map_err(err)?;
                return Ok(json!({"etag": file_etag(&std::fs::metadata(&path).map_err(err)?)}));
            }
            // 낙관적 충돌 검사 (VS Code FILE_MODIFIED_SINCE 상당). etag 없으면 무조건 쓴다
            // (덮어쓰기·신규 파일). 파일이 사라진 경우는 쓰기로 진행 — 저장이 파일을 되살린다.
            if let Some(expected) = p["etag"].as_str() {
                match std::fs::metadata(&path) {
                    // etag 불일치라도 디스크가 이미 쓰려는 내용이면 충돌이 아니다 (탈출구).
                    // read 실패(EISDIR 등)는 충돌로 위장하지 않고 에러로 낸다.
                    Ok(meta) => {
                        if file_etag(&meta) != expected
                            && std::fs::read(&path).map_err(err)? != *bytes
                        {
                            return Ok(json!({"conflict": true}));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(err(e)), // 권한 등 — "없음" 으로 오독하면 검사가 무단 통과
                }
            }
            std::fs::write(&path, &bytes).map_err(err)?;
            Ok(json!({"etag": file_etag(&std::fs::metadata(&path).map_err(err)?)}))
        }
        "createFile" => {
            let path = safe_join(root, req_path(p)?)?;
            let _g = FS_LOCK.lock().await;
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
            let _g = FS_LOCK.lock().await;
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
            let _g = FS_LOCK.lock().await;
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
            let _g = FS_LOCK.lock().await;
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
        // '폴더 열기' 경로 탐색용 — 루트와 무관한 임의 절대 경로의 하위 디렉토리 이름 나열.
        // 절대 경로 허용 근거는 file_path 와 같다 — 인증 경계는 relay 고, 인증 통과자는
        // 이미 createTerminal 로 셸을 가지므로 나열이 권한을 넓히지 않는다.
        "browseDir" => {
            let wire = req_path(p)?;
            let path = Path::new(wire);
            if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(format!("절대 경로 필요: {wire}"));
            }
            let mut out: Vec<String> = Vec::new();
            for ent in std::fs::read_dir(path).map_err(err)? {
                let ent = ent.map_err(err)?;
                // metadata: 심링크 디렉토리도 후보다 (readDir 와 같은 이유)
                if std::fs::metadata(ent.path())
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
                {
                    out.push(ent.file_name().to_string_lossy().into_owned());
                }
            }
            out.sort();
            Ok(json!(out))
        }
        "search" => search(root, p).await,
        // 하위·중첩 저장소 탐색 (와이어 v13) — 루트 포함, 상대 경로 목록 (루트는 '')
        "gitRepos" => {
            let root = root.to_path_buf();
            let repos = tokio::task::spawn_blocking(move || scan_repos(&root))
                .await
                .map_err(err)?;
            Ok(json!(repos))
        }
        // git repo 가 아니어도 앱은 떠야 한다 — 빈 상태로 강등 (프론트는 branch·head 둘 다 빈
        // 응답을 '저장소 아님' 으로 읽어 목록에서 뺀다 — unborn 은 branch 가 있다)
        "gitStatus" => Ok(git_status(&git_dir(root, p)?)
            .await
            .unwrap_or_else(|_| json!({"branch": "", "head": "", "dirty": false, "changes": []}))),
        "gitOriginalContent" => {
            let dir = git_dir(root, p)?;
            let path = req_path(p)?;
            safe_join(&dir, path)?; // 검증만 — git 에는 상대 경로를 그대로 넘긴다
                                    // untracked/신규 파일이면 git show 가 실패한다 → 빈 문자열 (계약)
            match run(&dir, "git", &["show", &format!("HEAD:{path}")]).await {
                Ok(s) => Ok(json!(s)),
                Err(_) => Ok(json!("")),
            }
        }
        // 인덱스(스테이징) 만 커밋 — 전체 커밋은 프론트가 gitStage(전부) 를 먼저 보낸다
        "gitCommit" => {
            run(
                &git_dir(root, p)?,
                "git",
                &["commit", "-m", p["message"].as_str().unwrap_or("")],
            )
            .await?;
            Ok(Value::Null)
        }
        "gitStage" => git_paths_cmd(&git_dir(root, p)?, p, &["add", "-A", "--"]).await,
        "gitUnstage" => {
            let dir = git_dir(root, p)?;
            // unborn HEAD 에서는 reset 이 실패한다 — 인덱스에서만 빼는 rm --cached 로 강등
            match git_paths_cmd(&dir, p, &["reset", "-q", "HEAD", "--"]).await {
                Ok(v) => Ok(v),
                Err(_) => git_paths_cmd(&dir, p, &["rm", "--cached", "-r", "-q", "--"]).await,
            }
        }
        // 워킹트리 변경 되돌리기 — 추적 파일은 인덱스 내용으로 복원, untracked 는 삭제.
        // 파괴적 조작 — 확인 대화상자는 프론트 책임
        "gitDiscard" => {
            let dir = git_dir(root, p)?;
            let tr = req_paths(&dir, p, "paths")?;
            let ut = req_paths(&dir, p, "untracked")?;
            if !tr.is_empty() {
                let mut args = vec!["checkout", "-q", "--"];
                args.extend(tr);
                run(&dir, "git", &args).await?;
            }
            if !ut.is_empty() {
                let mut args = vec!["clean", "-f", "-q", "--"];
                args.extend(ut);
                run(&dir, "git", &args).await?;
            }
            Ok(Value::Null)
        }
        "gitLog" => {
            let n = p["limit"].as_u64().unwrap_or(50).to_string();
            // %x1f 구분 — subject(%s) 는 한 줄이라 행 단위 파싱이 안전하다
            let out = run(
                &git_dir(root, p)?,
                "git",
                &["log", "--format=%H%x1f%s%x1f%an%x1f%ar", "-n", &n],
            )
            .await;
            // unborn/비 git 은 빈 목록
            let out = out.unwrap_or_default();
            let items: Vec<Value> = out
                .lines()
                .filter_map(|l| {
                    let mut f = l.split('\x1f');
                    Some(json!({
                        "hash": f.next()?, "subject": f.next()?,
                        "author": f.next()?, "date": f.next()?,
                    }))
                })
                .collect();
            Ok(json!(items))
        }
        "gitBranches" => {
            let out = run(
                &git_dir(root, p)?,
                "git",
                &["for-each-ref", "refs/heads", "--format=%(refname:short)"],
            )
            .await?;
            Ok(json!(out.lines().collect::<Vec<_>>()))
        }
        "gitCheckout" => {
            let name = p["branch"].as_str().ok_or("branch 필요")?;
            run(&git_dir(root, p)?, "git", &["checkout", "-q", name]).await?;
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
    args.extend(rg_exclude_args());
    if !p["opts"]["caseSensitive"].as_bool().unwrap_or(false) {
        args.push("--ignore-case");
    }
    args.extend(["--", query]);
    let out = run_rg(root, &args).await?;
    let mut files: Vec<(String, Vec<Value>)> = Vec::new();
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
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
        let col = |b: &Value| {
            text.get(..b.as_u64().unwrap_or(0) as usize)
                .map_or(0, |s| s.encode_utf16().count())
        };
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
        files
            .into_iter()
            .map(|(path, ms)| json!({"path": path, "matches": ms}))
            .collect(),
    ))
}

/// git 계열 RPC 의 작업 디렉토리 — repo 파라미터(와이어 v13, 루트 상대 디렉토리, 없거나 '' 면
/// 루트). 경로 파라미터(paths 등)는 이 디렉토리 기준 상대 경로다 — safe_join 이 루트 안임을 보장
fn git_dir(root: &Path, p: &Value) -> Result<PathBuf, String> {
    match p["repo"].as_str() {
        None | Some("") => Ok(root.to_path_buf()),
        Some(rel) => safe_join(root, rel),
    }
}

/// .git 이 있으면 저장소 — 디렉토리(일반)든 파일(worktree·서브모듈의 gitdir 포인터)이든
fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// 저장소 자동 탐색 깊이 (루트=0, 자식=1). VS Code git.repositoryScanMaxDepth 기본(1)보다 한
/// 단계 넓다 — 모음 폴더 아래 한 겹의 그룹 폴더까지. 더 깊은 저장소는 트리 펼침(readDir repo
/// 표식)으로 닿는다
const REPO_SCAN_DEPTH: usize = 2;
/// 자동 탐색이 돌려주는 저장소 수 상한 — 초과분은 버리고 로그 한 줄 (트리 펼침으로는 여전히 등록된다)
const REPO_SCAN_MAX: usize = 20;

/// 하위·중첩 저장소 탐색 — 루트 포함, 깊이 REPO_SCAN_DEPTH 까지 .git 을 가진 디렉토리의 루트
/// 상대 경로(루트는 ''). dot 디렉토리·node_modules·bower_components 는 내려가지 않고, 저장소
/// 안쪽도 계속 내려간다 (중첩 저장소). 심링크 디렉토리는 따라가지 않는다. 블로킹 풀에서 돈다
fn scan_repos(root: &Path) -> Vec<String> {
    const SKIP: [&str; 2] = ["node_modules", "bower_components"];
    let mut out = Vec::new();
    if is_repo(root) {
        out.push(String::new());
    }
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    while let Some((dir, rel, depth)) = stack.pop() {
        if depth >= REPO_SCAN_DEPTH {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                continue;
            }
            // symlink_metadata: 심링크 디렉토리는 밖을 가리킬 수 있다 — 탐색 대상 아님
            if !ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = ent.path();
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if is_repo(&path) {
                if out.len() >= REPO_SCAN_MAX {
                    eprintln!(
                        "gitRepos: 저장소 {REPO_SCAN_MAX}개 초과 — 나머지는 트리 펼침으로만 등록"
                    );
                    out.sort();
                    return out;
                }
                out.push(child_rel.clone());
            }
            stack.push((path, child_rel, depth + 1));
        }
    }
    out.sort();
    out
}

async fn git_status(root: &Path) -> Result<Value, String> {
    // WHY: -z(NUL 구분)라야 경로가 quote 없이 원문 그대로 나온다 — 비ASCII·따옴표·제어문자 모두.
    // -uall: 신규 디렉토리를 'dir/' 한 줄이 아니라 파일 단위로 — 파일별 stage/discard 의 단위
    let out = run(
        root,
        "git",
        &["status", "--porcelain=v2", "--branch", "-uall", "-z"],
    )
    .await?;
    let mut branch = String::new();
    let mut head = String::new();
    let mut changes = Vec::new();
    let mut entries = out.split('\0');
    while let Some(entry) = entries.next() {
        if let Some(b) = entry.strip_prefix("# branch.head ") {
            branch = b.to_string();
            continue;
        }
        // HEAD 커밋 해시 — 프론트 diff original 캐시의 무효화 키. unborn 은 "(initial)" → 빈 문자열
        if let Some(o) = entry.strip_prefix("# branch.oid ") {
            head = if o == "(initial)" {
                String::new()
            } else {
                o.to_string()
            };
            continue;
        }
        if let Some(rest) = entry.strip_prefix("? ") {
            changes.push(json!({"path": rest, "kind": "untracked", "staged": false}));
        } else if entry.starts_with("1 ") || entry.starts_with("2 ") {
            // XY: X 는 인덱스(staged) 쪽, Y 는 워킹트리(unstaged) 쪽 — 둘 다 있으면 두 항목
            let xy = entry[2..4].as_bytes();
            // porcelain v2: '1' 은 9번째 필드부터 경로, '2'(rename) 는 score 가 껴서 10번째.
            // -z 의 rename 은 원경로가 다음 NUL 토큰으로 이어진다 — 새 경로만 취하고 소비한다.
            let n = if entry.starts_with("1 ") { 9 } else { 10 };
            let path = entry.splitn(n, ' ').nth(n - 1).unwrap_or("").to_string();
            if entry.starts_with("2 ") {
                entries.next();
            }
            for (i, staged) in [(0usize, true), (1, false)] {
                let kind = match xy[i] {
                    b'.' => continue,
                    // rename/copy 는 인덱스에만 생긴다 — 새 경로가 added 로 보이는 것이 자연스럽다
                    b'A' | b'R' | b'C' => "added",
                    b'D' => "deleted",
                    _ => "modified",
                };
                changes.push(json!({"path": path, "kind": kind, "staged": staged}));
            }
        }
    }
    Ok(json!({"branch": branch, "head": head, "dirty": !changes.is_empty(), "changes": changes}))
}

/// quickOpen 걷기의 파일 수 상한 — 규칙을 다 적용해도 이 위로는 (gitignore 없는 홈 디렉터리 등)
/// 빠른 열기 목록의 가치보다 걷는 비용이 크다. VS Code 의 maxResults 자리. 부분 목록이 되면
/// 빠른 열기만 손해다 (탐색기는 readDir, 검색은 rg)
const WALK_MAX: usize = 50_000;

/// quickOpen 응답 상한 — VS Code anythingQuickAccess MAX_RESULTS. 와이어로 나가는 것은 항상 이 이하
const QUICK_MAX: usize = 512;

/// 세션의 빠른 열기 파일 목록 캐시 (와이어 v12). None = 아직 안 걸었다 — 첫 quickOpen 이 걷는다.
/// 걷는 동안 락을 쥐므로 뒤따르는 키 입력 요청은 같은 결과를 기다린다 (VS Code 의 cache
/// promise 대응). 무효화(fresh)는 프론트가 판단한다 — 데몬은 이벤트를 세지 않는다
pub(crate) type QuickCache = tokio::sync::Mutex<Option<Arc<Vec<String>>>>;

/// quickOpen RPC (와이어 v12) — 캐시(없거나 fresh 면 다시 걷는다)에서 pattern 을 거른다.
/// 파일명 subsequence 매치가 앞(하이라이트 = 파일명 안 인덱스), 전체 경로 매치가 뒤(하이라이트
/// 없음) — 종전 프론트 QuickInput 의 규칙 그대로. QUICK_MAX 에서 자르고 limitHit
pub(crate) async fn quick_open(
    p: &Value,
    root: &Path,
    cache: &QuickCache,
) -> Result<Value, String> {
    let pattern: Vec<char> = p["pattern"]
        .as_str()
        .unwrap_or("")
        .chars()
        .flat_map(char::to_lowercase)
        .collect();
    let fresh = p["fresh"].as_bool().unwrap_or(false);
    let files = {
        let mut slot = cache.lock().await;
        if fresh || slot.is_none() {
            let root = root.to_path_buf();
            let files = tokio::task::spawn_blocking(move || list_files(&root))
                .await
                .map_err(err)??;
            *slot = Some(Arc::new(files));
        }
        Arc::clone(slot.as_ref().unwrap())
    };
    let mut name_hits = Vec::new();
    let mut path_hits = Vec::new();
    for path in files.iter() {
        if name_hits.len() > QUICK_MAX {
            break;
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        if let Some(hl) = subsequence(name, &pattern) {
            name_hits.push(json!({"path": path, "highlights": hl}));
        } else if path_hits.len() <= QUICK_MAX && subsequence(path, &pattern).is_some() {
            path_hits.push(json!({"path": path, "highlights": []}));
        }
    }
    name_hits.append(&mut path_hits);
    let limit_hit = name_hits.len() > QUICK_MAX;
    name_hits.truncate(QUICK_MAX);
    Ok(json!({"items": name_hits, "limitHit": limit_hit}))
}

/// 대소문자 무시 subsequence 매칭 — 매치 문자들의 UTF-16 인덱스(프론트 하이라이트 좌표계).
/// 빈 패턴은 빈 매치(전부 통과)
fn subsequence(target: &str, pattern: &[char]) -> Option<Vec<usize>> {
    let mut out = Vec::with_capacity(pattern.len());
    let mut pi = 0;
    let mut u16 = 0;
    for c in target.chars() {
        if pi < pattern.len() && c.to_lowercase().eq(std::iter::once(pattern[pi])) {
            out.push(u16);
            pi += 1;
        }
        u16 += c.len_utf16();
    }
    (pi == pattern.len()).then_some(out)
}

/// 빠른 열기용 전체 파일 목록 — ignore 크레이트의 병렬 walk (rg --files 와 같은 엔진).
/// 설정은 rg_exclude_args 의 라이브러리 대응: hidden 포함, 워크스페이스 안 ignore 파일만
/// (parents/git_global 끔), git repo 아니어도 gitignore 존중(require_git 끔), EXCLUDE_GLOBS 를
/// override 로. 심링크는 따라가지 않는다. WALK_MAX 에서 Quit 한다 (부분 목록, 로그 한 줄).
/// 종전 (2026-09-05 이전): rg 서브프로세스 + rg 부재 시 gitignore 모르는 자체 walk 강등 —
/// 원격 홈 디렉터리에서 5초+ 걸리고 런타임 워커를 붙잡아 readDir 까지 굶겼다
fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let mut ov = ignore::overrides::OverrideBuilder::new(root);
    for g in EXCLUDE_GLOBS {
        ov.add(g).map_err(err)?;
    }
    let mut wb = ignore::WalkBuilder::new(root);
    wb.hidden(false)
        .parents(false)
        .git_global(false)
        .require_git(false)
        .overrides(ov.build().map_err(err)?);
    let out = std::sync::Mutex::new(Vec::new());
    wb.build_parallel().run(|| {
        Box::new(|ent| {
            let Ok(ent) = ent else {
                return ignore::WalkState::Continue;
            };
            if ent.file_type().is_some_and(|t| t.is_dir()) {
                return ignore::WalkState::Continue;
            }
            let Ok(rel) = ent.path().strip_prefix(root) else {
                return ignore::WalkState::Continue;
            };
            let rel: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            let mut out = out.lock().unwrap();
            if out.len() >= WALK_MAX {
                return ignore::WalkState::Quit;
            }
            out.push(rel.join("/"));
            ignore::WalkState::Continue
        })
    });
    let mut files = out.into_inner().unwrap();
    if files.len() >= WALK_MAX {
        eprintln!("superlite-daemon: quickOpen 걷기 상한 {WALK_MAX} — 부분 목록");
    }
    // 병렬 walk 는 순서가 비결정적 — 후보 순서가 키 입력마다 흔들리지 않게 한 번 정렬
    files.sort();
    Ok(files)
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
            // (rg 매치 0건은 stdout 도 비어 있어 Err("") 유지 — search 가 의존)
            Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(stderr)
        }
    }
}

fn req_path(p: &Value) -> Result<&str, String> {
    p["path"].as_str().ok_or_else(|| "path 필요".into())
}

/// 경로 배열 파라미터 — 각 경로를 safe_join 으로 검증만 하고 git 에는 상대 경로를 그대로 넘긴다
fn req_paths<'a>(root: &Path, p: &'a Value, key: &str) -> Result<Vec<&'a str>, String> {
    let arr = p[key].as_array().ok_or_else(|| format!("{key} 필요"))?;
    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        let path = v.as_str().ok_or_else(|| format!("{key}: 문자열 필요"))?;
        safe_join(root, path)?;
        out.push(path);
    }
    Ok(out)
}

/// `git <prefix...> -- <paths...>` — paths 파라미터 검증 후 실행. 빈 배열이면 no-op
async fn git_paths_cmd(root: &Path, p: &Value, prefix: &[&str]) -> Result<Value, String> {
    let paths = req_paths(root, p, "paths")?;
    if paths.is_empty() {
        return Ok(Value::Null);
    }
    let mut args = prefix.to_vec();
    args.extend(paths);
    run(root, "git", &args).await?;
    Ok(Value::Null)
}

/// 루트 이탈 방지 — 렉시컬 검사에 더해 심링크를 해소한 실제 경로가 루트 안인지 확인한다.
/// 파일 단건 호출(readFile/stat/writeFile)의 경로 해석 — 루트 상대가 기본이지만 절대
/// 경로도 허용한다 (워크스페이스 밖 파일 열기: OS 드롭 등, VS Code 파리티). 트리·감시·
/// 조작(rename/delete 등) 계열은 여전히 safe_join(루트 상대) 전용이다.
fn file_path(root: &Path, wire: &str) -> Result<PathBuf, String> {
    let p = Path::new(wire);
    if p.is_absolute() {
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("경로 이탈: {wire}"));
        }
        return Ok(p.to_path_buf());
    }
    safe_join(root, wire)
}

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
                Ok(r) => break Ok(superlite_common::plain(r)),
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
