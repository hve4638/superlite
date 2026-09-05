import { reactive } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';
import { activeCtx } from './ctx';
import type { TabHandoff } from './editors';
import { notify } from './notifications';
import { createSessionCtx, type SessionCtx, type SessionSnapshot } from './session';
import type { TerminalInstance, TerminalSnapshot } from './terminal';
import { windowLabel } from './window';

/**
 * 워크스페이스 세션 탭 관리자 — 한 창(페이지) 안에서 세션 컨텍스트 여럿을 들고
 * 전환한다. 탭 전환 = activeCtx 교체 (창 이동 없음, 웹·앱 동일 동작).
 *
 * 목록의 단일 출처는 환경에 따라 다르다:
 * - 앱(Tauri): native 세션 레지스트리 (지속 저장·두 번째 실행의 주체). 여기는 그
 *   사영 — 추가/닫기는 native 에 invoke 하고 sessions-changed 로 되돌아온 목록에
 *   reconcile 한다. 전환만은 front 소유 (native 는 어느 탭이 보이는지 모른다).
 * - 웹: front 가 소유. 세션마다 relay /ws 연결(?folder=)을 하나씩 연다. 지속 없음 —
 *   페이지 수명 (브라우저 새로고침 = 부팅 세션 하나로 리셋).
 * - mock: 부팅 세션 하나뿐, 탭 UI 를 그리지 않는다 (sessionsEnabled=false).
 *
 * root === null 인 탭은 루트 없는 빈 세션이다 (시작 페이지) — 백엔드 연결 없이
 * (EmptyBackend) 시작 페이지만 그려지고, 폴더를 열면 그 자리가 워크스페이스 세션으로
 * 교체된다. root === '' 는 다르다 — 웹 부팅 세션의 "서버 기본 root" (연결 있음).
 * root === 'ssh://host'(경로 없음)는 원격 빈 세션 — 시작 페이지이되 연결은 있다
 * (탐색 전용 attach): 폴더 열기 퀵인풋이 그 호스트를 탐색한다 (isRemoteEmpty).
 *
 * 다중 창 (앱 전용, decision/workspace-session-tabs.md 2026-09-03 개정): 창마다 이 관리자가
 * 하나씩 있고 native 가 창 단위로 목록을 준다. 탭을 창 밖에 놓으면 새 창(detachSession·
 * detachEditorTab·detachTerminal), 다른 창에 놓으면 그 창이 출처 창에 이동을 요청하고
 * (request*), 출처 창이 그 시점 상태를 직렬화해 이동을 확정한다 — 핸드오프는 항상 출처가
 * 만들고 native 는 내용을 모른 채 전달한다. 도착한 핸드오프는 applyHandoff 가 세션에 덮어쓴다.
 */

/** 창 이동 핸드오프 — native 를 경유하는 JSON. session: 세션 탭 통째 (같은 session id 로
 *  새 창이 재-attach), tabs: 에디터·터미널 탭 일부 (같은 root 의 다른 세션으로 — 터미널은
 *  데몬 adoptTerminal, toSession 은 detach_tabs 때 native 가 채운다) */
export type Handoff =
  | { kind: 'session'; id: string; name: string; state: SessionSnapshot }
  | {
      kind: 'tabs';
      fromSession: string;
      toSession?: string;
      toGroupId?: number;
      toIndex?: number;
      editors: TabHandoff[];
      terminals: TerminalSnapshot[];
    };

/** 창 간 DnD 의 dataTransfer 타입 — dragover 중 읽을 수 있는 건 타입만이라 종류 식별에 쓴다.
 *  데이터는 JSON: 세션 {window, id}, 에디터 {window, session, root, groupId, tabId},
 *  터미널 {window, session, root, id} */
export const DND_SESSION = 'application/x-superlight-session';
export const DND_EDITOR = 'application/x-superlight-editor';
export const DND_TERMINAL = 'application/x-superlight-terminal';

export type SessionTab = { id: string; name: string; root: string | null };

type Tauri = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (
      name: string,
      cb: (e: { payload: unknown }) => void,
      options?: { target: string },
    ) => Promise<() => void>;
  };
};

const tauri = (window as { __TAURI__?: Tauri }).__TAURI__;

