/**
 * 에이전트·터미널 상태 (ticket agent-hooks-status) — 두 층.
 *
 * 뼈대: 에이전트 훅 → `superlite agent-event` → 데몬(tmux 세션 id 별 캐시) → termAgent 방송 → 여기의 상태 기계.
 *   단위는 탭이 아니라 tmux 세션 id — 같은 세션을 보는 모든 탭·카드·사이드바 행이 같은 값을 그린다.
 *   어휘 unknown / running / needsInput / idle / exited (cmux 와 같다). 표시는 배지(점)뿐 — 토스트 없음 (2026-09-14).
 *   idle 은 "봤는가" 로 갈린다 (사용자 결정 2026-09-14): Stop 이 왔는데 아직 그 터미널을 보거나 입력하지 않았으면
 *   stopped(초록), 봤으면 idle(회색). running·needsInput 이 30분 넘게 갱신되지 않으면 unknown
 *   (orca 의 stale). 3초 목록 폴링의 pane_current_command 가 셸이면 exited 로 정정 (cmux 의 프로세스 교차검증 —
 *   훅 없이 죽은 에이전트의 유령 상태).
 * 바닥(agent-status-baseline 합침): 훅 없는 CLI 용 프론트 신호 — 보이지 않는 터미널에 출력이 오면 활동 점, BEL
 *   이 오면 벨 배지 (토스트 없음). tmux 를 통과하는 유일한 시퀀스가 BEL 이라 Codex 의 완료·승인 알림이 여기로 온다.
 *
 * 플러그인 구독 표면(ticket plugin-architecture)은 데몬 와이어가 아니라 이 모듈의 상태 변경 — onAgentChange.
 */
import { reactive, shallowReactive, watch } from '@vue/reactivity';
import type { AgentState, AgentStatus, TerminalInfo, ThinBackend } from '../backend/types';
import { ctx } from './ctx';
import { confirm } from './dialog';
import type { createEditors, Tab } from './editors';
import { errText, notify } from './notifications';
import type { TerminalInstance } from './terminal';

/** running·needsInput 이 이보다 오래 갱신되지 않으면 unknown — orca AGENT_STATUS_STALE_AFTER_MS 와 같은 30분 */
const STALE_MS = 30 * 60_000;
/** pane_current_command 가 이것이면 에이전트가 셸로 돌아온 것 — running·needsInput·idle 을 exited 로 */
const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);

export type AgentChange = { tmuxId: string; status: AgentStatus; prev: AgentStatus | null };

/** 상태 점의 색 (사용자 결정 2026-09-14): blue = running, yellow = needsInput, green = stopped(응답 마침, 아직 안 봄),
 *  gray = idle(봄), red = 닫기 요청(`superlite card close`). exited·unknown 은 점 없음. 점 하나(a) 또는 30도 경계로 반
 *  갈린 둘(a/b) */
export type DotColor = 'yellow' | 'green' | 'red' | 'blue' | 'gray';
export type DotSpec = { a: DotColor; b?: DotColor };

