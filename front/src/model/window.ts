import { reactive } from '@vue/reactivity';
import { boot } from './boot';
import { tauri } from './tauri';
import { flushAllWorkspaces } from './workspaceState';
import { errText, notify } from './notifications';
import { ctx } from './ctx';
import { urlTargetOf } from './settings';

// Tauri 창 제어 (앱 전용) — withGlobalTauri 전역으로 현재 창을 다룬다.
// 브라우저에서는 inApp=false 이고 TitleBar 가 창 제어 버튼 자체를 숨긴다.
const current = tauri?.window.getCurrentWindow();

export const inApp = current !== undefined;

/** 이 창의 Tauri label — native 부팅 정보(boot_info)에서 (창 간 탭 이동에서 출처·대상을 가리키는 주소).
 *  웹·mock 은 null (창 개념 없음) */
export const windowLabel: string | null = boot?.window ?? current?.label ?? null;

/** 서브 창의 소속 메인 창 label — 부팅 정보 owner (에디터·터미널 탭 분리로 생긴 창만).
 *  메인 창(첫 창·세션 탭 분리로 생긴 창)·웹·mock 은 null */
export const ownerWindow: string | null = boot?.owner ?? null;

/** 서브 창인가 — 소속 메인이 있다. 셸은 사이드바·액티비티바를 기본 숨기고, 세션 탭 스트립은 메인 것을
 *  비추며 전환만 된다 (decision/workspace-session-tabs.md 2026-09-08 개정, ticket window-secondary-no-sidebar) */
export const subWindow: boolean = ownerWindow !== null;

/** 부팅 시점의 활성 세션 (메인 창 묶음 공유값) — 부팅 정보 active. 서브 창이 메인의 활성 탭으로 시작하고,
 *  창 새로고침이 리로드 전 활성 탭을 되찾는다 (페이지 로드마다 native 에 묻는 값이라 굳지 않는다) */
export const bootActiveSession: string | null = boot?.active ?? null;

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

/** 창 닫기 (타이틀바 ×) — 이 창의 워크스페이스 상태를 먼저 저장한다 (ticket workspace-state-restore) */
export function closeWindow(): void {
  void flushAllWorkspaces().then(() => current?.close());
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

/** 창 새로고침 (팔레트 Developer: Reload Window) — 워크스페이스 상태를 먼저 저장하고 다시 연다. 앱은 native
 *  reload_window 가 이 창이 속한 묶음(메인 + 서브 창 전부)을 함께 새로고침한다 — 세션이 native 에 남아 있어
 *  같은 id 로 재-attach 하고, 탭·배치는 저장본에서 복원된다 (메인은 자기 몫, 서브 창은 자기 서브 몫 — 서브의
 *  마지막 1초 이내 변경은 디바운스 저장 전이라 빠질 수 있다). 웹은 브라우저 새로고침과 같다 */
export function reloadWindow(): void {
  // 저장이 어떤 이유로든 끝나지 않아도 새로고침은 한다 (1.5초 상한). 앱은 native 의 webview reload —
  // WebView2 에서 서브 창의 location.reload 가 먹지 않는 사례가 있어(2026-09-08 Windows) 네이티브 경로를 쓴다
  const flushed = Promise.race([flushAllWorkspaces(), new Promise((r) => setTimeout(r, 1500))]);
  void flushed.then(() => {
    if (!tauri) {
      location.reload();
      return;
    }
    void tauri.core.invoke('reload_window').catch((e: unknown) => {
      notify('error', `Reload failed: ${String(e)} — falling back to location.reload`);
      location.reload();
    });
  });
}

/**
 * OS 입력기(IME) 전환 — vim 모드가 non-insert 로 들어갈 때 false(영문 강제, 그때 상태를 native 가 창 단위로
 * 기억), insert 진입·vim 모드 해제에 true(복원). 편집기 안에서는 OS IME 를 이길 수 없어 VSCodeVim 의
 * im-select 처럼 밖에서 바꾼다 (app/src/main set_ime, ticket editor-vim-ime-imswitch). Windows 앱만 — 웹은 무동작
 */
export function setIme(enabled: boolean): void {
  void tauri?.core.invoke('set_ime', { enabled });
}

/**
 * IME 진단 (ticket term-ime-toggle-stuck, 임시) — native 의 전경 창·키보드 포커스 HWND·IME 열림 상태 한 줄
 * (app/src/main ime_probe). 터미널이 한/영 keydown 때 imeDiag 에 남긴다. 웹·다른 OS 는 null. 원인 확정 뒤 지운다
 */
export async function imeProbe(): Promise<string | null> {
  if (!tauri) return null;
  return (await tauri.core.invoke('ime_probe')) as string;
}

/** 이 창의 웹뷰 줌 — 레벨·저장·적용은 native (set_zoom) 몫, 부른 창에만 적용된다 (ticket zoom-per-window). 웹은 브라우저 줌이 있어 무동작 */
/** URL 열기의 단일 진입점 (터미널 링크 Ctrl+클릭, 앞으로 생길 링크) — 사용자 설정의 분기 규칙(settings.urlTargetOf,
 *  ticket user-settings)으로 내부 URL 탭(editors.openUrl)과 외부 브라우저(openExternal)를 가른다 */
export function openUrl(url: string): void {
  if (urlTargetOf(url) === 'internal') ctx().editors.openUrl(url);
  else openExternal(url);
}

export function zoomWindow(action: 'in' | 'out' | 'reset'): void {
  void tauri?.core.invoke('set_zoom', { action });
}

/** 외부 브라우저로 열기 — 규칙을 거치지 않는 명시적 외부 열기(URL 탭 바의 버튼)와 openUrl 의 외부 쪽 출구.
 *  앱은 native open_url(OS 기본 브라우저 — 종전 tauri-plugin-opener 는 같은 일의 중복이라 제거, 2026-09-12),
 *  웹은 새 탭 window.open */
export function openExternal(url: string): void {
  if (tauri !== undefined) {
    void tauri.core.invoke('open_url', { url }).catch((e: unknown) => notify('error', `Open in browser failed: ${errText(e)}`));
    return;
  }
  window.open(url, '_blank', 'noopener');
}