/** 이 창에 보낸 이벤트만 듣는다.
 *  WHY: Tauri 의 listen() 은 대상 없이 등록하면 EventTarget::Any 가 되고, Any 리스너는 native 가
 *       emit_to(label) 로 특정 창에 보낸 이벤트도 전부 받는다 (match_any_or_filter). 창마다 다른
 *       sessions-changed 목록이 모든 창에 도달해 서로의 목록으로 reconcile 을 반복했다 — 실측:
 *       한 창의 세션이 다른 창으로 갔다가 돌아오는 현상. target 을 창 label 로 주면 그 label 로
 *       보낸 것과 전역 emit 만 받는다 */
function listenHere(name: string, cb: (e: { payload: unknown }) => void): void {
  if (!tauri) return;
  void tauri.event.listen(name, cb, windowLabel !== null ? { target: windowLabel } : undefined);
}

export const sessions = reactive({ list: [] as SessionTab[], activeId: '' });
/** 초기 로드(ctx.init) 진행 중인 세션 id — 탭의 로딩 스피너. 실패도 종료다 */
export const loading = reactive(new Set<string>());

/** id → 세션 컨텍스트. 반응성 불요(외부 핸들 뭉치) — 목록 반응성은 sessions.list 가 담당 */
const ctxs = new Map<string, SessionCtx>();

interface SessionsEnv {
  kind: 'app' | 'web' | 'mock';
  /** 탭 하나의 백엔드 연결 생성 — 환경 분기는 host.ts(조립 지점)가 주입한다
   *  (root null 인 빈 세션은 EmptyBackend — 연결을 열지 않는다) */
  backendFor: (tab: { id: string; root: string | null }) => ThinBackend;
  /** 데몬 소켓 요청자(셸 심)가 세션에 보낸 요청의 처리기 (와이어 v9) — 어떤 요청이 있는지는
   *  조립 지점(host.ts)이 정한다. 반환값이 요청자에게 돌아가고 throw 는 에러로 돌아간다 */
  onRequest?: (tab: SessionTab, ctx: SessionCtx, method: string, params: unknown) => Promise<unknown>;
}
let env: SessionsEnv = { kind: 'mock', backendFor: () => { throw new Error('sessions 미구성'); } };

export function configureSessions(e: SessionsEnv): void {
  env = e;
}

/** 환경 종류 — 최근 목록(recents)이 저장소를 고른다 (앱 native state.json / 웹 localStorage / mock 없음) */
export function sessionsKind(): 'app' | 'web' | 'mock' {
  return env.kind;
}

/** 탭 UI 를 그리는가 — mock(세션 개념 없음)만 아니면 단일 탭이어도 그린다 (+ 버튼 발견성) */
export function sessionsEnabled(): boolean {
  return env.kind !== 'mock';
}

// 세션 전환 직전 훅 — monaco 가 등록해 활성 세션의 모델 캐시를 전부 버린다
// (모델은 path 키라 세션 간 충돌 — 새 세션이 doc 스냅샷에서 다시 만든다. undo 는 잃는다)
let beforeSwitch: (() => void) | null = null;
export function setBeforeSessionSwitch(fn: () => void): void {
  beforeSwitch = fn;
}

/** 백엔드 핸들 → 그 세션 탭의 root (강제 정리가 host 를 알아내는 경로). 없으면 null */
export function rootOfBackend(backend: ThinBackend): string | null {
  for (const [id, c] of ctxs) {
    if (c.backend === backend) return sessions.list.find((t) => t.id === id)?.root ?? null;
  }
  return null;
}

/** 활성 세션 컨텍스트 (없으면 null) */
export function activeSessionCtx(): SessionCtx | null {
  return ctxs.get(sessions.activeId) ?? null;
}

/** ssh://host/path 또는 ssh://host root 의 host — 원격이 아니면 null */
export function remoteHost(root: string): string | null {
  const m = /^ssh:\/\/([^/]+)(?:\/|$)/.exec(root);
  return m ? m[1] : null;
}

/** 경로 없는 원격 root(`ssh://host`) — 원격 빈 세션. 시작 페이지를 보이고 폴더 열기가 그
 *  호스트를 탐색한다 (relay 는 홈에 탐색 전용 attach). 폴더를 열면 제자리 교체된다 */
export function isRemoteEmpty(root: string | null): boolean {
  return root !== null && /^ssh:\/\/[^/]+\/?$/.test(root);
}

