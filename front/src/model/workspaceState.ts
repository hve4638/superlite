import { effect, stop, type ReactiveEffectRunner } from '@vue/reactivity';
import type { CardSet, EditorGroup, LayoutNode } from './editors';
import { notify } from './notifications';
import type { SessionCtx } from './session';
import { tauri } from './tauri';
import { fontZoom, type FontZoom } from './terminal';

/**
 * 워크스페이스별 상태 기억 (ticket workspace-state-restore) — 같은 root 를 다시 열면 그 아래에서
 * 열었던 탭·그룹 배치·펼친 폴더·커서·터미널을 복원한다. "어느 폴더를 열지" 는 여전히 사용자가
 * 고른다 (app-empty-session 결정과 다르지 않다) — 고른 폴더 안의 상태만 기억한다.
 *
 * 저장소 (decision/state-persistence.md): 앱은 native state.json 의 workspaces (root 키, native 소유 —
 * 여기는 get/set_workspace_state invoke 만, root 는 native 가 세션 id 로 안다), 웹은 localStorage
 * 'superlite.state'.workspaces[root] (recents.ts 와 같은 키 — 서로의 필드를 보존하며 저장한다). 같은 root 의 두 번째 세션(탭 분리 detach_tabs)은 native 가
 * get/set 을 거절한다 — 첫 세션만 저장·복원한다.
 *
 * 저장 시점: 탭·그룹·배치·펼침이 바뀌면 1초 디바운스, 세션 닫기·창 닫기는 flush 로 즉시. 커서·스크롤
 * (viewStates)은 트리거가 아니고 저장할 때 함께 실린다. 문서 내용(dirty 버퍼)은 싣지 않는다.
 *
 * 보조창(서브 창, 에디터·터미널 탭 분리로 생긴 창 — window-detach-polish)도 보존한다 (2026-09-08 사용자
 * 결정): 서브 창은 자기 미러 세션의 같은 형식 스냅샷을 set_workspace_sub_state 로 보내고 native 가 창
 * 위치·크기를 붙여 그 root 아래 subs 로 모은다. 메인이 복원할 때 native 가 subs 를 넘겨주며 비우고, 메인은
 * detach_tabs 경로로 서브 창을 그 자리에 다시 만들어 'restore' 핸드오프로 채운다. 세션 닫기(회수)는 서브
 * 상태를 남기고, 서브 창 X·마지막 탭 이탈은 그 서브를 잊는다(null 저장).
 */

/** 저장 형식 — editors.snapshot 의 구조 부분(docs 제외) + 펼침 + 뷰 상태 + 터미널 자리.
 *  터미널 탭은 groups 에서 빼고 tmux 세션 id 로 기록한다 (인스턴스 id 는 창마다 다르다) */
export interface WorkspaceState {
  version: 1;
  groups: EditorGroup[];
  layout: LayoutNode;
  activeGroupId: number;
  nextGroupId: number;
  expanded: string[];
  views: [string, unknown][];
  /** active: 저장 시점에 그 그룹의 활성 탭이 이 터미널이었다 (groups 의 activeTabId 는 문서 탭으로 대체돼 있다) */
  terminals: {
    tmux: string; groupId: number; index: number; active?: boolean;
    /** 카드였으면 붙어 있던 탭 — host 는 탭 id, 그 탭이 터미널이면 hostTmux (ticket terminal-tab-panes) */
    host?: string; hostTmux?: string;
    /** 터미널 탭에 붙어 있던 터미널 아닌 카드들 */
    cards?: CardSet;
  }[];
}

const DEBOUNCE_MS = 1000;
const WEB_KEY = 'superlite.state';

export type StoreKind = 'app' | 'web' | 'mock';

/** 보조창의 스냅샷 — 창 단위 배율(편집기·터미널, ticket zoom-per-window)을 함께 싣는다. 메인 창 몫(root 별)엔
 *  없다 — 메인의 배율은 창 저장소(editors.loadWindowZoom)가 기억한다 */
type SubSnapshot = WorkspaceState & { fontZoom?: FontZoom };

/** 보조창 하나의 저장 — 스냅샷 + 창 위치·크기(논리 px)·웹뷰 줌 레벨(zoom, native 가 저장 시점에 읽는다) */
export type SubWorkspaceState = SubSnapshot & { x: number; y: number; w: number; h: number; zoom?: number };