/** 세션 하나의 에이전트 상태 모듈 — createTerminals 가 만든다. terminals.list 는 그 세션의 인스턴스 목록 */
export function createAgentStatus(
  backend: ThinBackend,
  editorsM: ReturnType<typeof createEditors>,
  terminals: { list: TerminalInstance[] },
  closeRequested: () => Map<string, string>,
) {
  /** tmux 세션 id → 마지막 상태 */
  const agents = shallowReactive(new Map<string, AgentStatus>());
  /** idle 중 사용자가 본(보이는 채로 Stop 을 받았거나, 그 뒤 보거나 입력한) 세션 — 초록(stopped) ↔ 회색(idle) */
  const seen = reactive(new Set<string>());
  const listeners = new Set<(c: AgentChange) => void>();
  const self = {
    agents, onAgentChange, stateOf, statusOf, noteOutput, noteBell, noteInput, reconcile, installHooks,
    dotOfTmux, dotOfInstance, dotOfTab, dotOfSession,
  };

  /** 이 모듈이 활성 세션의 것이고 창이 포커스돼 있으며 그 터미널이 지금 보이는가 — 바닥 신호(활동·벨) 판정 조건 */
  function watched(instId: number): boolean {
    return document.hasFocus() && isActiveSession() && visibleInstances().includes(instId);
  }
  function isActiveSession(): boolean {
    try {
      return ctx().terminals.agent === self;
    } catch {
      return false;
    }
  }
  /** 이 창에서 본문에 보이는 터미널 인스턴스 id 들 — 그룹마다 활성 탭(카드가 있으면 활성 카드) */
  function visibleInstances(): number[] {
    const out: number[] = [];
    for (const g of editorsM.editors.groups) {
      const t = g.tabs.find((t) => t.id === g.activeTabId);
      if (!t) continue;
      const leaf = t.cards && t.cards.activeTabId !== null ? t.cards.tabs.find((c) => c.id === t.cards!.activeTabId) ?? t : t;
      if (leaf.kind === 'terminal') out.push(leaf.term);
    }
    return out;
  }

  function onAgentChange(cb: (c: AgentChange) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function stateOf(tmuxId: string | undefined): AgentState | null {
    return tmuxId === undefined ? null : (agents.get(tmuxId)?.state ?? null);
  }
  function statusOf(tmuxId: string | undefined): AgentStatus | null {
    return tmuxId === undefined ? null : (agents.get(tmuxId) ?? null);
  }

  // ---- 점 (사용자 결정 2026-09-14). 터미널 하나(카드 행·사이드바 행)는 온전한 점 — 닫기 요청이면 빨강 우선, 아니면
  //      상태색(파랑·회색 포함). 탭·세션 요약은 노랑/초록만 모은다 — 둘 다면 반반, 하나면 단색, 둘 다 없고 닫기 요청이
  //      있으면 빨강 단색(급하지 않아 섞지 않는다), 그 밖(running·idle·exited 만)은 점 없음
  function colorOf(tmuxId: string): DotColor | null {
    switch (agents.get(tmuxId)?.state) {
      case 'needsInput': return 'yellow';
      case 'idle': return seen.has(tmuxId) ? 'gray' : 'green';
      case 'running': return 'blue';
      default: return null;
    }
  }
  function dotOfTmux(tmuxId: string): DotSpec | null {
    if (closeRequested().has(tmuxId)) return { a: 'red' };
    const c = colorOf(tmuxId);
    return c ? { a: c } : null;
  }
  function dotOfInstance(instId: number): DotSpec | null {
    const t = terminals.list.find((t) => t.id === instId);
    return t?.tmux ? dotOfTmux(t.tmux.id) : null;
  }
  function summary(tmuxIds: string[]): DotSpec | null {
    let yellow = false, green = false, red = false;
    for (const id of tmuxIds) {
      if (closeRequested().has(id)) red = true;
      const c = colorOf(id);
      if (c === 'yellow') yellow = true;
      else if (c === 'green') green = true;
    }
    if (yellow && green) return { a: 'yellow', b: 'green' };
    if (yellow) return { a: 'yellow' };
    if (green) return { a: 'green' };
    return red ? { a: 'red' } : null;
  }
  /** 탭의 터미널들 — 탭 자신(터미널 탭이면)과 붙은 터미널 카드 */
  function tmuxOfTab(tab: Tab): string[] {
    const ids = [...(tab.kind === 'terminal' ? [tab.term] : []), ...(tab.cards?.tabs ?? []).flatMap((c) => (c.kind === 'terminal' ? [c.term] : []))];
    return ids.flatMap((id) => { const t = terminals.list.find((t) => t.id === id); return t?.tmux ? [t.tmux.id] : []; });
  }
  function dotOfTab(tab: Tab): DotSpec | null {
    return summary(tmuxOfTab(tab));
  }
  /** 세션 탭 요약 — 이 세션의 모든 터미널 */
  function dotOfSession(): DotSpec | null {
    return summary(terminals.list.flatMap((t) => (t.tmux ? [t.tmux.id] : [])));
  }

  /** 상태 반영 — 배지가 반응적으로 따라가고 구독자에게 알린다 (토스트 없음 — 사용자 지시 2026-09-14). idle 로 들어올 때
   *  그 터미널을 보고 있었으면 곧바로 본 것(회색), 아니면 stopped(초록). 다른 상태는 seen 을 지운다 */
  function apply(tmuxId: string, status: AgentStatus): void {
    const prev = agents.get(tmuxId) ?? null;
    agents.set(tmuxId, status);
    if (status.state === 'idle') {
      if (prev?.state !== 'idle') {
        if (instancesOf(tmuxId).some((i) => watched(i.id))) seen.add(tmuxId);
        else seen.delete(tmuxId);
      }
    } else {
      seen.delete(tmuxId);
    }
    for (const cb of listeners) cb({ tmuxId, status, prev });
  }
  function instancesOf(tmuxId: string): TerminalInstance[] {
    return terminals.list.filter((t) => t.tmux?.id === tmuxId);
  }

  backend.onTermAgent?.((tmuxId, status) => apply(tmuxId, status));

  /** 목록 폴링과 대조 — 데몬 캐시가 더 새 값이면 받고(늦게 붙은 창·재접속), 전면 명령이 셸이면 exited 로 정정 */
  function reconcile(list: TerminalInfo[]): void {
    for (const it of list) {
      const local = agents.get(it.id);
      if (it.agent && (!local || it.agent.at > local.at)) apply(it.id, it.agent);
      const cur = agents.get(it.id);
      if (cur && cur.state !== 'exited' && cur.state !== 'unknown' && SHELLS.has(it.command)) {
        apply(it.id, { ...cur, state: 'exited', at: Date.now() });
      }
    }
  }

  // stale — 훅이 끊긴 채 남은 running·needsInput 을 unknown 으로 (1분마다 검사)
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of agents) {
      if ((s.state === 'running' || s.state === 'needsInput') && now - s.at > STALE_MS) apply(id, { ...s, state: 'unknown' });
    }
  }, 60_000);

  // ---- 바닥: 활동 점·벨 (인스턴스 단위 — xterm 사건은 데몬을 거치지 않는다)
  function noteOutput(inst: TerminalInstance): void {
    if (!inst.activity && !watched(inst.id)) inst.activity = true;
  }
  function noteBell(inst: TerminalInstance): void {
    if (!watched(inst.id)) inst.bell = true;
  }
  /** 입력 = 사용자가 보고 있다 — 이 인스턴스의 점·벨을 지우고 그 세션의 stopped 를 idle(회색)로 */
  function noteInput(inst: TerminalInstance, data: string): void {
    markSeen(inst);
    // WHY: 질문·권한 창을 Esc 로 취소하면 Claude Code 는 어떤 훅도 보내지 않는다 (2.1.270 실측 — Stop·PostToolUseFailure·
    //      idle_prompt 모두 없음). needsInput 중 단독 Esc 입력을 취소로 보고 idle(본 것)로 내린다.
    // ponytail: 이 창에서만 반영된다. 다른 창·데몬 캐시는 다음 훅까지 needsInput
    const tmuxId = inst.tmux?.id;
    const cur = tmuxId === undefined ? undefined : agents.get(tmuxId);
    if (data === '\x1b' && tmuxId !== undefined && cur?.state === 'needsInput') {
      apply(tmuxId, { ...cur, state: 'idle', at: Date.now() });
      seen.add(tmuxId);
    }
  }
  function markSeen(inst: TerminalInstance): void {
    inst.activity = false;
    inst.bell = false;
    if (inst.tmux) seen.add(inst.tmux.id);
  }
  /** 보이는 터미널이 바뀌거나 창이 포커스를 받으면 그 터미널은 본 것 */
  function seenVisible(): void {
    if (!document.hasFocus() || !isActiveSession()) return;
    for (const id of visibleInstances()) {
      const inst = terminals.list.find((t) => t.id === id);
      if (inst) markSeen(inst);
    }
  }
  watch(() => [editorsM.activeLeaf()?.id, editorsM.editors.groups.map((g) => g.activeTabId).join(',')], seenVisible);
  window.addEventListener('focus', seenVisible);

  /** 훅 설치·제거 — ConfirmDialog 뒤 데몬(원격이면 원격)이 그 머신 홈의 설정 파일에 superlite 항목을 병합·제거 */
  async function installHooks(action: 'install' | 'uninstall'): Promise<void> {
    if (!backend.agentHooks) {
      notify('warning', 'This session cannot install agent hooks (no daemon)');
      return;
    }
    const choice = await confirm({
      message: action === 'install' ? 'Install superlite hooks into Claude Code?' : 'Remove superlite hooks from Claude Code?',
      detail: action === 'install'
        ? 'Adds superlite entries to ~/.claude/settings.json on the machine running this session\'s daemon. Your own hooks are kept. Outside superlite terminals the hooks do nothing.'
        : 'Removes only the superlite entries from ~/.claude/settings.json on the machine running this session\'s daemon.',
      confirmLabel: action === 'install' ? 'Install' : 'Remove',
    });
    if (choice !== 'confirm') return;
    try {
      const r = await backend.agentHooks('claude', action);
      notify('info', `${r.installed ? 'Installed' : 'Removed'} Claude Code hooks: ${r.path}`);
    } catch (e) {
      notify('error', `Agent hooks: ${errText(e)}`);
    }
  }

  return self;
}

// ---- 활성 세션 전달 shim
export const installAgentHooks = (action: 'install' | 'uninstall'): Promise<void> => ctx().terminals.agent.installHooks(action);
/** 카드 행의 점 — 터미널 하나 (tmux 없는 plain 터미널은 null) */
export const instanceDot = (instId: number): DotSpec | null => ctx().terminals.agent.dotOfInstance(instId);
/** 사이드바 행의 점 — tmux 세션 하나 */
export const listedDot = (tmuxId: string): DotSpec | null => ctx().terminals.agent.dotOfTmux(tmuxId);
/** 에디터 탭의 요약 점 — 탭 자신 + 카드들의 노랑/초록 */
export const tabDot = (tab: Tab): DotSpec | null => ctx().terminals.agent.dotOfTab(tab);
export function agentStateOfListed(tmuxId: string): AgentState | null {
  return ctx().terminals.agent.stateOf(tmuxId);
}
