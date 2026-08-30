//! superlight-app — Tauri 데스크톱 껍데기. front dist 를 자산으로 번들하고,
//! relay(serve)를 loopback 임의 포트로 in-process 기동해 WS endpoint 를 webview 에
//! 주입한다. 와이어 계약·daemon 분리 수명(tmux 식)은 그대로 — Tauri IPC 전환은 비목표.
//!
//! 실행: superlight-app [워크스페이스루트]  (기본 cwd)

// 릴리스 Windows 에서 콘솔 창이 같이 뜨지 않게
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::path::PathBuf;

fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    // plain: Windows verbatim 루트는 '/' 와이어 경로·자식 cwd 를 깨뜨린다 (common 참조)
    let root =
        superlight_common::plain(root.canonicalize().expect("워크스페이스 루트 경로가 존재해야 한다"));

    // 기동마다 새 랜덤 토큰 — 같은 머신의 외부 브라우저·임의 웹페이지가 /ws 에 붙지 못하게.
    // 주입 URL 밖으로는 전달되지 않는다.
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("난수 생성 실패");
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();

    // :0 bind — 포트는 OS 가 고르므로 고정 포트 충돌이 없다. 주입 URL 이 유일한 전달 경로.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback bind 실패");
    listener.set_nonblocking(true).expect("nonblocking 전환 실패");
    let port = listener.local_addr().expect("local_addr").port();
    let ws_url = format!("ws://127.0.0.1:{port}/ws?tkn={token}");

    // relay 는 별도 스레드의 tokio 런타임에서 — Tauri 의 메인 스레드(이벤트 루프)와 분리
    {
        let token = token.clone();
        std::thread::spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio 런타임 생성 실패")
                .block_on(async move {
                    let listener =
                        tokio::net::TcpListener::from_std(listener).expect("listener 전환 실패");
                    superlight_backend::serve(listener, root, Some(token), None).await;
                });
        });
    }

    tauri::Builder::default()
        .setup(move |app| {
            // 포트가 런타임에 정해지므로 창은 코드로 생성 — initialization_script 는
            // 프론트 코드 실행 전에 평가된다 (host.ts 가 __SUPERLIGHT_WS__ 를 읽는다)
            // WHY: 숨김 기동(visible false → load 후 show)은 쓰지 않는다 — WebView2 가 숨김
            //      상태에서 로딩을 미뤄 오히려 흰 화면이 길어지는 역효과가 실측됐다.
            //      흰 플래시는 창 배경색 + index.html 인라인 배경으로 막는다.
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("superlight")
                .inner_size(1200.0, 800.0)
                // 첫 페인트 전 흰 플래시 방지 — 테마 배경(--vscode-editor-background)과 일치
                .background_color(tauri::window::Color(0x1f, 0x1f, 0x1f, 0xff))
                .initialization_script(&format!("window.__SUPERLIGHT_WS__ = '{ws_url}';"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 기동 실패");
}