function serialize(ctx: SessionCtx, sub: boolean): SubSnapshot {
  const s = ctx.editors.snapshot();
  const terminals: WorkspaceState['terminals'] = [];
  for (const g of s.groups) {
    // 그룹의 터미널 탭과 탭에 붙은 터미널 카드 모두 tmux 세션 id 로 바꿔 싣는다. 카드는 host(탭 id) — 그 탭이 터미널이면
    // hostTmux(재시작 후 인스턴스 id 는 무의미). 터미널 탭의 터미널 아닌 카드는 탭이 걷히므로 항목의 cards 에 싣는다
    const tmuxOf = (term: number) => ctx.terminals.terminals.list.find((x) => x.id === term)?.tmux?.id;
    for (const t of g.tabs) {
      if (!t.cards) continue;
      const hostRef = t.kind === 'terminal' ? { hostTmux: tmuxOf(t.term) } : { host: t.id };
      t.cards.tabs.forEach((c, index) => {
        if (c.kind !== 'terminal') return;
        const tmux = tmuxOf(c.term);
        if (tmux) terminals.push({ tmux, groupId: g.id, index, ...(t.cards!.activeTabId === c.id ? { active: true } : {}), ...hostRef });
      });
      t.cards.tabs = t.cards.tabs.filter((c) => c.kind !== 'terminal');
      if (t.cards.tabs.length === 0) delete t.cards;
      else if (t.cards.activeTabId !== null && !t.cards.tabs.some((c) => c.id === t.cards!.activeTabId)) t.cards.activeTabId = null;
    }
    g.tabs.forEach((t, index) => {
      if (t.kind !== 'terminal') return;
      const tmux = tmuxOf(t.term);
      if (tmux) terminals.push({ tmux, groupId: g.id, index, ...(g.activeTabId === t.id ? { active: true } : {}), ...(t.cards ? { cards: t.cards } : {}) });
    });
    g.tabs = g.tabs.filter((t) => t.kind !== 'terminal');
    if (g.activeTabId !== null && !g.tabs.some((t) => t.id === g.activeTabId)) g.activeTabId = g.tabs[0]?.id ?? null;
    // MRU 도 터미널 id 를 뺀다 — 인스턴스 id 는 창마다 달라 복원 때 의미가 없다 (ticket tab-open-next-mru-close)
    g.mru = g.mru?.filter((id) => g.tabs.some((t) => t.id === id));
  }
  const open = new Set([
    ...s.groups.flatMap((g) => g.tabs.flatMap((t) => [t.path, ...(t.cards?.tabs.map((c) => c.path) ?? [])])),
    ...terminals.flatMap((t) => t.cards?.tabs.map((c) => c.path) ?? []),
  ]);
  return {
    version: 1,
    groups: s.groups,
    layout: s.layout,
    activeGroupId: s.activeGroupId,
    nextGroupId: s.nextGroupId,
    expanded: [...ctx.files.files.expanded],
    views: [...ctx.editors.editors.viewStates].filter(([p]) => open.has(p)),
    terminals,
    ...(sub ? { fontZoom: fontZoom() } : {}),
  };
}

// ---- 저장소

type WebState = { version: number; workspaces?: Record<string, WorkspaceState> };

function loadWebAll(): WebState {
  try {
    const p = JSON.parse(localStorage.getItem(WEB_KEY) ?? '') as WebState;
    if (p.version === 2) return p;
  } catch {
    // 없음·파싱 실패
  }
  return { version: 2 };
}

type Loaded = { state: WorkspaceState | null; subs: SubWorkspaceState[] };

function valid(s: unknown): WorkspaceState | null {
  const st = s as WorkspaceState | null | undefined;
  return st && st.version === 1 ? st : null;
}

/** 앱은 native 가 {state, subs} 를 주고 subs 는 넘기면서 비운다 (살아 있는 서브 창만 다시 저장하도록).
 *  웹은 서브 창이 없다 */
async function load(kind: StoreKind, id: string, root: string): Promise<Loaded> {
  if (kind === 'app') {
    const r = (await tauri?.core.invoke('get_workspace_state', { id })) as { state?: unknown; subs?: unknown[] } | null;
    return { state: valid(r?.state), subs: ((r?.subs ?? []) as SubWorkspaceState[]).filter((x) => valid(x) !== null) };
  }
  if (kind === 'web') return { state: valid(loadWebAll().workspaces?.[root]), subs: [] };
  return { state: null, subs: [] };
}

/** sub: 서브 창의 미러 세션 id — 그 창의 몫으로 저장된다. null 스냅샷은 그 서브를 잊는 것 */
function persist(kind: StoreKind, id: string, root: string, s: SubSnapshot | null, sub?: string): Promise<void> {
  if (kind === 'app') {
    const call = sub
      ? tauri?.core.invoke('set_workspace_sub_state', { id: sub, snapshot: s })
      : s && tauri?.core.invoke('set_workspace_state', { id, snapshot: s });
    return call ? call.then(() => undefined) : Promise.resolve();
  }
  if (kind === 'web' && s) {
    const all = loadWebAll();
    all.workspaces = { ...all.workspaces, [root]: s };
    localStorage.setItem(WEB_KEY, JSON.stringify(all));
  }
  return Promise.resolve();
}

