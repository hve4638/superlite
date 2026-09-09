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
//!
//! nvim 은 설치본에 동봉하지 않고 vim 모드를 처음 켤 때 GitHub 릴리스에서 캐시 폴더로 내려받는다
//! (ticket nvim-on-demand — 동봉하면 설치 시간의 대부분이 nvim 41 MB·2천 파일 압축 해제였다).
//! 확인 없이 자동으로 받고, 프론트에는 텍스트 프레임 하나로 알려 알림만 띄운다.

use std::path::PathBuf;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{authed, close_with, App};

/// 내려받는 Neovim 버전 (stable 고정). 올릴 때는 아래 ASSET 의 URL·해시·크기를 함께.
pub const NVIM_VERSION: &str = "0.12.5";
/// 이 플랫폼의 GitHub 릴리스 자산 — (URL, sha256, 내려받는 크기 MB — 알림 문구용). None 이면
/// 이 플랫폼엔 자동 다운로드가 없다 (SUPERLITE_NVIM_BIN 만). 미러·fallback 은 두지 않는다
/// (2026-09-09 사용자 결정 — 실패는 close 4503 사유로 보이고 다시 켜면 재시도).
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const ASSET: Option<(&str, &str, u32)> = Some((
    "https://github.com/neovim/neovim/releases/download/v0.12.5/nvim-linux-x86_64.tar.gz",
    "bce0f56eda1f1b1db6eee8f4133d7a38813ea07933837dd1777411ca384c6875",
    11,
));
#[cfg(all(windows, target_arch = "x86_64"))]
const ASSET: Option<(&str, &str, u32)> = Some((
    "https://github.com/neovim/neovim/releases/download/v0.12.5/nvim-win64.zip",
    "de8625ba8cf65ebf40eb80a388ba1ec8e9c15b30218821e2c639119b05920de1",
    13,
));
#[cfg(not(any(all(target_os = "linux", target_arch = "x86_64"), all(windows, target_arch = "x86_64"))))]
const ASSET: Option<(&str, &str, u32)> = None;

/// nvim 실행 파일 위치 규칙 — 데몬(daemon_bin_for)과 같은 자세, PATH 는 보지 않는다.
/// 1. SUPERLITE_NVIM_BIN (개발·check 하니스 우회)
/// 2. $HOME/.cache/<SLUG>/nvim/<버전>/bin/nvim[.exe] — ensure_nvim 이 내려받는 자리.
/// 설치본에는 동봉하지 않는다 (ticket nvim-on-demand — 설치 시간의 대부분이 nvim 압축 해제였다).
fn nvim_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SUPERLITE_NVIM_BIN") {
        return Some(PathBuf::from(p));
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

/// nvim 을 확보한다 — 있으면 그 경로, 없으면 GitHub 릴리스(ASSET)를 캐시 폴더에 내려받는다:
/// reqwest 로 받아 sha256 대조 → 임시 폴더에 풀고(linux 는 tar, Windows 는 zip crate — 둘 다
/// 최상위 폴더 하나를 벗긴다) rename. 완료 후 옛 버전 폴더는 지운다.
async fn ensure_nvim() -> Result<PathBuf, String> {
    if let Some(p) = nvim_bin() {
        return Ok(p);
    }
    let _guard = DOWNLOAD.lock().await;
    if let Some(p) = nvim_bin() {
        return Ok(p); // 기다리는 동안 다른 연결이 받아 놓았다
    }
    let (url, sha, _) = ASSET.ok_or_else(|| {
        format!("nvim {NVIM_VERSION} 없음 — {}-{} 는 자동 다운로드 대상이 아니다", std::env::consts::OS, std::env::consts::ARCH)
    })?;
    let bin = cache_bin().ok_or("HOME 없음 — 캐시 폴더를 정할 수 없다")?;
    let dir = bin.parent().and_then(|p| p.parent()).ok_or("캐시 경로 오류")?.to_path_buf();
    // with_extension 은 버전의 ".5" 를 확장자로 보고 바꿔 버린다 — 이름을 직접 붙인다
    let tmp = dir.with_file_name(format!("{NVIM_VERSION}.download"));
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    tokio::fs::create_dir_all(&tmp).await.map_err(|e| format!("캐시 폴더 생성 실패: {e}"))?;
    eprintln!("backend: nvim {NVIM_VERSION} 다운로드 → {}", dir.display());
    if let Err(e) = download_into(url, sha, &tmp, &dir).await {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Err(e);
    }
    // 옛 버전 정리 — nvim/ 아래 이 버전 폴더만 남긴다
    if let Ok(mut rd) = tokio::fs::read_dir(dir.parent().unwrap()).await {
        while let Ok(Some(ent)) = rd.next_entry().await {
            if ent.file_name() != NVIM_VERSION.as_ref() as &std::ffi::OsStr {
                let _ = tokio::fs::remove_dir_all(ent.path()).await;
            }
        }
    }
    nvim_bin().ok_or_else(|| "다운로드 후에도 nvim 이 없다".to_string())
}

