//! SessionRoots 해석 검증 — Registry 모드의 /ws 관문 거부·수용.
//! check*.mjs 는 bin(Fixed) 경로만 지나므로 Registry 는 여기서 잡는다.
//! 데몬은 안 띄운다 — upgrade 응답(101/403)까지만 본다 (attach 이후는 check 스크립트 몫).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// /ws 업그레이드 요청을 보내고 HTTP 상태 줄을 돌려받는다
async fn ws_status(port: u16, query: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let req = format!(
        "GET /ws{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\n\
         Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).await.unwrap();
    String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_string()
}

async fn spawn_serve(roots: superlight_backend::SessionRoots) -> u16 {
    // 실 데몬 소켓을 건드리지 않게 격리 — 접속 실패는 이 테스트 범위 밖이라 무해
    std::env::set_var("SUPERLIGHT_SOCK", std::env::temp_dir().join("slt-none.sock"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(superlight_backend::serve(listener, roots, Some("t0k".into()), None));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    port
}

#[tokio::test]
async fn registry_rejects_unknown_and_accepts_registered() {
    let list = Arc::new(Mutex::new(vec![("s1".to_string(), std::env::temp_dir())]));
    let port = spawn_serve(superlight_backend::SessionRoots::Registry(list)).await;

    // 미등록 세션·세션 부재 — root 를 해석할 수 없으므로 관문에서 거부
    assert!(ws_status(port, "?tkn=t0k&session=zz").await.contains("403"));
    assert!(ws_status(port, "?tkn=t0k").await.contains("403"));
    // 등록된 세션 — 업그레이드 수용
    assert!(ws_status(port, "?tkn=t0k&session=s1").await.contains("101"));
    // 토큰 불일치는 레지스트리 이전에 걸린다 (기존 인증 규칙 유지)
    assert!(ws_status(port, "?tkn=bad&session=s1").await.contains("403"));
}

#[tokio::test]
async fn fixed_accepts_any_session() {
    let port = spawn_serve(superlight_backend::SessionRoots::Fixed(std::env::temp_dir())).await;

    // 종전 동작 — 세션 유무·값과 무관하게 수용
    assert!(ws_status(port, "?tkn=t0k").await.contains("101"));
    assert!(ws_status(port, "?tkn=t0k&session=whatever").await.contains("101"));
}
