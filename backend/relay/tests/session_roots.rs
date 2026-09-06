//! SessionRoots 해석 검증 — Registry 모드의 /ws 관문 거부·수용.
//! check*.mjs 는 bin(Fixed) 경로만 지나므로 Registry 는 여기서 잡는다.
//! 데몬은 안 띄운다 — upgrade 응답과 관문의 close 프레임까지만 본다
//! (attach 이후는 check 스크립트 몫).

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn upgrade_req(port: u16, query: &str) -> String {
    format!(
        "GET /ws{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\n\
         Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    )
}

/// /ws 업그레이드 요청을 보내고 HTTP 상태 줄을 돌려받는다
async fn ws_status(port: u16, query: &str) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(upgrade_req(port, query).as_bytes()).await.unwrap();
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).await.unwrap();
    String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_string()
}

/// upgrade 뒤 서버가 보내는 첫 WS close 프레임의 code — 관문 거부(4403) 검증용.
/// 서버는 close 전송 후 연결을 닫으므로 EOF 까지 읽으면 헤더+프레임이 전부 모인다.
async fn ws_close_code(port: u16, query: &str) -> Option<u16> {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(upgrade_req(port, query).as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    let mut tmp = [0u8; 512];
    loop {
        match s.read(&mut tmp).await {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
    }
    let body = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let frame = &buf[body..];
    // 0x88 = FIN + close opcode, payload 앞 2바이트가 code (서버 프레임은 마스크 없음)
    (frame.len() >= 4 && frame[0] == 0x88)
        .then(|| u16::from_be_bytes([frame[2], frame[3]]))
}

async fn spawn_serve(roots: superlite_backend::SessionRoots) -> u16 {
    // 실 데몬 소켓을 건드리지 않게 격리 — 접속 실패는 이 테스트 범위 밖이라 무해
    std::env::set_var("SUPERLITE_SOCK", std::env::temp_dir().join("slt-none.sock"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(superlite_backend::serve(listener, roots, Some("t0k".into()), None));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    port
}

#[tokio::test]
async fn registry_rejects_unknown_and_accepts_registered() {
    let list = Arc::new(Mutex::new(vec![
        ("s1".to_string(), Some(std::env::temp_dir())),
        ("e1".to_string(), None),
    ]));
    let port = spawn_serve(superlite_backend::SessionRoots::Registry(list)).await;

    // 미등록·부재·루트 없는(빈) 세션 — upgrade 는 받되 close 4403 으로 거부.
    // HTTP 403 이면 브라우저 front 가 일반 끊김과 구분하지 못해 무한 재연결에 빠진다
    assert_eq!(ws_close_code(port, "?tkn=t0k&session=zz").await, Some(4403));
    assert_eq!(ws_close_code(port, "?tkn=t0k").await, Some(4403));
    assert_eq!(ws_close_code(port, "?tkn=t0k&session=e1").await, Some(4403));
    // 등록된 세션 — 업그레이드 수용
    assert!(ws_status(port, "?tkn=t0k&session=s1").await.contains("101"));
    // 토큰 불일치는 레지스트리 이전에 걸린다 (기존 인증 규칙 유지 — HTTP 403)
    assert!(ws_status(port, "?tkn=bad&session=s1").await.contains("403"));
}

#[tokio::test]
async fn fixed_accepts_any_session() {
    let port = spawn_serve(superlite_backend::SessionRoots::Fixed(std::env::temp_dir())).await;

    // 종전 동작 — 세션 유무·값과 무관하게 수용
    assert!(ws_status(port, "?tkn=t0k").await.contains("101"));
    assert!(ws_status(port, "?tkn=t0k&session=whatever").await.contains("101"));
}
