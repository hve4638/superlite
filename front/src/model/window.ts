import { reactive } from '@vue/reactivity';
import { tauri } from './tauri';

// Tauri 창 제어 (앱 전용) — withGlobalTauri 전역으로 현재 창을 다룬다.
// 브라우저에서는 inApp=false 이고 TitleBar 가 창 제어 버튼 자체를 숨긴다.
const current = tauri?.window.getCurrentWindow();

export const inApp = current !== undefined;

/** 이 창의 Tauri label — native 가 주입한다 (창 간 탭 이동에서 출처·대상을 가리키는 주소).
 *  웹·mock 은 null (창 개념 없음) */
export const windowLabel: string | null =
  (window as { __SUPERLITE_WINDOW__?: string }).__SUPERLITE_WINDOW__ ?? current?.label ?? null;

/** 서브 창의 소속 메인 창 label — native 주입 __SUPERLITE_OWNER__ (에디터·터미널 탭 분리로 생긴 창만).
 *  메인 창(첫 창·세션 탭 분리로 생긴 창)·웹·mock 은 null */
export const ownerWindow: string | null = (window as { __SUPERLITE_OWNER__?: string | null }).__SUPERLITE_OWNER__ ?? null;

/** 서브 창인가 — 소속 메인이 있다. 셸은 사이드바·액티비티바를 기본 숨기고, 세션 탭 스트립은 메인 것을
 *  비추며 전환만 된다 (decision/workspace-session-tabs.md 2026-09-08 개정, ticket window-secondary-no-sidebar) */
export const subWindow: boolean = ownerWindow !== null;

/** 부팅 시점의 활성 세션 (메인 창 묶음 공유값) — native 주입, 서브 창이 메인의 활성 탭으로 시작하게 */
export const bootActiveSession: string | null =
  (window as { __SUPERLITE_ACTIVE__?: string | null }).__SUPERLITE_ACTIVE__ ?? null;

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

/** 창 파괴 — onCloseRequested 를 거치지 않는다. 서브 창이 탭을 메인에 되돌린 뒤 스스로 닫을 때 */
export function destroyWindow(): void {
  // 거부(권한 누락 등)는 조용히 남는 창이 된다 — 콘솔에 남긴다 (capabilities 의 allow-destroy)
  current?.destroy().catch((e: unknown) => console.error('창 파괴 실패:', e));
}

/** OS·X 닫기 요청 훅 — 서브 창이 닫히기 전에 탭을 메인에 되돌리려고 막는다. 웹은 무동작 */
export function onWindowCloseRequested(handler: () => void): void {
  void current?.onCloseRequested((e) => {
    e.preventDefault();
    handler();
  });
}

/** 앱 전체 웹뷰 줌 — 레벨·저장·모든 창 적용은 native (set_zoom) 몫. 웹은 브라우저 줌이 있어 무동작 */
export function zoomWindow(action: 'in' | 'out' | 'reset'): void {
  void tauri?.core.invoke('set_zoom', { action });
}
