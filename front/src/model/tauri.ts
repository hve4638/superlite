/**
 * Tauri 전역(withGlobalTauri 의 window.__TAURI__) 접근자 — 앱에서만 정의되고 웹·mock 은
 * undefined. 타입과 전역 조회를 한 곳에 두어 모듈마다 `window as { __TAURI__?: ... }` 를
 * 되풀이하지 않는다. "앱인가" 판정은 여기서 하지 않는다 — window.inApp(창 제어 유무)과
 * sessions env.kind(조립 지점이 정한 환경)가 각자의 뜻으로 판정한다.
 * 최상위 프레임에서만 본다 — Windows(WebView2)는 초기화 스크립트를 iframe 서브프레임에도 주입해
 * URL 탭 안 페이지에도 전역이 생기는데, 그 프레임의 IPC 는 어차피 거부되므로 없는 것으로 친다
 * (ticket app-boot-globals-iframe-leak)
 */

type TauriWindow = {
  label: string;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  destroy(): Promise<void>;
  onCloseRequested(handler: (e: { preventDefault(): void }) => void): Promise<() => void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
};

export type Tauri = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (
      name: string,
      cb: (e: { payload: unknown }) => void,
      options?: { target: string },
    ) => Promise<() => void>;
  };
  window: { getCurrentWindow(): TauriWindow };
};

export const tauri: Tauri | undefined =
  window.self === window.top ? (window as { __TAURI__?: Tauri }).__TAURI__ : undefined;
