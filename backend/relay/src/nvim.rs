//! /nvim — 임베드 Neovim 중계 (ticket editor-vim-mode).
//!
//! 편집기 vim 모드의 실체는 진짜 Neovim 이다: 고정 버전의 nvim 을 `--embed --headless` 로
//! relay 옆(사용자 PC)에서 띄우고, 그 stdin/stdout(msgpack-RPC) 을 WebSocket 바이너리
//! 프레임으로 그대로 프론트에 잇는다. relay 는 RPC 를 해석하지 않는다 — /ws 가 데몬
//! 와이어를 불투명하게 중계하는 것과 같은 자세. 해석·버퍼 동기화는 프론트(model/nvim.ts·
//! ui/editor/vim.ts) 몫이다.
//!
//! nvim 이 원격 호스트가 아니라 여기서 도는 이유: normal 모드 키 하나가 RPC 왕복 하나라
//! ssh 너머에 두면 지연이 곧 타이핑 지연이다. 편집 버퍼는 Monaco 모델의 복제본이라 파일
//! 위치와 무관하다.
//!
//! 사용자 설정·플러그인은 읽지 않는다 (`--clean`): headless 임베드에서 TUI 전제 플러그인은
//! 창을 만들거나 디스크를 직접 쓰는 등 이상 동작한다. 같은 이유로 PATH 의 nvim 도 보지
//! 않는다 — 아래 nvim_bin 의 절대경로 규칙만.

use std::path::PathBuf;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{authed, close_with, App};

/// 동봉·다운로드하는 Neovim 버전 (stable 고정). 올릴 때는 아래 해시와 build.sh 의 값을 함께.
pub const NVIM_VERSION: &str = "0.12.5";
const LINUX_X86_64_URL: &str =
    "https://github.com/neovim/neovim/releases/download/v0.12.5/nvim-linux-x86_64.tar.gz";
const LINUX_X86_64_SHA256: &str = "bce0f56eda1f1b1db6eee8f4133d7a38813ea07933837dd1777411ca384c6875";

/// nvim 실행 파일 위치 규칙 — 데몬(daemon_bin_for)과 같은 자세, PATH 는 보지 않는다.
/// 1. SUPERLITE_NVIM_BIN (개발·check 하니스 우회)
/// 2. 실행 파일 옆 nvim/<os>-<arch>/bin/nvim[.exe] — 앱 설치본 동봉 (build.sh)
/// 3. $HOME/.cache/<SLUG>/nvim/<버전>/bin/nvim — 웹 모드(relay bin)가 내려받는 자리
fn nvim_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SUPERLITE_NVIM_BIN") {
        return Some(PathBuf::from(p));
    }
    let exe_name = if cfg!(windows) { "nvim.exe" } else { "nvim" };
    if let Ok(exe) = std::env::current_exe() {
        let p = exe
            .with_file_name("nvim")
            .join(format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH))
            .join("bin")
            .join(exe_name);
        if p.is_file() {
            return Some(p);
        }
    }
    let p = cache_bin()?;
    p.is_file().then_some(p)
}

fn cache_bin() -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "nvim.exe" } else { "nvim" };
    Some(superlite_common::cache_dir()?.join("nvim").join(NVIM_VERSION).join("bin").join(exe_name))
}

