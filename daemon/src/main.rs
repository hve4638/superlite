//! superlight-daemon — 로컬 워크스페이스를 ThinBackend 계약으로 서빙하는 WS 서버 (v0).
//!
//! 프로토콜(임시): {"id","method","params"} 요청 → {"id","result"|"error"} 응답,
//! 터미널 출력은 {"event":"termData","term","data"} 푸시. 와이어 계약 확정은 보류 중
//! (_docs/decisions.md) — 확정되면 이 파일과 mock-front/src/backend/ws.ts 만 바뀐다.
//!
//! ponytail: 재연결·flow control·다중 클라이언트 세션 공유 없음 — 계약 확정 때 함께.

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

struct Term {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

type Terms = Arc<Mutex<HashMap<u64, Term>>>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tokio::main]
async fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    let root = root.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다");
    let addr = std::env::var("SUPERLIGHT_ADDR").unwrap_or_else(|_| "0.0.0.0:8794".into());
    let listener = TcpListener::bind(&addr).await.expect("bind 실패 (SUPERLIGHT_ADDR 로 변경)");
    eprintln!("superlight-daemon: {} @ {addr}", root.display());
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        tokio::spawn(handle_conn(stream, root.clone()));
    }
}

async fn handle_conn(stream: TcpStream, root: PathBuf) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut sink, mut src) = ws.split();
    // WHY: 응답·터미널 이벤트가 여러 태스크/스레드에서 나오므로 단일 writer 태스크로 직렬화
    let (tx, mut rx) = unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if sink.send(Message::Text(s)).await.is_err() {
                break;
            }
        }
    });

    let terms: Terms = Arc::new(Mutex::new(HashMap::new()));
    while let Some(Ok(msg)) = src.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(req) = serde_json::from_str::<Value>(&text) else { continue };
        let method = req["method"].as_str().unwrap_or("").to_string();
        match method.as_str() {
            // 터미널 계열은 입력 순서 보장이 필요해 read 루프에서 즉시 처리 (전부 논블로킹)
            "createTerminal" | "termWrite" | "termResize" | "disposeTerminal" => {
                handle_term(&method, &req["params"], &terms, &tx, &root);
            }
            _ => {
                let (id, params) = (req["id"].clone(), req["params"].clone());
                let (tx, root) = (tx.clone(), root.clone());
                tokio::spawn(async move {
                    let out = match handle_req(&method, &params, &root).await {
                        Ok(v) => json!({"id": id, "result": v}),
                        Err(e) => json!({"id": id, "error": e}),
                    };
                    let _ = tx.send(out.to_string());
                });
            }
        }
    }
    // 연결 종료 → 이 연결의 터미널 정리 (세션 지속성은 계약 확정 후)
    for (_, t) in terms.lock().unwrap().drain() {
        kill_term(t);
    }
}

// WHY: portable-pty 의 kill 은 SIGHUP 후 최대 200ms 를 재우며 대기한다 — read 루프/워커를
//      막지 않게 스레드로 보내고, wait 까지 해서 좀비를 남기지 않는다.
fn kill_term(mut t: Term) {
    std::thread::spawn(move || {
        let _ = t.child.kill();
        let _ = t.child.wait();
    });
}

// ---------------------------------------------------------------- terminal