/** 탭 라벨 — 원격은 호스트가 정체성의 절반이라 함께 표시한다 ("proj [omc]") */
function tabLabel(root: string, name: string): string {
  const host = remoteHost(root);
  return host === null ? name : `${name} [${host}]`;
}

function addLocal(tab: SessionTab, backend?: ThinBackend): SessionCtx {
  const ctx = createSessionCtx(backend ?? env.backendFor(tab), isRemoteEmpty(tab.root));
  ctxs.set(tab.id, ctx);
  sessions.list.push({ ...tab });
  // 요청자 요청은 그 세션의 연결로 오므로 컨텍스트에 묶어 처리기로 넘긴다 (탭은 id 로 재조회 —
  // 이름·root 는 이후 바뀐다)
  ctx.backend.onRequest?.((method, params) => {
    const t = sessions.list.find((x) => x.id === tab.id);
    if (!t || !env.onRequest) return Promise.reject(new Error(`처리기 없는 요청: ${method}`));
    return env.onRequest(t, ctx, method, params);
  });
  // 이름 채움 — 워크스페이스 정보가 오면 탭 라벨을 실제 이름으로 (부팅 주입 목록은 이미 이름이 있다).
  // 원격 빈 세션은 홈 이름이 오지만 라벨은 Welcome [host] 고정 (TitleBar)
  loading.add(tab.id);
  void ctx.init().then(() => {
    loading.delete(tab.id);
    const t = sessions.list.find((x) => x.id === tab.id);
    if (t && ctx.workbench.workbench.workspaceName && !isRemoteEmpty(t.root))
      t.name = tabLabel(t.root ?? '', ctx.workbench.workbench.workspaceName);
    if (t && !t.root && ctx.workbench.workbench.rootPath) t.root = ctx.workbench.workbench.rootPath;
  }, () => {
    // 초기 로드 실패(원격 ssh 접속 실패 등) — 사유는 connection.error 로 탐색기에 보인다
    loading.delete(tab.id);
  });
  return ctx;
}

function removeLocal(id: string): void {
  const ctx = ctxs.get(id);
  if (!ctx) return;
  const idx = sessions.list.findIndex((t) => t.id === id);
  // 활성 세션 제거면 이웃(같은 인덱스, 없으면 마지막)으로 먼저 전환 — activeCtx 가
  // 폐기된 컨텍스트를 가리키는 순간이 없어야 한다
  if (sessions.activeId === id) {
    const rest = sessions.list.filter((t) => t.id !== id);
    const next = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
    if (next) activateSession(next.id);
  }
  ctxs.delete(id);
  loading.delete(id);
  if (idx !== -1) sessions.list.splice(idx, 1);
  (ctx.backend as { dispose?: () => void }).dispose?.();
}

/** 부팅 세션 등록 (host.ts 조립 시점) — 마지막으로 등록된 것이 활성이 된다 */
export function bootSession(tab: SessionTab, backend: ThinBackend): void {
  addLocal(tab, backend);
  activateSession(tab.id);
}

/** 세션 탭 순환 (Ctrl+Shift+Tab, commands.ts) — 활성 탭의 이웃으로 wrap 이동 */
export function cycleSession(dir: 1 | -1): void {
  if (sessions.list.length < 2) return;
  const i = sessions.list.findIndex((t) => t.id === sessions.activeId);
  const next = sessions.list[(i + dir + sessions.list.length) % sessions.list.length];
  activateSession(next.id);
}

/** 탭 클릭 전환 — front 소유. 대상 컨텍스트를 활성으로 바꾸면 shim·UI 가 따라온다 */
export function activateSession(id: string): void {
  if (id === sessions.activeId) return;
  const ctx = ctxs.get(id);
  if (!ctx) return;
  beforeSwitch?.();
  sessions.activeId = id;
  activeCtx.value = ctx;
}

/** 탭 닫기 = 세션 종료(kill 의미) — 연결을 끊으면 데몬이 grace 후 터미널을 회수한다.
 *  마지막 탭: 앱은 그 창을 닫고(마지막 창이면 앱 종료), 웹은 창을 닫을 수 없어 빈 세션으로
 *  대체한다 (2026-09-05, ticket convenience-features). */