// ---- 복원

/** 세션 초기 로드 뒤 한 번 — 껍데기 탭·배치를 먼저 세우고(즉시 보임) 문서·펼침·터미널은 이어서 채운다.
 *  저장된 것이 없으면 아무것도 하지 않는다. 실패는 알림으로만 (복원이 세션을 막으면 안 된다) */
export async function restoreWorkspace(kind: StoreKind, id: string, root: string, ctx: SessionCtx): Promise<void> {
  let loaded: Loaded;
  try {
    loaded = await load(kind, id, root);
  } catch {
    return;
  }
  const s = loaded.state;
  // 창 이동 핸드오프(세션 통째)가 먼저 도착해 이미 탭이 있으면 그쪽이 진실 — 덮지 않는다
  if (ctx.editors.editors.groups.some((g) => g.tabs.length > 0)) return;
  const tasks: Promise<unknown>[] = [];
  if (s && s.groups.length > 0) tasks.push(applyWorkspaceState(ctx, s));
  // 보조창 — 저장된 자리·크기에 서브 창을 만들고 'restore' 핸드오프로 채운다 (sessions.applyHandoff).
  // fromSession 은 이 세션(원본) — native 가 미러 세션을 만들고 toSession 을 채운다
  for (const sub of loaded.subs) {
    const { x, y, w, h, zoom, fontZoom: fz, ...state } = sub;
    tasks.push(
      tauri?.core.invoke('detach_tabs', { root, x, y, size: [w, h], zoom, handoff: { kind: 'restore', fromSession: id, state, fontZoom: fz } })
        .catch((e: unknown) => notify('warning', `Could not restore a detached window: ${String(e)}`)) ?? Promise.resolve(),
    );
  }
  await Promise.allSettled(tasks);
}

/** 서브 창 자신의 몫 복원 (서브 창 새로고침) — 같은 label 로 저장된 것이 있으면 적용한다. 새로 만든 서브
 *  창은 저장이 없어 무동작이고 핸드오프('tabs'·'restore')가 채운다. 웹·mock 은 서브 창이 없다 */
export async function restoreSubWorkspace(kind: StoreKind, mirror: string, ctx: SessionCtx): Promise<void> {
  if (kind !== 'app') return;
  let s: WorkspaceState | null = null;
  try {
    s = valid(await tauri?.core.invoke('get_workspace_sub_state', { id: mirror }));
  } catch {
    return;
  }
  if (!s || ctx.editors.editors.groups.some((g) => g.tabs.length > 0)) return;
  await applyWorkspaceState(ctx, s);
}

/** 스냅샷 하나를 세션에 적용 — 껍데기 탭·배치를 먼저 세우고(즉시 보임) 문서·펼침·터미널은 이어서 채운다.
 *  메인 창(restoreWorkspace)과 서브 창('restore' 핸드오프)이 공유한다 */
