import { reactive } from '@vue/reactivity';

// Tauri 창 제어 (앱 전용) — withGlobalTauri 전역으로 현재 창을 다룬다.
// 브라우저에서는 inApp=false 이고 TitleBar 가 창 제어 버튼 자체를 숨긴다.
type TauriWindow = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
};

const current = (
  window as { __TAURI__?: { window: { getCurrentWindow(): TauriWindow } } }
).__TAURI__?.window.getCurrentWindow();

export const inApp = current !== undefined;

export const appWindow = reactive({ maximized: false });

// WHY: 최대화 상태는 resize 이벤트로 추적한다 — 버튼 클릭 외에도 더블클릭·
//      드래그 스냅·OS 단축키 등 경로가 많아 클릭 시점 토글로는 어긋난다.
async function refreshMaximized(): Promise<void> {
  if (current) appWindow.maximized = await current.isMaximized();
}
if (current) {
  void refreshMaximized();
  void current.onResized(() => void refreshMaximized());
}

export function minimizeWindow(): void {
  void current?.minimize();
}

export function toggleMaximizeWindow(): void {
  void current?.toggleMaximize();
}

export function closeWindow(): void {
  void current?.close();
}