export function closeSession(id: string): void {
  if (env.kind === 'app') {
    // native 가 레지스트리 제거·지속 저장 후 sessions-changed 로 알린다 (reconcile 이 정리).
    // 마지막 탭이면 native 가 이 창을 닫는다 (방송 없음 — 페이지가 통째로 사라진다)
    void tauri?.core.invoke('close_session', { id });
    return;
  }
  // 웹: 마지막 탭을 닫으면 빈 세션을 먼저 세워 활성으로 삼은 뒤 제거한다
  // (activeCtx 가 폐기된 컨텍스트를 가리키는 순간이 없게)
  if (sessions.list.length <= 1) {
    const nid = genSessionId();
    addLocal({ id: nid, name: '', root: null });
    activateSession(nid);
  }
  removeLocal(id);
}

/** 탭 추가(+) 기본 동작 — 루트 없는 빈 세션 탭 (폴더 선택 없이 빈 탭 먼저, 시작
 *  페이지에서 열기로 잇는다). 앱은 native 등록(sessions-changed 반향으로 탭 생성),
 *  웹은 로컬 추가. mock 은 탭 UI 가 없어 닿지 않는다 */
export function addEmptySession(): void {
  if (env.kind === 'app') {
    void tauri?.core.invoke('open_empty_session');
    return;
  }
  const id = genSessionId();
  addLocal({ id, name: '', root: null });
  activateSession(id);
}

/** 활성 탭이 빈 세션인가 — 시작 페이지 표시·탐색기 빈 상태·터미널 생성 차단·
 *  폴더 열기의 빈 탭 교체 판단이 공유한다 (반응형 — sessions 읽기) */
export function activeSessionEmpty(): boolean {
  const root = sessions.list.find((t) => t.id === sessions.activeId)?.root;
  return root === null || isRemoteEmpty(root ?? '');
}

/** 폴더 탐색(browseDir) 가능한 백엔드 — 활성 세션 우선, 활성이 빈 세션(무연결)이면
 *  아무 연결 세션의 것으로 위임한다. browseDir 는 절대 경로 나열이라 세션 root 와
 *  무관해 어느 연결이든 같은 결과다 (웹 = 서버 FS, 앱 = 데몬 FS). 전부 빈 세션이면
 *  null — 확정 검증이 불가하므로 호출측이 OS 다이얼로그 등으로 우회한다 */
export function browseBackend(): ThinBackend | null {
  const active = ctxs.get(sessions.activeId)?.backend;
  if (active?.browseDir) return active;
  for (const t of sessions.list) {
    const b = ctxs.get(t.id)?.backend;
    if (b?.browseDir) return b;
  }
  return null;
}

/** 세션 탭 이름 변경 (탭 더블클릭 rename) — 표시 라벨은 front 소유라 로컬만 바꾼다.
 *  앱 reconcile 은 로컬 이름을 우선하므로 native 방송에 덮이지 않는다.
 *  지속은 안 된다 — 재실행 복원 시 root basename 으로 돌아간다 (수용). */
export function renameSession(id: string, name: string): void {
  const t = sessions.list.find((x) => x.id === id);
  const trimmed = name.trim();
  if (t && trimmed) t.name = trimmed;
}

/** 세션 탭 순서 이동 (드래그) — to 는 표시 목록 기준 삽입 인덱스 (이동 중 탭 포함).
 *  앱은 순서의 단일 출처인 native 레지스트리에 위임한다 — 재배열·저장 후
 *  sessions-changed 로 되돌아오면 reconcile 이 따라간다. 웹은 로컬 목록을 직접 재배열 */
export function moveSession(id: string, to: number): void {
  if (env.kind === 'app') {
    void tauri?.core.invoke('move_session', { id, to });
    return;
  }
  const i = sessions.list.findIndex((t) => t.id === id);
  if (i === -1) return;
  const [tab] = sessions.list.splice(i, 1);
  sessions.list.splice(Math.min(to > i ? to - 1 : to, sessions.list.length), 0, tab);
}

/** 세션 id 생성 (웹 전용 — 앱은 native 레지스트리가 발급).
 *  WHY: randomUUID 는 보안 컨텍스트 전용 — IP 오리진 접속에서 죽는다. 유일성만 필요 */
