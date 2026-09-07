import { EmptyBackend } from '../backend/empty';
import { MockBackend } from '../backend/mock';
import { WsBackend } from '../backend/ws';
import type { ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { daemonClean } from './daemon';
import { errText, notify } from './notifications';
import { configureNvim } from './nvim';
import type { SessionCtx } from './session';
import { tauri } from './tauri';
import {
  activateSession,
  activeSessionCtx,
  activeSessionEmpty,
  bootSession,
  cancelBackground,
  configureSessions,
  genSessionId,
  openInBackground,
  openWebFolder,
  remoteHost,
  replaceAppSession,
  rootOfBackend,
  type OpenMode,
  sessions,
  type SessionTab,
} from './sessions';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점 (itir boundary assembly) — 세션 관리자에
//      환경(kind·연결 생성기)을 주입하고 부팅 세션들을 등록한다.
//      ?ws → 백엔드 /ws (같은 오리진 — 개발은 vite 프록시, 프론트는 데몬 주소를 모른다).
//      기본은 mock — differential·기존 테스트 경로를 그대로 두기 위해.
const params = new URLSearchParams(location.search);
// 페이지 URL 의 ?tkn= 을 /ws 로 넘긴다 — 백엔드가 SUPERLITE_TOKEN 으로 떠 있으면 필수.
// tkn 이 있다는 것 자체가 실 백엔드 의도다 — ?ws 를 빼먹었다고 조용히 mock 이 되지 않게
const tkn = params.get('tkn');
/** 웹 실백엔드 모드 — ?ws 또는 ?tkn 이 있으면 같은 오리진 /ws 에 붙는다 (없으면 mock) */
const webBackend = params.has('ws') || tkn !== null;
// Tauri 앱은 자산 로드라 location 이 relay 가 아니다 — 주입된 endpoint 가 최우선.
// 세션 목록도 함께 주입된다 — native 레지스트리가 발급한 id 만 relay 가 허용한다
const injected = (window as { __SUPERLITE_WS__?: string }).__SUPERLITE_WS__;
const injectedSessions = (window as { __SUPERLITE_SESSIONS__?: SessionTab[] }).__SUPERLITE_SESSIONS__;

/** 'Open Folder' 경로 퀵인풋의 시작 경로 (열린 워크스페이스가 없는 빈 세션에서 쓴다).
 *  native 가 OS 에 맞게 주입한다 — Windows 는 드라이브 루트(예: 'C:/'), 그 외 '/'.
 *  주입이 없으면(웹) '/' — 웹은 보통 부팅 세션 root 에서 시작해 이 값을 안 쓴다. */
export const openRootDefault: string =
  (window as { __SUPERLITE_OPEN_ROOT__?: string }).__SUPERLITE_OPEN_ROOT__ ?? '/';

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
  configureSessions({ kind: 'app', backendFor: appBackendOf, onRequest: handleRequest });
  // 임베드 nvim (편집기 vim 모드) — relay 의 /nvim, /ws 와 같은 주소·토큰
  configureNvim(injected.replace(/\/ws(\?|$)/, '/nvim$1'));
  // 부팅 세션들 — native 가 initialization_script 로 목록을 주입한다 (복원이면 여럿).
  // 마지막 탭이 활성이 된다
  for (const t of injectedSessions ?? []) bootSession(t, appBackendOf(t));
} else if (webBackend) {
  configureSessions({ kind: 'web', backendFor: backendOf, onRequest: handleRequest });
  configureNvim(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/nvim${tkn !== null ? `?tkn=${tkn}` : ''}`);
  const folder = params.get('folder') ?? '';
  const id = genSessionId();
  const name = folder.split('/').filter((s) => s !== '').pop() ?? '';
  bootSession({ id, name, root: folder }, new WsBackend(webWsUrl(folder), id));
} else {
  configureSessions({ kind: 'mock', backendFor: () => new MockBackend() });
  configureNvim(null); // mock 은 relay 가 없다 — vim 모드 없음
  bootSession({ id: 'mock', name: '', root: '' }, new MockBackend());
}

/**
 * 데몬 소켓 요청자(셸 심 `superlite …`, ticket cli-open-command)가 세션에 보낸 요청의 처리
 * (와이어 v9). 통로의 첫 핸들러 둘 — notify(알림 표시)·open(경로 열기: 파일은 그 세션
 * 편집기, 폴더는 폴더 열기). 이후 전용 명령은 여기에 method 를 더한다. 결과는 요청자에게
 * 돌아가고 throw 는 에러로 돌아간다. 요청이 온 세션 탭으로 전환한다 (VS Code 가 요청한
 * 창을 앞으로 가져오는 것과 같은 의미 — OS 수준 창 포커스는 없음)
 */
async function handleRequest(
  tab: SessionTab,
  ctx: SessionCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'notify': {
      const sev = p.severity === 'error' || p.severity === 'warning' ? p.severity : 'info';
      notify(sev, String(p.message ?? ''));
      return null;
    }
    case 'open': {
      const abs = typeof p.path === 'string' ? p.path : '';
      if (!abs) throw new Error('path 필요');
      const { full, wire } = requestPath(ctx.workbench.workbench.rootPath, abs);
      // 파일인가 — stat 은 정규 파일만 성공한다. 아니면 폴더 나열(browseDir, 절대 경로)로
      // 확인, 그것도 실패하면 그 에러(경로 부재 등)가 요청자에게 돌아간다
      const isFile = await ctx.backend.stat(wire).then(() => true, () => false);
      if (!isFile) {
        if (!ctx.backend.browseDir) throw new Error('폴더 열기 미지원');
        await ctx.backend.browseDir(full);
      }
      activateSession(tab.id);
      if (isFile) {
        if (!(await ctx.editors.openFile(wire))) throw new Error(`열 수 없다: ${abs}`);
        return { kind: 'file' };
      }
      openFolder(full); // 활성 세션 기준 원격 판정 — 방금 전환했으므로 이 세션의 호스트다
      return { kind: 'folder' };
    }
    default:
      throw new Error(`미지 요청: ${method}`);
  }
}

/** 요청자가 준 절대 경로 → full('/' 구분 절대 경로 — 폴더 열기·browseDir 용)과 wire(파일
 *  단건 RPC 용 — 루트 안이면 상대화, 밖이면 절대 경로 그대로. readFile/stat 은 절대 경로
 *  허용 — OS 드롭과 같은 규칙). 드라이브 경로(Windows)만 '\\' 를 '/' 로 — unix 는 '\\' 가
 *  파일명 문자다 */
function requestPath(rootPath: string, abs: string): { full: string; wire: string } {
  const win = /^[a-zA-Z]:/.test(abs);
  const full = win ? abs.replaceAll('\\', '/') : abs;
  const root = (win ? rootPath.replaceAll('\\', '/') : rootPath).replace(/\/+$/, '');
  const inRoot =
    root !== '' &&
    (win ? full.toLowerCase().startsWith(`${root.toLowerCase()}/`) : full.startsWith(`${root}/`));
  return { full, wire: inRoot ? full.slice(root.length + 1) : full };
}

/** 활성 세션의 백엔드 — 종전 싱글턴 이름 유지 (monaco·QuickInput·commands 가 쓴다) */
export const backend: ThinBackend = viewOf(() => ctx().backend);

/** 활성 탭이 빈 세션이면 그 id — 폴더 열기가 새 탭 대신 그 자리를 교체하게 하는 인자 */
function replaceTarget(): string | undefined {
  return activeSessionEmpty() ? sessions.activeId : undefined;
}

/**
 * 백엔드 자체 HTTP API(/ssh/*) 주소 — 데몬 와이어(/ws) 밖에서 백엔드가 직접 응답하는
 * 첫 표면이다 (주소·연결은 백엔드 소유 — ws docs/decision/remote-ssh.md). 웹은 같은
 * 오리진 상대 경로, 앱은 주입된 WS endpoint 에서 오리진·토큰을 유도한다.
 * mock 은 null — 호출측(원격 탐색기)이 UI 를 감추는 신호다.
 */
export function backendApiUrl(path: string, query: Record<string, string> = {}): string | null {
  const q = new URLSearchParams(query);
  if (injected) {
    const u = new URL(injected.replace(/^ws/, 'http'));
    const t = u.searchParams.get('tkn');
    if (t !== null) q.set('tkn', t);
    const qs = q.toString();
    return `${u.origin}${path}${qs ? `?${qs}` : ''}`;
  }
  if (!webBackend) return null;
  if (tkn !== null) q.set('tkn', tkn);
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}

/**
 * '폴더 열기' 확정의 단일 진입점 — 환경 분기가 여기 숨어 퀵인풋·원격 탐색기는 환경을
 * 모른다. 앱·웹 모두 "새 세션 탭 추가"이되, 활성 탭이 빈 세션이면 그 자리를 교체한다 (시작
 * 페이지에서 열기 흐름). 앱은 native 커맨드 open_folder_path invoke (검증·세션 등록은
 * native 소유 — sessions-changed 반향으로 탭이 생긴다), 웹은 front 세션 관리자가
 * ?folder= 연결을 하나 더 연다. mock 은 무동작.
 * opts.mode: 'replace' 는 활성 탭이 비어 있지 않아도 대체한다 (VS Code 원격의 "현재 창에
 * 연결" — 웹은 openWebFolder replace, 앱은 invoke 후 replaceAppSession). 'new' 는 활성 탭이
 * 빈 세션이어도 남기고 새 탭을 배경에 더한다 — 현재 탭이 활성으로 남는다 (원격 탐색기의
 * "새 탭에 연결", 2026-09-05). 생략은 기본 — 활성 빈 탭만 제자리 교체. */
export function openFolder(root: string, opts: { mode?: OpenMode } = {}): void {
  // 원격 세션 안의 '폴더 열기' — 퀵인풋의 browseDir 는 원격 데몬을 탐색하므로 확정된
  // 절대 경로는 그 호스트의 경로다 (VS Code 원격 창의 Open Folder 와 동일). 세션 root 표기
  // (ssh://host/path)로 되돌려 relay 가 원격으로 해석하게 한다
  const active = sessions.list.find((t) => t.id === sessions.activeId);
  const host = active?.root ? remoteHost(active.root) : null;
  if (host !== null && !root.startsWith('ssh://')) root = `ssh://${host}${root}`;
  if (tauri) {
    // 빈 탭은 native 가 제자리 교체(replace id), 비어 있지 않은 탭의 대체는 invoke 뒤
    // 이전 탭을 닫는 front 뒷정리다 (native replace 는 root 없는 세션만 받는다)
    const prevId = sessions.activeId;
    // 'replace' 도 활성 탭이 비어 있으면 native 제자리 교체를 쓴다 — 대상이 이미 열려 있어
    // native 가 포커스만 옮기면 교체 슬롯은 건드리지 않으므로 Welcome 탭이 남는다 (2026-09-05)
    const emptyTarget = opts.mode === 'new' ? undefined : replaceTarget();
    // 'new' 는 배경 열기 — sessions-changed 가 invoke 응답보다 먼저 올 수 있어 예약이 앞선다
    if (opts.mode === 'new') openInBackground(root);
    // native 가 canonicalize·디렉토리 검증을 한다 — 잘못된 경로(오타·부재)는 reject 로
    // 오므로 알림으로 드러낸다 (경로 퀵인풋은 자동완성 없이도 타이핑 확정을 허용한다)
    void tauri.core
      .invoke('open_folder_path', { path: root, replace: emptyTarget })
      .then(() => {
        if (opts.mode === 'replace' && emptyTarget === undefined) replaceAppSession(prevId, root);
      })
      .catch((e) => {
        cancelBackground(root);
        notify('error', `폴더를 열 수 없습니다: ${String(e)}`);
      });
    return;
  }
  if (!webBackend) return;
  openWebFolder(root, opts.mode);
}

/** OS 폴더 다이얼로그 열기 (앱 전용) — 팔레트 커맨드·퀵인풋의 두 번째 Ctrl+O 가
 *  공유한다. 활성 빈 탭의 교체 판단(replace)을 한 곳에 모은다 */
export function openFolderDialog(): void {
  void tauri?.core.invoke('open_folder', { replace: replaceTarget() });
}

/**
 * 강제 정리 확인 — 승인 시 백엔드 POST /daemon/clean(host 는 실패 세션의 root 에서) 로
 * `superlite-daemon --clean` 을 원격(로컬 세션이면 로컬)에서 실행하고, 결과를 알림으로 보인
 * 뒤 그 세션을 재접속한다. 사용자 승인 없이는 아무것도 죽이지 않는다 (ticket daemon-cleanup)
 */
export async function confirmDaemonClean(): Promise<void> {
  const backend = daemonClean.pending;
  if (backend === null) return;
  daemonClean.pending = null;
  daemonClean.busy = true;
  try {
    const root = rootOfBackend(backend);
    const host = root === null ? null : remoteHost(root);
    const url = backendApiUrl('/daemon/clean', host === null ? {} : { host });
    if (url === null) throw new Error('원격 미지원 환경');
    const res = await fetch(url, { method: 'POST' });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    notify('info', `데몬 정리:\n${text.trim() || '(정리할 것 없음)'}`);
    backend.reconnect?.();
  } catch (e) {
    notify('error', `데몬 정리 실패: ${errText(e)}`);
  } finally {
    daemonClean.busy = false;
  }
}

/** 영구 실패 뒤 사용자 주도 재접속 (시작 페이지 Retry) — 활성 세션의 백엔드를 다시 연다 */
export function retryActiveConnection(): void {
  const c = activeSessionCtx();
  c?.backend.reconnect?.();
}
