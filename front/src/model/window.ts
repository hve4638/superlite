import { reactive } from '@vue/reactivity';
import { tauri } from './tauri';

// Tauri 창 제어 (앱 전용) — withGlobalTauri 전역으로 현재 창을 다룬다.
// 브라우저에서는 inApp=false 이고 TitleBar 가 창 제어 버튼 자체를 숨긴다.
const current = tauri?.window.getCurrentWindow();

export const inApp = current !== undefined;

/** 이 창의 Tauri label — native 가 주입한다 (창 간 탭 이동에서 출처·대상을 가리키는 주소).
 *  웹·mock 은 null (창 개념 없음) */
export const windowLabel: string | null =
  (window as { __SUPERLIGHT_WINDOW__?: string }).__SUPERLIGHT_WINDOW__ ?? current?.label ?? null;

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