export function genSessionId(): string {
  return (
    crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

/** 경로 정규화 — 꼬리 '/' 차이가 같은 워크스페이스를 다른 것으로 보이게 하지 않게 */
function normRoot(root: string): string {
  return root.replace(/\/+$/, '') || '/';
}

/** 웹 '폴더 열기' 확정 — 새 세션 탭으로 연다 (host.openFolder 가 부른다).
 *  같은 워크스페이스가 이미 열려 있으면 새 탭 대신 그 탭으로 포커스만 옮긴다.
 *  워크스페이스 정체성은 root 문자열이 전부다 — ssh://host/path 원격은 스킴·호스트가
 *  문자열에 포함돼 같은 경로라도 origin 이 다르면 별개 세션이 된다.
 *  mode 'replace': 확정 직전의 활성 탭을 새 탭으로 대체한다 (VS Code 원격의 "현재 창에 연결")
 *  — 대상이 이미 열린 탭이라 포커스만 옮긴 경우에도 이전 탭은 닫되, 이전 탭이 빈 세션(Welcome)
 *  이면 남긴다 (2026-09-05 사용자 지시 — 앱의 native 제자리 교체와 같은 의미). 'new': 활성
 *  탭이 빈 세션이어도 대체하지 않고, 새 탭은 배경에서 열려 현재 탭이 활성으로 남는다 (이미
 *  열린 대상은 포커스 이동). 생략: 활성 빈 탭만 대체. */
export type OpenMode = 'replace' | 'new';
export function openWebFolder(root: string, mode?: OpenMode): void {
  const norm = normRoot(root);
  const prevId = sessions.activeId;
  const prevEmpty = activeSessionEmpty();
  const existing = sessions.list.find((t) => t.root !== null && normRoot(t.root) === norm);
  if (existing) {
    // 이미 열린 워크스페이스 — 포커스만 이동, 활성 빈 탭이 있어도 그대로 남긴다 (앱과 동일).
    // 명시적 replace 만 이전 탭을 닫는다 — 빈 탭은 예외
    activateSession(existing.id);
    if (mode === 'replace' && existing.id !== prevId && !prevEmpty) removeLocal(prevId);
    return;
  }
  // 대체 대상: 명시적 replace, 또는 기본 모드에서 활성 탭이 빈 세션(시작 페이지에서 열기 —
  // 앱의 native replace 와 동일 의미). 새 탭이 그 탭의 자리를 차지한다
  const replaceId = mode === 'replace' || (mode === undefined && prevEmpty) ? prevId : null;
  const id = genSessionId();
  const base = root.split('/').filter((s) => s !== '').pop() ?? root;
  addLocal({ id, name: tabLabel(root, base), root });
  if (replaceId !== null) {
    const from = sessions.list.findIndex((t) => t.id === id);
    const [tab] = sessions.list.splice(from, 1);
    sessions.list.splice(sessions.list.findIndex((t) => t.id === replaceId), 0, tab);
  }
  // 'new' 는 배경에서 연다 — 현재 탭이 활성으로 남는다 (2026-09-05 사용자 지시)
  if (mode !== 'new') activateSession(id);
  if (replaceId !== null) removeLocal(replaceId);
}

/** 앱 '새 탭에 연결'(mode 'new')의 포커스 유지 — native 는 활성 탭을 모르므로 front 가
 *  "이 root 가 새로 나타나면 활성화하지 않는다"를 예약한다. reconcile 이 소비하고,
 *  대상이 이미 열려 있어 session-focus 만 오면 그때 지운다. 대조는 root 문자열(normRoot) —
 *  못 맞추면 종전대로 활성화되는 안전한 실패다 */
const backgroundRoots = new Set<string>();
export function openInBackground(root: string): void {
  backgroundRoots.add(normRoot(root));
}
export function cancelBackground(root: string): void {
  backgroundRoots.delete(normRoot(root));
}
function consumeBackground(id: string): boolean {
  const root = sessions.list.find((t) => t.id === id)?.root;
  return root != null && backgroundRoots.delete(normRoot(root));
}

/** 앱 '현재 탭 대체' 열기의 뒷정리 — open_folder_path invoke 뒤 이전 활성 탭을 닫는다
 *  (native replace 는 빈 세션만 제자리 교체하므로, 비어 있지 않은 탭은 여기서 닫는다).
 *  같은 워크스페이스 재열기(native 가 포커스 이동만 지시)면 이전 탭이 곧 대상이라
 *  닫지 않는다 — root 문자열 대조로 판정한다 (원격 ssh:// 는 정확히 같은 문자열) */
export function replaceAppSession(prevId: string, newRoot: string): void {
  const prev = sessions.list.find((t) => t.id === prevId);
  if (!prev || (prev.root !== null && normRoot(prev.root) === normRoot(newRoot))) return;
  closeSession(prevId);
}

/** native 레지스트리 목록으로 로컬 상태를 맞춘다 — 추가는 컨텍스트 생성, 제거는 폐기.
 *  새로 나타난 세션은 활성 탭이 된다 (Ctrl+O·다이얼로그·두 번째 실행 전부 "새 탭 = 활성") */
function reconcile(list: SessionTab[]): void {
  for (const t of [...sessions.list]) {
    if (!list.some((n) => n.id === t.id)) removeLocal(t.id);
  }
  let added: string | null = null;
  for (const n of list) {
    if (!ctxs.has(n.id)) {
      addLocal(n);
      added = n.id;
    }
  }
  // 순서는 native 가 단일 출처 — 이름은 로컬 갱신분(워크스페이스 정보)을 우선한다
  sessions.list = list.map((n) => {
    const prev = sessions.list.find((t) => t.id === n.id);
    return { ...n, name: prev?.name ?? n.name };
  });
  if (added && !consumeBackground(added)) activateSession(added);
}

export function initSessions(): void {
  if (env.kind !== 'app' || !tauri) return;
  void tauri.core.invoke('list_sessions').then((r) => {
    reconcile(r as SessionTab[]);
    // 분리로 생긴 새 창 — 부팅 전에 적재된 핸드오프를 가져간다
    takeHandoffs();
  });
  listenHere('sessions-changed', (e) => {
    reconcile(e.payload as SessionTab[]);
    flushPendingHandoffs();
  });
  // 이미 열린 워크스페이스를 다시 열었을 때 — native 가 새 탭 대신 포커스 이동을 지시한다
  listenHere('session-focus', (e) => {
    const id = e.payload as string;
    consumeBackground(id);
    activateSession(id);
  });
  listenHere('handoff-available', () => takeHandoffs());
  // 에디터·터미널 탭 핸드오프는 forward 로 바로 도착한다 (take_handoff 큐를 거치지 않는다)
  listenHere('tabs-handoff', (e) => applyHandoff(e.payload as Handoff));
  listenHere('session-move-request', (e) =>
    onSessionMoveRequest(e.payload as { id: string; toWindow: string; toIndex: number }),
  );
  listenHere('tabs-move-request', (e) => onTabsMoveRequest(e.payload as TabsMoveRequest));
}

// ---- 다중 창 (앱 전용)

/** 창 간 탭 이동이 가능한 환경인가 — 앱이고 창 label 이 있다 (UI 가 창 밖 드롭·메뉴를 켠다) */
export function multiWindow(): boolean {
  return env.kind === 'app' && tauri !== undefined && windowLabel !== null;
}

function invoke(cmd: string, args: Record<string, unknown>): Promise<boolean> {
  if (!tauri) return Promise.resolve(false);
  return tauri.core.invoke(cmd, args).then(
    () => true,
    (e) => {
      notify('error', `창 이동 실패: ${String(e)}`);
      return false;
    },
  );
}

function sessionHandoff(id: string): Extract<Handoff, { kind: 'session' }> | null {
  const ctx = ctxs.get(id);
  const t = sessions.list.find((x) => x.id === id);
  if (!ctx || !t) return null;
  return { kind: 'session', id, name: t.name, state: ctx.snapshot() };
}

/** 세션 탭을 창 밖에 놓음 → 그 화면 좌표에 새 창. 출처(이 창)는 sessions-changed 로 탭을 잃고
 *  연결을 닫는다 — 새 창이 같은 id 로 재-attach 해 터미널을 이어받고, 핸드오프로 나머지를 복원 */
export function detachSession(id: string, x: number, y: number): void {
  const handoff = sessionHandoff(id);
  // 화면 밖(음수) 좌표로 창이 생기지 않게 — 좌상단 근처 드롭 보정
  if (handoff) void invoke('detach_session', { id, x: Math.max(0, x), y: Math.max(0, y), handoff });
}

/** 세션 탭 우클릭 "Move to New Window" — 좌표가 없으니 이 창 근처에 */
export function detachSessionNearby(id: string): void {
  detachSession(id, window.screenX + 80, window.screenY + 80);
}

/** 대상 창의 탭 스트립 드롭 — 세션 상태는 출처 창에 있으니 이동을 요청만 한다 */
export function requestSessionMove(fromWindow: string, id: string, toIndex: number): void {
  void invoke('forward', {
    toWindow: fromWindow,
    event: 'session-move-request',
    payload: { id, toWindow: windowLabel, toIndex },
  });
}

/** 출처 창 — 요청 시점 상태를 직렬화해 이동을 확정한다. 이미 떠난 세션(창 밖 드롭이 먼저
 *  인식돼 새 창으로 갔거나 닫힘)이면 무시 */
function onSessionMoveRequest(p: { id: string; toWindow: string; toIndex: number }): void {
  const handoff = sessionHandoff(p.id);
  if (handoff) void invoke('move_session_to_window', { id: p.id, toWindow: p.toWindow, toIndex: p.toIndex, handoff });
}

/** 세션 탭 우클릭 "Move to Window …" — 그 창의 끝에 붙인다 */
export function moveSessionToWindow(id: string, toWindow: string): void {
  onSessionMoveRequest({ id, toWindow, toIndex: 1 << 30 });
}

export function listWindows(): Promise<{ label: string; title: string }[]> {
  if (!tauri) return Promise.resolve([]);
  return tauri.core.invoke('list_windows').then((r) => r as { label: string; title: string }[]);
}

/** 이동이 실패했을 때 떼어 둔 탭·터미널을 출처 세션에 되돌린다 — 핸드오프 생성은 파괴적이라
 *  (탭 제거·터미널 핸들 해제) invoke 가 거절되면 미저장 버퍼·살아 있는 PTY 가 고아가 된다 */
function undoTabsHandoff(fromSession: string, h: Extract<Handoff, { kind: 'tabs' }>, pick: TabsPick): void {
  const ctx = ctxs.get(fromSession);
  if (!ctx) return;
  for (const e of h.editors) ctx.editors.acceptTab(e, pick.editorTab?.groupId);
  // 같은 세션의 터미널 — 데몬 쪽은 그대로라 로컬 핸들만 다시 잡는다
  ctx.terminals.adoptTerminals(h.terminals);
}

type TabsPick = { editorTab?: { groupId: number; tabId: string }; terminal?: number };

/** 이 세션의 root — 에디터·터미널 탭 이동은 같은 root 사이에서만 (와이어 경로가 root 상대) */
export function sessionRoot(id: string): string | null {
  return sessions.list.find((t) => t.id === id)?.root ?? null;
}

function tabsHandoff(fromSession: string, pick: TabsPick): Extract<Handoff, { kind: 'tabs' }> | null {
  const ctx = ctxs.get(fromSession);
  if (!ctx) return null;
  const editors: TabHandoff[] = [];
  if (pick.editorTab) {
    const h = ctx.editors.takeTabForHandoff(pick.editorTab.groupId, pick.editorTab.tabId);
    if (h) editors.push(h);
  }
  const terminals: TerminalSnapshot[] = [];
  if (pick.terminal !== undefined) {
    terminals.push(...ctx.terminals.snapshot(pick.terminal));
    // 데몬 터미널은 살려 둔다 — 받는 쪽이 adoptTerminal 로 가져간다
    ctx.terminals.releaseTerminal(pick.terminal);
  }
  if (editors.length === 0 && terminals.length === 0) return null;
  return { kind: 'tabs', fromSession, editors, terminals };
}

/** 활성 세션의 에디터 탭을 창 밖에 놓음 → 같은 root 의 새 세션이 새 창에 뜨고 그 탭을 받는다 */
export function detachEditorTab(groupId: number, tabId: string, x: number, y: number): void {
  detachTabs({ editorTab: { groupId, tabId } }, x, y);
}

/** 활성 세션의 터미널(인스턴스 id)을 창 밖에 놓음 — 데몬 터미널은 새 창의 세션이 adoptTerminal 로 가져간다 */
export function detachTerminal(id: number, x: number, y: number): void {
  detachTabs({ terminal: id }, x, y);
}

function detachTabs(pick: TabsPick, x: number, y: number): void {
  const from = sessions.activeId;
  const root = sessionRoot(from);
  if (root === null || isRemoteEmpty(root)) return;
  const handoff = tabsHandoff(from, pick);
  if (!handoff) return;
  void invoke('detach_tabs', { root, x: Math.max(0, x), y: Math.max(0, y), handoff }).then((ok) => {
    if (!ok) undoTabsHandoff(from, handoff, pick);
  });
}

interface TabsMoveRequest {
  fromSession: string;
  editorTab?: { groupId: number; tabId: string };
  terminal?: number;
  toWindow: string;
  toSession: string;
  toGroupId?: number;
  toIndex?: number;
}

/** 대상 창의 탭바·터미널 영역 드롭 — 출처 창에 요청. root 일치 검사는 호출측(UI)이 드래그
 *  데이터의 root 로 미리 한다 */
export function requestTabsMove(
  fromWindow: string,
  pick: { fromSession: string; editorTab?: { groupId: number; tabId: string }; terminal?: number },
  to: { toGroupId?: number; toIndex?: number },
): void {
  const payload: TabsMoveRequest = { ...pick, toWindow: windowLabel ?? '', toSession: sessions.activeId, ...to };
  void invoke('forward', { toWindow: fromWindow, event: 'tabs-move-request', payload });
}

/** 출처 창 — 탭을 떼어 핸드오프를 만들고 살아 있는 대상 창에 바로 보낸다 (native 는 중계만) */
function onTabsMoveRequest(p: TabsMoveRequest): void {
  const handoff = tabsHandoff(p.fromSession, p);
  if (!handoff) return;
  handoff.toSession = p.toSession;
  handoff.toGroupId = p.toGroupId;
  handoff.toIndex = p.toIndex;
  void invoke('forward', { toWindow: p.toWindow, event: 'tabs-handoff', payload: handoff }).then((ok) => {
    if (!ok) undoTabsHandoff(p.fromSession, handoff, p);
  });
}

/** 세션 컨텍스트가 아직 없어(sessions-changed 가 뒤늦게 오는 경합) 미룬 핸드오프 */
const pendingHandoffs: Handoff[] = [];

function takeHandoffs(): void {
  void tauri?.core.invoke('take_handoff').then((r) => {
    for (const h of r as Handoff[]) applyHandoff(h);
  });
}

function flushPendingHandoffs(): void {
  for (const h of pendingHandoffs.splice(0)) applyHandoff(h);
  // 대상 세션이 끝내 오지 않는 핸드오프는 버린다 — 큰 페이로드를 무한히 붙들지 않게 (다음 reconcile 까지 한 번만 유예)
  if (pendingHandoffs.length > 0) {
    notify('warning', 'A tab hand-off could not be applied (target session is gone)');
    pendingHandoffs.length = 0;
  }
}

/** 도착한 핸드오프를 세션에 적용 — 세션 통째면 그 세션(같은 id, 이미 재-attach 중)에 덮어쓰고,
 *  탭 일부면 toSession(없으면 활성)에 붙인다. 대상 컨텍스트가 아직 없으면 다음 reconcile 뒤로 미룬다 */
function applyHandoff(h: Handoff): void {
  const sid = h.kind === 'session' ? h.id : h.toSession ?? sessions.activeId;
  const ctx = ctxs.get(sid);
  if (!ctx) {
    pendingHandoffs.push(h);
    return;
  }
  if (h.kind === 'session') {
    ctx.restore(h.state);
    const t = sessions.list.find((x) => x.id === h.id);
    if (t && h.name) t.name = h.name; // 사용자가 바꾼 라벨은 창을 옮겨도 유지
  } else {
    for (const e of h.editors) ctx.editors.acceptTab(e, h.toGroupId, h.toIndex);
    ctx.terminals.adoptTerminals(h.terminals, h.fromSession);
  }
  activateSession(sid);
}

/** 모든 세션의 미저장 문서 여부 — beforeunload 안전망 (배경 탭의 dirty 도 지켜야 한다) */
export function hasAnyDirty(): boolean {
  return [...ctxs.values()].some((c) => c.editors.hasDirtyDocs());
}

/** 전 세션의 터미널 목록 — TerminalPane 의 xterm 바인딩 수명 판정용 (배경 세션 것을
 *  죽이지 않기 위해 합집합이 필요하다). sessions.list 와 각 목록을 읽어 반응성이 잡힌다 */
export function allTerminals(): TerminalInstance[] {
  return sessions.list.flatMap((t) => ctxs.get(t.id)?.terminals.terminals.list ?? []);
}