/// 다운로드 직렬화 — 창 둘이 동시에 vim 모드를 켜도 한 번만 받는다
static DOWNLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// nvim 을 확보한다 — 있으면 그 경로, 없으면 linux x86_64 에 한해 캐시 폴더에 내려받는다
/// (curl + sha256sum + tar 는 unix 기본 도구). 그 밖의 OS 는 동봉본이 없으면 실패 — 앱은
/// build.sh 가 동봉하므로 웹 모드의 linux 서버만 이 경로를 탄다.
async fn ensure_nvim() -> Result<PathBuf, String> {
    if let Some(p) = nvim_bin() {
        return Ok(p);
    }
    let _guard = DOWNLOAD.lock().await;
    if let Some(p) = nvim_bin() {
        return Ok(p); // 기다리는 동안 다른 연결이 받아 놓았다
    }
    if std::env::consts::OS != "linux" || std::env::consts::ARCH != "x86_64" {
        return Err(format!(
            "nvim {NVIM_VERSION} 없음 — 앱 옆 nvim/{}-{}/bin/ 에 동봉되어야 한다",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }
    let bin = cache_bin().ok_or("HOME 없음 — 캐시 폴더를 정할 수 없다")?;
    let dir = bin.parent().and_then(|p| p.parent()).ok_or("캐시 경로 오류")?.to_path_buf();
    let tmp = dir.with_extension("download");
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| format!("캐시 폴더 생성 실패: {e}"))?;
    let tgz = tmp.join("nvim.tar.gz");
    eprintln!("backend: nvim {NVIM_VERSION} 다운로드 → {}", dir.display());
    run("curl", &["-fsSL", "-o", &tgz.to_string_lossy(), LINUX_X86_64_URL]).await.map_err(|e| format!("nvim 다운로드 실패: {e}"))?;
    let sum = run("sha256sum", &[&tgz.to_string_lossy()]).await.map_err(|e| format!("sha256sum 실패: {e}"))?;
    let got = sum.split_whitespace().next().unwrap_or("");
    if got != LINUX_X86_64_SHA256 {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(format!("nvim 압축본 해시 불일치 ({got})"));
    }
    run("tar", &["xzf", &tgz.to_string_lossy(), "-C", &tmp.to_string_lossy(), "--strip-components=1"])
        .await
        .map_err(|e| format!("nvim 압축 해제 실패: {e}"))?;
    let _ = tokio::fs::remove_file(&tgz).await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::rename(&tmp, &dir).await.map_err(|e| format!("캐시 배치 실패: {e}"))?;
    nvim_bin().ok_or_else(|| "다운로드 후에도 nvim 이 없다".to_string())
}

async fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new(cmd).args(args).output().await.map_err(|e| format!("{cmd}: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{cmd} 종료 {}: {}", out.status, err.lines().last().unwrap_or("")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// GET /nvim (WebSocket) — 인증은 /ws 와 같다. 연결마다 nvim 프로세스 하나 (창 하나에 하나 —
/// 프론트가 페이지 수명 동안 하나만 연다). 확보 실패는 close 4503 + 사유 — 프론트는 vim
/// 모드를 끈 상태로 돌아가며 알림을 띄운다.
pub(crate) async fn nvim_handler(
    State(app): State<App>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !authed(&app, &query, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(pipe)
}

async fn pipe(ws: WebSocket) {
    use futures_util::{SinkExt, StreamExt};
    let (mut ws_tx, mut ws_rx) = ws.split();
    let bin = match ensure_nvim().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("backend: nvim 확보 실패: {e}");
            close_with(&mut ws_tx, &mut ws_rx, 4503, &e).await;
            return;
        }
    };
    // --clean: 사용자 init·플러그인·shada 를 전부 건너뛴다 (-u NONE -i NONE 과 달리 내장
    // 플러그인(matchit 등)은 산다). -n: swap 파일 없음 — 버퍼는 Monaco 의 복제본이다.
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["--embed", "--headless", "--clean", "-n"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — GUI 앱의 콘솔 자식 깜빡임 방지
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let reason = format!("nvim 실행 실패: {e}");
            eprintln!("backend: {reason} ({})", bin.display());
            close_with(&mut ws_tx, &mut ws_rx, 4503, &reason).await;
            return;
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();

    // nvim → 프론트: 읽히는 대로 바이너리 프레임. msgpack 메시지 경계는 프론트 디코더가
    // 스트림으로 다시 찾는다 (프레임이 메시지 중간에서 끊겨도 된다)
    let mut down = tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    // 프론트 → nvim
    let mut up = tokio::spawn(async move {
        while let Some(Ok(m)) = ws_rx.next().await {
            match m {
                Message::Binary(b) => {
                    if stdin.write_all(&b).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    // 한쪽이 끝나면 반대쪽도 — nvim 은 child drop(kill_on_drop)으로 죽는다
    tokio::select! {
        _ = &mut down => up.abort(),
        _ = &mut up => down.abort(),
    }
    let _ = child.kill().await;
}
