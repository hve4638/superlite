import { EmptyBackend } from '../backend/empty';
import { MockBackend } from '../backend/mock';
import { WsBackend } from '../backend/ws';
import type { ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { notify } from './notifications';
import {
  activeSessionEmpty,
  bootSession,
  configureSessions,
  genSessionId,
  openWebFolder,
  sessions,
  type SessionTab,
} from './sessions';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점 (itir boundary assembly) — 세션 관리자에
//      환경(kind·연결 생성기)을 주입하고 부팅 세션들을 등록한다.
//      ?ws → 백엔드 /ws (같은 오리진 — 개발은 vite 프록시, 프론트는 데몬 주소를 모른다).
//      기본은 mock — differential·기존 테스트 경로를 그대로 두기 위해.
const params = new URLSearchParams(location.search);
// 페이지 URL 의 ?tkn= 을 /ws 로 넘긴다 — 백엔드가 SUPERLIGHT_TOKEN 으로 떠 있으면 필수.
// tkn 이 있다는 것 자체가 실 백엔드 의도다 — ?ws 를 빼먹었다고 조용히 mock 이 되지 않게
const tkn = params.get('tkn');
// Tauri 앱은 자산 로드라 location 이 relay 가 아니다 — 주입된 endpoint 가 최우선.
// 세션 목록도 함께 주입된다 — native 레지스트리가 발급한 id 만 relay 가 허용한다
const injected = (window as { __SUPERLIGHT_WS__?: string }).__SUPERLIGHT_WS__;
const injectedSessions = (window as { __SUPERLIGHT_SESSIONS__?: SessionTab[] }).__SUPERLIGHT_SESSIONS__;
const injectedSession = (window as { __SUPERLIGHT_SESSION__?: string }).__SUPERLIGHT_SESSION__;

/** 'Open Folder' 경로 퀵인풋의 시작 경로 (열린 워크스페이스가 없는 빈 세션에서 쓴다).
 *  native 가 OS 에 맞게 주입한다 — Windows 는 드라이브 루트(예: 'C:/'), 그 외 '/'.
 *  주입이 없으면(웹) '/' — 웹은 보통 부팅 세션 root 에서 시작해 이 값을 안 쓴다. */
export const openRootDefault: string =
  (window as { __SUPERLIGHT_OPEN_ROOT__?: string }).__SUPERLIGHT_OPEN_ROOT__ ?? '/';

/** 웹 /ws 주소 — 세션(탭)마다 ?folder= 로 root 를 지정한다 (빈 root 는 서버 기본 root) */
function webWsUrl(folder: string): string {
  const q = new URLSearchParams();
  if (tkn !== null) q.set('tkn', tkn);
  if (folder !== '') q.set('folder', folder);
  const qs = q.toString();
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${qs ? `?${qs}` : ''}`;
}

// 빈 세션(root null)은 연결을 열지 않는다 — 앱·웹 공통 (레지스트리에 root 가 없어
// relay 도 거부한다. 폴더를 열면 세션째로 교체되므로 재연결이 아니라 새 연결이다)
const backendOf = (t: { id: string; root: string | null }): ThinBackend =>
  t.root === null ? new EmptyBackend() : new WsBackend(webWsUrl(t.root), t.id);

if (injected) {
  const appBackendOf = (t: { id: string; root: string | null }): ThinBackend =>
    t.root === null ? new EmptyBackend() : new WsBackend(injected, t.id);
  configureSessions({ kind: 'app', backendFor: appBackendOf });
  // 부팅 세션들 — native 가 initialization_script 로 목록을 주입한다 (복원이면 여럿).
  // 단일 세션 주입(__SUPERLIGHT_SESSION__)은 과도기 호환. 마지막 탭이 활성이 된다
  const list =
    injectedSessions ?? (injectedSession ? [{ id: injectedSession, name: '', root: '' }] : []);
  for (const t of list) bootSession(t, appBackendOf(t));
} else if (params.has('ws') || tkn !== null) {
  configureSessions({ kind: 'web', backendFor: backendOf });
  const folder = params.get('folder') ?? '';
  const id = genSessionId();
  const name = folder.split('/').filter((s) => s !== '').pop() ?? '';
  bootSession({ id, name, root: folder }, new WsBackend(webWsUrl(folder), id));
} else {
  configureSessions({ kind: 'mock', backendFor: () => new MockBackend() });
  bootSession({ id: 'mock', name: '', root: '' }, new MockBackend());
}

/** 활성 세션의 백엔드 — 종전 싱글턴 이름 유지 (monaco·QuickInput·commands 가 쓴다) */
export const backend: ThinBackend = viewOf(() => ctx().backend);

type TauriInvoke = {
  core: { invoke: (cmd: string, args?: object) => Promise<void> };
};

/** 활성 탭이 빈 세션이면 그 id — 폴더 열기가 새 탭 대신 그 자리를 교체하게 하는 인자 */
function replaceTarget(): string | undefined {
  return activeSessionEmpty() ? sessions.activeId : undefined;
}

/**
 * '폴더 열기' 확정의 단일 진입점 — 환경 분기가 여기 숨어 퀵인풋은 환경을 모른다.
 * 앱·웹 모두 "새 세션 탭 추가"이되, 활성 탭이 빈 세션이면 그 자리를 교체한다 (시작
 * 페이지에서 열기 흐름). 앱은 native 커맨드 open_folder_path invoke (검증·세션 등록은
 * native 소유 — sessions-changed 반향으로 탭이 생긴다), 웹은 front 세션 관리자가
 * ?folder= 연결을 하나 더 연다. mock 은 무동작.
 */
export function openFolder(root: string): void {
  const tauri = (window as { __TAURI__?: TauriInvoke }).__TAURI__;
  if (tauri) {
    // native 가 canonicalize·디렉토리 검증을 한다 — 잘못된 경로(오타·부재)는 reject 로
    // 오므로 알림으로 드러낸다 (경로 퀵인풋은 자동완성 없이도 타이핑 확정을 허용한다)
    void tauri.core
      .invoke('open_folder_path', { path: root, replace: replaceTarget() })
      .catch((e) => notify('error', `폴더를 열 수 없습니다: ${String(e)}`));
    return;
  }
  if (!(params.has('ws') || tkn !== null)) return;
  openWebFolder(root);
}

/** OS 폴더 다이얼로그 열기 (앱 전용) — Ctrl+Shift+O 커맨드·시작 페이지·+ 드롭다운이
 *  공유한다. 활성 빈 탭의 교체 판단(replace)을 한 곳에 모은다 */
export function openFolderDialog(): void {
  const tauri = (window as { __TAURI__?: TauriInvoke }).__TAURI__;
  void tauri?.core.invoke('open_folder', { replace: replaceTarget() });
}