/// 받아서 검증하고 tmp 에 푼 뒤 dir 로 rename — 실패는 호출측이 tmp 를 지운다.
/// 오류 문구에 URL 은 넣지 않는다 (close 사유 123B 한도 — 사유가 먼저 보여야 한다)
async fn download_into(url: &str, sha: &str, tmp: &PathBuf, dir: &PathBuf) -> Result<(), String> {
    let bytes = reqwest::get(url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("nvim 다운로드 실패: {}", e.without_url()))?
        .bytes()
        .await
        .map_err(|e| format!("nvim 다운로드 실패: {}", e.without_url()))?
        .to_vec();
    let got = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(&bytes));
    if got != sha {
        return Err(format!("nvim 압축본 해시 불일치 ({got})"));
    }
    extract(bytes, tmp.clone()).await?;
    let _ = tokio::fs::remove_dir_all(dir).await;
    tokio::fs::rename(tmp, dir).await.map_err(|e| format!("캐시 배치 실패: {e}"))
}

/// 압축본을 tmp 에 푼다 — 최상위 폴더(nvim-linux-x86_64/·nvim-win64/) 하나를 벗겨 bin/·share/ 가 바로 놓이게
#[cfg(not(windows))]
async fn extract(bytes: Vec<u8>, tmp: PathBuf) -> Result<(), String> {
    let tgz = tmp.join("nvim.tar.gz");
    tokio::fs::write(&tgz, &bytes).await.map_err(|e| format!("압축본 저장 실패: {e}"))?;
    let out = tokio::process::Command::new("tar")
        .args(["xzf", &tgz.to_string_lossy(), "-C", &tmp.to_string_lossy(), "--strip-components=1"])
        .output()
        .await
        .map_err(|e| format!("tar: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("nvim 압축 해제 실패: tar 종료 {}: {}", out.status, err.lines().last().unwrap_or("")));
    }
    let _ = tokio::fs::remove_file(&tgz).await;
    Ok(())
}

#[cfg(windows)]
async fn extract(bytes: Vec<u8>, tmp: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("zip 열기 실패: {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| format!("zip 항목 {i}: {e}"))?;
            let Some(name) = entry.enclosed_name() else { continue };
            let mut comps = name.components();
            comps.next(); // 최상위 폴더
            let rel = comps.as_path();
            if rel.as_os_str().is_empty() {
                continue;
            }
            let dst = tmp.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
                continue;
            }
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            let mut f = std::fs::File::create(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| format!("{}: {e}", dst.display()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("압축 해제 태스크 실패: {e}"))?
    .map_err(|e| format!("nvim 압축 해제 실패: {e}"))
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
    // 내려받아야 하면 먼저 텍스트 프레임 하나 — 프론트(model/nvim.ts)가 "내려받는 중" 알림을
    // 띄운다. 이 뒤로는 바이너리(nvim RPC)만 흐른다. 데몬 와이어 밖
    if nvim_bin().is_none() {
        if let Some((_, _, mb)) = ASSET {
            let _ = ws_tx.send(Message::Text(format!("downloading {NVIM_VERSION} {mb}").into())).await;
        }
    }
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
