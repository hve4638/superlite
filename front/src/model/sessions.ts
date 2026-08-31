import { reactive } from '@vue/reactivity';

// 워크스페이스 세션 탭 (앱 전용) — 목록·순서의 단일 출처는 native 세션 레지스트리고
// 여기는 그 사영이다. 활성 탭 = 이 창 자신의 세션 (세션마다 창이 있고, 전환은 native 가
// 창 show/hide 로 수행한다). 브라우저(__TAURI__ 없음)에서는 빈 목록으로 남고 TitleBar 가
// 탭 스트립 자체를 그리지 않는다.

export type SessionTab = { id: string; name: string; root: string };

type Tauri = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (name: string, cb: (e: { payload: SessionTab[] }) => void) => Promise<() => void>;
  };
};

const tauri = (window as { __TAURI__?: Tauri }).__TAURI__;

// native 레지스트리가 발급한 이 창의 세션 id — host.ts 가 읽는 주입 값과 같다
export const ownSession =
  (window as { __SUPERLIGHT_SESSION__?: string }).__SUPERLIGHT_SESSION__ ?? '';

export const sessions = reactive({ list: [] as SessionTab[] });

export function initSessions(): void {
  if (!tauri) return;
  const refresh = () =>
    void tauri.core.invoke('list_sessions').then((r) => {
      sessions.list = r as SessionTab[];
    });
  refresh();
  void tauri.event.listen('sessions-changed', (e) => {
    sessions.list = e.payload;
  });
  // WHY: 숨은 창(배경 탭)은 렌더러가 절전돼 이벤트 반영이 늦을 수 있다 — 다시 보일 때 재조회
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

/** 탭 클릭 전환 — 실행은 native (대상 창을 이 자리에 보이고 이 창을 숨긴다) */
export function activateSession(id: string): void {
  if (id !== ownSession) void tauri?.core.invoke('activate_session', { id });
}

/** 탭 닫기 = 세션 종료 — 레지스트리 제거·창 close, 데몬 터미널은 grace 후 회수 (native 주석 참조) */
export function closeSession(id: string): void {
  void tauri?.core.invoke('close_session', { id });
}

/** 탭 추가 — 폴더 선택 dialog 로 새 세션 (폴더 열기 커맨드와 같은 native 경로) */
export function addSession(): void {
  void tauri?.core.invoke('open_folder');
}
