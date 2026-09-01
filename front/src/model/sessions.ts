import { reactive } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';
import { activeCtx } from './ctx';
import { createSessionCtx, type SessionCtx } from './session';
import type { TerminalInstance } from './terminal';

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
 */

export type SessionTab = { id: string; name: string; root: string };

type Tauri = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
  };
};

const tauri = (window as { __TAURI__?: Tauri }).__TAURI__;

export const sessions = reactive({ list: [] as SessionTab[], activeId: '' });

/** id → 세션 컨텍스트. 반응성 불요(외부 핸들 뭉치) — 목록 반응성은 sessions.list 가 담당 */
const ctxs = new Map<string, SessionCtx>();

interface SessionsEnv {
  kind: 'app' | 'web' | 'mock';
  /** 탭 하나의 백엔드 연결 생성 — 환경 분기는 host.ts(조립 지점)가 주입한다 */
  backendFor: (tab: { id: string; root: string }) => ThinBackend;
}
let env: SessionsEnv = { kind: 'mock', backendFor: () => { throw new Error('sessions 미구성'); } };

export function configureSessions(e: SessionsEnv): void {
  env = e;
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

function addLocal(tab: SessionTab, backend?: ThinBackend): SessionCtx {
  const ctx = createSessionCtx(backend ?? env.backendFor(tab));
  ctxs.set(tab.id, ctx);
  sessions.list.push({ ...tab });
  // 이름 채움 — 워크스페이스 정보가 오면 탭 라벨을 실제 이름으로 (부팅 주입 목록은 이미 이름이 있다)
  void ctx.init().then(() => {
    const t = sessions.list.find((x) => x.id === tab.id);
    if (t && ctx.workbench.workbench.workspaceName) t.name = ctx.workbench.workbench.workspaceName;
    if (t && !t.root && ctx.workbench.workbench.rootPath) t.root = ctx.workbench.workbench.rootPath;
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
  if (idx !== -1) sessions.list.splice(idx, 1);
  (ctx.backend as { dispose?: () => void }).dispose?.();
}

/** 부팅 세션 등록 (host.ts 조립 시점) — 마지막으로 등록된 것이 활성이 된다 */
export function bootSession(tab: SessionTab, backend: ThinBackend): void {
  addLocal(tab, backend);
  sessions.activeId = tab.id;
  activeCtx.value = ctxs.get(tab.id)!;
}

/** 부팅 세션들의 초기 로드 완료 대기 — main.ts 가 마운트 전에 기다린다 (빈 셸 깜빡임 방지) */
export function bootReady(): Promise<void> {
  return Promise.all([...ctxs.values()].map((c) => c.init())).then(() => {});
}

/** 세션 탭 순환 (Ctrl+Alt+Tab) — 활성 탭의 이웃으로 wrap 이동 */
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

/** 탭 닫기 = 세션 종료(kill 의미) — 연결을 끊으면 데몬이 grace 후 터미널을 회수한다 */
export function closeSession(id: string): void {
  if (env.kind === 'app') {
    // native 가 레지스트리 제거·지속 저장 후 sessions-changed 로 알린다 (reconcile 이 정리).
    // 마지막 탭 닫기 = 앱 종료 (native 판단)
    void tauri?.core.invoke('close_session', { id });
    return;
  }
  if (sessions.list.length <= 1) return; // 웹: 마지막 탭은 닫을 수 없다 (페이지가 곧 앱)
  removeLocal(id);
}

/** 탭 추가(+) — 앱은 OS 폴더 다이얼로그, 웹은 폴더 퀵인풋 (확정은 host.openFolder 경유) */
export function addSession(openFolderPicker: () => void): void {
  if (env.kind === 'app') {
    void tauri?.core.invoke('open_folder');
    return;
  }
  openFolderPicker();
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
 *  워크스페이스 정체성은 지금은 경로가 전부지만, ssh 등 원격 세션이 붙으면
 *  (origin, path) 쌍으로 확장한다 — 같은 경로라도 origin 이 다르면 별개 세션이다. */
export function openWebFolder(root: string): void {
  const norm = normRoot(root);
  const existing = sessions.list.find((t) => normRoot(t.root) === norm);
  if (existing) {
    activateSession(existing.id);
    return;
  }
  const id = genSessionId();
  const name = root.split('/').filter((s) => s !== '').pop() ?? root;
  addLocal({ id, name, root });
  activateSession(id);
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
  if (added) activateSession(added);
}

export function initSessions(): void {
  if (env.kind !== 'app' || !tauri) return;
  void tauri.core.invoke('list_sessions').then((r) => reconcile(r as SessionTab[]));
  void tauri.event.listen('sessions-changed', (e) => reconcile(e.payload as SessionTab[]));
  // 이미 열린 워크스페이스를 다시 열었을 때 — native 가 새 탭 대신 포커스 이동을 지시한다
  void tauri.event.listen('session-focus', (e) => activateSession(e.payload as string));
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
