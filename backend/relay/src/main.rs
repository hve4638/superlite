//! superlight-backend — 앱 인스턴스당 1개. 웹(정적) 서빙 + WS 인터페이스.
//! 중계 본체는 lib(serve) — 여기는 env 해석과 bind 만 한다.
//!
//! 실행: superlight-backend [워크스페이스루트]  (기본 cwd)
//!   SUPERLIGHT_HTTP=127.0.0.1:8795  SUPERLIGHT_DIST=front/dist
//!   SUPERLIGHT_TOKEN=<토큰>  — 설정 시 /ws 는 ?tkn= 일치 필수 (loopback 밖 노출 전제조건)

use std::path::PathBuf;

use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root =
        superlight_common::plain(root.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다"));
    // 네트워크 노출 지점은 여기 하나 — 기본은 localhost. 개발 LAN 접근은 vite(8793)가 프록시.
    let addr = std::env::var("SUPERLIGHT_HTTP").unwrap_or_else(|_| "127.0.0.1:8795".into());
    // 빌드된 프론트가 있으면 서빙. 개발 중엔 vite 가 프론트를 서빙하고 /ws 만 여기로 프록시.
    let dist = std::env::var("SUPERLIGHT_DIST").unwrap_or_else(|_| "front/dist".into());

    let token = match std::env::var("SUPERLIGHT_TOKEN") {
        // WHY: 토큰 계산이 빈 문자열을 낳은 배포 스크립트가 조용히 무인증 노출로 빠지지 않게
        Ok(t) if t.is_empty() => {
            eprintln!("superlight-backend: SUPERLIGHT_TOKEN 이 비어 있다 — 무인증으로 열지 않는다");
            std::process::exit(1);
        }
        Ok(t) => Some(t),
        Err(_) => None,
    };
    let auth = if token.is_some() { "token" } else { "off" };
    let listener = TcpListener::bind(&addr).await.expect("bind 실패 (SUPERLIGHT_HTTP 로 변경)");
    // dist 는 cwd 상대 기본값 — 다른 디렉터리에서 띄우면 404 만 나므로 경로를 같이 찍는다
    eprintln!("superlight-backend: http://{addr} root={} dist={dist} auth={auth}", root.display());
    superlight_backend::serve(listener, superlight_backend::SessionRoots::Fixed(root), token, Some(dist)).await;
}