export async function applyWorkspaceState(ctx: SessionCtx, s: WorkspaceState): Promise<void> {
  // 저장 시점의 탭별 활성 카드 (null = 탭 자신) — restore 가 s.groups 객체를 그대로 편집기 상태로 쓰므로 그 뒤엔 읽을 수 없다
  const savedCardActive = new Map(s.groups.flatMap((g) => g.tabs.map((t) => [`${g.id}:${t.id}`, t.cards?.activeTabId ?? null] as const)));
  // 터미널만 있던 pane 은 터미널을 뺀 빈 그룹으로 저장돼 있다 — restore 는 원래 빈 그룹을 남기므로 그 자리에 다시 붙인다
  ctx.editors.restore({ groups: s.groups, layout: s.layout, activeGroupId: s.activeGroupId, nextGroupId: s.nextGroupId, docs: [] });
  for (const [p, v] of s.views) ctx.editors.editors.viewStates.set(p, v);
  const tasks: Promise<unknown>[] = [ctx.files.expandPaths(s.expanded)];
  const termGroups = new Set(s.terminals.map((t) => t.groupId));
  if (s.terminals.length > 0) {
    const wanted = s.terminals.map((t) => t.tmux);
    tasks.push(ctx.terminals.listTerminalsFor().then((list) => {
      const ed = ctx.editors.editors;
      const active = ed.activeGroupId;
      const termActive = new Set<number>();
      // 탭(카드 아닌 것)을 먼저 붙여 tmux id → 새 탭 id 대응을 만들고, 카드였던 것을 그 탭(hostTmux)·host 탭의 카드로
      const tabIdByTmux = new Map<string, string>();
      const isCard = (t: WorkspaceState['terminals'][number]) => t.host !== undefined || t.hostTmux !== undefined;
      for (const t of [...s.terminals.filter((t) => !isCard(t)), ...s.terminals.filter(isCard)]) {
        const info = list.find((i) => i.id === t.tmux);
        if (!info) continue;
        const host = t.host ?? (t.hostTmux !== undefined ? tabIdByTmux.get(t.hostTmux) : undefined);
        // newTab 없음 — 창 이동 핸드오프가 같은 tmux 세션을 먼저 붙였으면 중복 탭 대신 그 탭으로
        const inst = ctx.terminals.attachTerminal(info, { at: { groupId: t.groupId, index: t.index, host } });
        if (!inst) continue;
        if (!isCard(t)) {
          tabIdByTmux.set(t.tmux, `terminal:${inst.id}`);
          if (t.cards) ctx.editors.attachCards(`terminal:${inst.id}`, t.cards);
        }
        if (t.active && !isCard(t)) termActive.add(t.groupId);
      }
      // 터미널 탭의 카드 목록 — 터미널 카드가 활성이 아니었으면 저장된 활성 카드(null = 탭 자신)로 되돌린다
      for (const t of s.terminals) {
        if (isCard(t)) continue;
        const tab = ed.groups.flatMap((g) => g.tabs).find((x) => x.id === tabIdByTmux.get(t.tmux));
        if (!tab?.cards || s.terminals.some((e) => e.hostTmux === t.tmux && e.active)) continue;
        tab.cards.activeTabId = t.cards?.activeTabId ?? null;
      }
      // 터미널 탭 열기는 그 탭·그룹을 활성으로 만든다 — 저장 시점에 터미널이 활성이 아니었던 그룹은 저장된
      // 활성 탭으로, 활성 그룹도 저장된 것으로 되돌린다
      for (const sg of s.groups) {
        const g = ed.groups.find((x) => x.id === sg.id);
        if (g && !termActive.has(g.id) && sg.activeTabId !== null && g.tabs.some((t) => t.id === sg.activeTabId)) ctx.editors.setActiveTab(g.id, sg.activeTabId);
        // 카드 목록도 같은 되돌림 — 터미널 카드가 활성이 아니었던 탭은 저장된 활성 카드(없으면 null = 탭 자신)로
        for (const t of g?.tabs ?? []) {
          // 터미널 탭은 위의 터미널 루프가 되돌렸다 (저장본 s.groups 에 없다)
          if (t.kind === 'terminal' || !t.cards || s.terminals.some((e) => e.host === t.id && e.active)) continue;
          const want = savedCardActive.get(`${g!.id}:${t.id}`) ?? null;
          if (want === null || t.cards.tabs.some((c) => c.id === want)) t.cards.activeTabId = want;
        }
      }
      if (ed.groups.some((g) => g.id === active)) ed.activeGroupId = active;
      // 목록에 없는 세션은 사유가 보이게 (간헐적 미복원의 단서 — ticket term-layout-restore-flaky): 저장 id·
      // 살아 있는 id·데몬 방식을 알림 한 줄에. 재부팅 뒤처럼 전부 죽은 경우도 한 번은 알린다
      const missing = wanted.filter((id) => !list.some((i) => i.id === id));
      if (missing.length > 0) {
        const mode = ctx.terminals.state.mode;
        const alive = list.map((i) => i.id).join(', ') || 'none';
        notify('warning', `Could not restore ${missing.length} terminal tab(s): tmux session ${missing.join(', ')} not found (alive: ${alive}${mode === 'tmux' ? '' : `; terminal mode ${mode}`})`);
      }
      // 터미널이 죽어(kill·재부팅) 끝내 비어 있는 pane 은 접는다 — 저장 시점부터 비어 있던 그룹은 그대로
      for (const gid of termGroups) ctx.editors.closeEmptyGroup(gid);
    }, (e: unknown) => {
      // 조회 자체가 끝내 실패 — 죽은 것으로 단정하지 않는다: 빈 pane 은 남겨 두고(사이드바에서 다시 붙일 수
      // 있다) 사유를 알린다. 종전엔 실패가 빈 목록으로 삼켜져 조용히 접혔고 다음 저장이 터미널 자리를 잃었다
      notify('warning', `Could not list terminals, ${s.terminals.length} saved terminal tab(s) not restored: ${String(e)}`);
    }));
  }
  tasks.push(ctx.editors.hydrate().then((failed) => {
    if (failed.length > 0) notify('warning', `Skipped ${failed.length} missing file(s): ${failed.join(', ')}`);
  }));
  await Promise.allSettled(tasks);
}