fn handle_term(method: &str, p: &Value, terms: &Terms, tx: &UnboundedSender<String>, root: &Path) {
    let id = p["term"].as_u64().unwrap_or(0);
    match method {
        "createTerminal" => {
            let cols = p["cols"].as_u64().unwrap_or(80) as u16;
            let rows = p["rows"].as_u64().unwrap_or(24) as u16;
            if let Err(e) = spawn_term(id, cols, rows, root, terms.clone(), tx.clone()) {
                let msg = json!({"event": "termData", "term": id, "data": format!("pty 생성 실패: {e}\r\n")});
                let _ = tx.send(msg.to_string());
                let _ = tx.send(json!({"event": "termExit", "term": id}).to_string());
            }
        }
        "termWrite" => {
            if let Some(t) = terms.lock().unwrap().get_mut(&id) {
                // ponytail: 자식이 stdin 을 안 읽으면 pty write 가 블로킹될 수 있다(대량 붙여넣기)
                //           — read 루프 정지를 감수. 문제되면 터미널별 쓰기 스레드로 분리.
                let _ = t.writer.write_all(p["data"].as_str().unwrap_or("").as_bytes());
            }
        }
        "termResize" => {
            if let Some(t) = terms.lock().unwrap().get(&id) {
                let _ = t.master.resize(PtySize {
                    rows: p["rows"].as_u64().unwrap_or(24) as u16,
                    cols: p["cols"].as_u64().unwrap_or(80) as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
        "disposeTerminal" => {
            if let Some(t) = terms.lock().unwrap().remove(&id) {
                kill_term(t);
            }
        }
        _ => unreachable!(),
    }
}

fn spawn_term(
    id: u64,
    cols: u16,
    rows: u16,
    root: &Path,
    terms: Terms,
    tx: UnboundedSender<String>,
) -> Result<(), String> {
    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(root);
    cmd.env("TERM", "xterm-256color");
    let child = pty.slave.spawn_command(cmd).map_err(err)?;
    let writer = pty.master.take_writer().map_err(err)?;
    let mut reader = pty.master.try_clone_reader().map_err(err)?;
    // WHY: 리더 스레드가 종료 시 맵에서 자기 항목을 지우므로, 스레드 시작 전에 등록해야
    //      즉사한 셸이 맵에 유령으로 남는 race 가 없다
    terms.lock().unwrap().insert(id, Term { writer, master: pty.master, child });
    // WHY: portable-pty 의 reader 는 블로킹 — 전용 스레드에서 읽어 writer 채널로 넘긴다
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new(); // 청크 경계에서 잘린 UTF-8 꼬리
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            let (text, rest) = split_valid_utf8(&carry);
            carry = rest;
            if !text.is_empty()
                && tx.send(json!({"event": "termData", "term": id, "data": text}).to_string()).is_err()
            {
                break;
            }
        }
        // 셸이 스스로 종료(exit)한 경우 — 맵에서 제거해 fd/좀비 누수를 막는다
        if let Some(mut t) = terms.lock().unwrap().remove(&id) {
            let _ = t.child.kill();
            let _ = t.child.wait();
        }
        let _ = tx.send(json!({"event": "termExit", "term": id}).to_string());
    });
    Ok(())
}

/// 유효한 UTF-8 프리픽스와 잘린 꼬리를 분리. 진짜 깨진 바이트면 손실 변환으로 전부 내보낸다.
fn split_valid_utf8(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) if e.error_len().is_some() => (String::from_utf8_lossy(bytes).into_owned(), Vec::new()),
        Err(e) => {
            let valid = e.valid_up_to();
            (std::str::from_utf8(&bytes[..valid]).unwrap().to_string(), bytes[valid..].to_vec())
        }
    }
}

// ---------------------------------------------------------------- requests

async fn handle_req(method: &str, p: &Value, root: &Path) -> Result<Value, String> {
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
            Ok(json!(std::fs::read_to_string(safe_join(root, req_path(p)?)?).map_err(err)?))
        }
        "writeFile" => {
            // WHY: content 누락을 "" 로 해석하면 깨진 요청이 파일을 비운다 — 명시적 에러
            let content = p["content"].as_str().ok_or("content 필요")?;
            std::fs::write(safe_join(root, req_path(p)?)?, content).map_err(err)?;
            Ok(Value::Null)
        }
        "listFiles" => {
            // 부팅이 이 호출을 await 하므로 실패 시 앱이 안 뜬다 — exit 1(0건)은 성공이다
            let out = run_rg(root, &["--files"]).await?;
            Ok(json!(out.lines().collect::<Vec<_>>()))
        }
        "search" => search(root, p).await,
        // git repo 가 아니어도 앱은 떠야 한다 — 빈 상태로 강등
        "gitStatus" => Ok(git_status(root)
            .await
            .unwrap_or_else(|_| json!({"branch": "", "dirty": false, "changes": []}))),
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
        let path = path.to_string();
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
    let mut changes = Vec::new();
    for line in out.lines() {
        if let Some(b) = line.strip_prefix("# branch.head ") {
            branch = b.to_string();
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
    Ok(json!({"branch": branch, "dirty": !changes.is_empty(), "changes": changes}))
}

// ---------------------------------------------------------------- helpers

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
    //      신규 파일(writeFile)은 아직 없으므로 부모 디렉터리를 해소해 검사한다.
    let real = if joined.exists() {
        joined.canonicalize()
    } else {
        joined.parent().map_or(Ok(root.to_path_buf()), |d| d.canonicalize())
    };
    match real {
        Ok(r) if r.starts_with(root) => Ok(joined),
        Ok(_) => Err(format!("경로 이탈: {rel}")),
        Err(e) => Err(e.to_string()),
    }
}