// ---- 추적·저장

interface Tracked {
  /** effect 러너 — 등록 직후 effect 생성 전까지만 null */
  runner: ReactiveEffectRunner | null;
  timer: ReturnType<typeof setTimeout> | null;
  save: () => Promise<void>;
  /** 서브 창 전용 — 이 서브의 저장을 지운다 (X·마지막 탭 이탈) */
  forget: () => Promise<void>;
}
const tracked = new Map<string, Tracked>();

/** 복원이 끝난 세션의 변경을 따라가며 저장한다 — 구조(탭·그룹·배치·펼침, 서브 창은 배율도) 변경만 트리거 (effect 가
 *  직렬화 중 읽은 반응형 값을 추적한다), 첫 실행은 저장하지 않는다 (복원 직후 같은 내용) */
export function trackWorkspace(kind: StoreKind, id: string, root: string, ctx: SessionCtx, sub?: string): void {
  if (kind === 'mock' || tracked.has(id)) return;
  let last = '';
  const save = async () => {
    const t = tracked.get(id);
    if (t?.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    const s = serialize(ctx, sub !== undefined);
    const json = JSON.stringify({ ...s, views: undefined });
    last = json;
    // 탭이 하나도 없는 서브 창은 기억할 것이 없다 — null 로 잊는다 (마지막 탭이 메인으로 돌아간 경우)
    const empty = s.groups.every((g) => g.tabs.length === 0) && s.terminals.length === 0;
    try {
      await persist(kind, id, root, sub && empty ? null : s, sub);
    } catch {
      // 거절(두 번째 세션)·쓰기 실패 — 조용히 (다음 변경에 다시 시도)
    }
  };
  // 메인은 복원 직후라 첫 실행을 건너뛴다. 서브 창은 추적이 시작될 때(연결 초기 로드 뒤) 넘어온 탭이 이미
  // 들어와 있고 아직 한 번도 저장된 적이 없다 — 첫 실행부터 저장한다
  let first = !sub;
  // WHY: effect 는 만들면서 동기로 첫 실행된다 — 항목을 먼저 등록해야 첫 실행이 타이머를 걸 수 있다
  const entry: Tracked = { runner: null, timer: null, save, forget: () => persist(kind, id, root, null, sub) };
  tracked.set(id, entry);
  entry.runner = effect(() => {
    const json = JSON.stringify({ ...serialize(ctx, sub !== undefined), views: undefined });
    if (first) {
      first = false;
      last = json;
      return;
    }
    if (json === last) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void save(), DEBOUNCE_MS);
  });
}

/** 세션이 닫힐 때 — 마지막 상태를 즉시 저장하고 추적을 멈춘다 (앱은 native 의 close_session 보다 먼저
 *  도달해야 하므로 호출측이 await 한다). 추적 중이 아니면 무동작 */
export async function flushWorkspace(id: string): Promise<void> {
  const t = tracked.get(id);
  if (!t) return;
  tracked.delete(id);
  if (t.runner) stop(t.runner);
  if (t.timer) clearTimeout(t.timer);
  await t.save();
}

/** 추적만 멈춘다 (저장 없음) — 세션이 다른 창으로 옮겨 가거나 native 가 닫은 경우 */
export function untrackWorkspace(id: string): void {
  const t = tracked.get(id);
  if (!t) return;
  tracked.delete(id);
  if (t.runner) stop(t.runner);
  if (t.timer) clearTimeout(t.timer);
}

/** 서브 창을 잊는다 — 추적을 멈추고 저장을 지운다 (서브 창 X·마지막 탭이 메인으로 돌아감). 세션 닫기의
 *  회수는 여기가 아니라 untrackWorkspace 다 (저장을 남겨 다음 열기에 서브 창이 되살아난다) */
export async function forgetWorkspace(id: string): Promise<void> {
  const t = tracked.get(id);
  if (!t) return;
  tracked.delete(id);
  if (t.runner) stop(t.runner);
  if (t.timer) clearTimeout(t.timer);
  try {
    await t.forget();
  } catch {
    // 거절·실패 — 조용히
  }
}

/** 창 닫기 전 — 이 창의 모든 세션을 저장한다 (추적은 유지 — 닫기가 취소될 수 있다) */
export function flushAllWorkspaces(): Promise<unknown> {
  return Promise.allSettled([...tracked.values()].map((t) => t.save()));
}
