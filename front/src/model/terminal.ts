import { reactive, watch } from '@vue/reactivity';
import type { TerminalInfo, TerminalMode, TerminalSession, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { confirm } from './dialog';
import { errText, notify } from './notifications';
import { EDITOR_ZOOM_MAX, EDITOR_ZOOM_MIN, EDITOR_ZOOM_STEP, editorView, loadWindowZoom, saveWindowZoom, setEditorZoom } from './editors';
import type { createEditors } from './editors';

export interface TerminalInstance {
  id: number;
  title: string;
  session: TerminalSession;
  /** 다른 창에서 넘어온 xterm 버퍼(직렬화) — TerminalView 가 xterm 을 열 때 먼저 그린다 */
  restoreBuffer?: string;
  /** 붙어 있는 tmux 세션 (와이어 v17 termTmux) — 없으면 plain 터미널 (탭 닫기가 곧 종료) */
  tmux?: { id: string; name: string };
}

/** 창 이동 핸드오프의 터미널 한 개 — term 은 백엔드(데몬) 쪽 id, buffer 는 xterm 직렬화 */
export interface TerminalSnapshot {
  term: number;
  title: string;
  buffer: string;
}

// xterm 버퍼 직렬화 seam — terminalHost 가 등록한다 (model 은 xterm 을 모른다).
// 세션 공용 슬롯 — 능력이지 세션 상태가 아니다 (editors 의 applyExternalEdit 과 같은 성격)
let serializeBuffer: ((id: number) => string | null) | null = null;
export function setTerminalSerializer(fn: (id: number) => string | null): void {
  serializeBuffer = fn;
}

// WHY: 페이지 전역 카운터 — 터미널 id 가 세션을 넘어 유일해야 terminalHost 의 xterm
//      바인딩 맵(id 키, 세션 전환에도 살아남는다)이 세션 간에 충돌하지 않는다
let nextId = 1;

/** 탭을 열 자리 — 그룹·index (창 간 드롭 위치). 없으면 활성 그룹 끝 */
export type TerminalTabAt = { groupId?: number; index?: number };

// 강제 종료 확인창의 "다시 묻지 않기" — 창·세션 무관 전역이라 localStorage
const KILL_NO_CONFIRM_KEY = 'superlite.terminalKillNoConfirm';

/** 세션별 터미널 모듈 — 목록·배압 상태와 backend 이벤트 구독이 세션에 묶인다.
 *  터미널은 편집기 탭에 산다 — 등록이 탭을 열고, 정리가 탭을 닫고, 탭 × 는 훅으로 여기 온다 */
export function createTerminals(backend: ThinBackend, editorsM: ReturnType<typeof createEditors>) {
  const terminals = reactive({
    // 주의: 깊은 reactive 라 list 의 인스턴스와 그 session 핸들도 프록시로 감싸인다. session 은
    //      메서드만 있는 순수 인터페이스라 프록시 경유 호출이 지금은 무해하다 — daemon.ts 처럼
    //      shallowReactive 로 바꾸는 것은 반응성 범위가 달라지므로 별건 (BACKLOG)
    list: [] as TerminalInstance[],
  });

  /** 내장 tmux 상태 (ticket term-list-reconnect) — 데몬의 방식(attach 응답), plain 대체 사유(사이드바
   *  아이콘의 경고 배지), 사이드바 목록. unknown = attach 응답 전 (아이콘 숨김) */
  const state = reactive({
    mode: 'unknown' as TerminalMode | 'unknown',
    error: null as string | null,
    list: [] as TerminalInfo[],
  });
  // 서버 목록은 tmux 서버가 원장 — 활동바 배지가 늘 보이므로 사이드바가 닫혀 있어도 3초마다 다시 읽는다
  // (다른 창·PC 에서 만들거나 죽인 세션). 열기·닫기·종료·이름 바꾸기는 즉시 갱신 (ticket terminal-count-badge)
  let poll: ReturnType<typeof setInterval> | null = null;
  backend.onTerminalMode?.((mode, error) => {
    state.mode = mode;
    state.error = error;
    if (mode === 'tmux' && poll === null) {
      void refreshTerminals();
      poll = setInterval(() => void refreshTerminals(), 3000);
    }
  });

  editorsM.setTerminalCloser((term) => disposeTerminal(term));

  // 터미널 탭 포커스 이력 (최근이 앞, 인스턴스 id) — 활성 탭이 터미널이 될 때마다 앞으로 옮긴다.
  // "최근" 은 연 시각이 아니라 마지막으로 활성이 된 시각 (VS Code 와 같다, ticket terminal-toggle-keys)
  const focusOrder: number[] = [];
  watch(() => editorsM.activeTab(), (t) => {
    if (t?.kind !== 'terminal') return;
    const i = focusOrder.indexOf(t.term);
    if (i >= 0) focusOrder.splice(i, 1);
    focusOrder.unshift(t.term);
  });

  function createTerminal(at?: TerminalTabAt): TerminalInstance {
    return register(backend.createTerminal(80, 24), 'bash', undefined, at);
  }

  /** Ctrl+` — 터미널 탭이 없으면 생성, 있으면 창 전체에서 가장 최근에 활성이었던 터미널 탭으로 (사용자 결정
   *  2026-09-09: 후보 2, 그룹 무관). 이미 그 탭이 활성이면 포커스만 준다 (편집기 ↔ 터미널 왕복) */
  function toggleTerminal(): void {
    if (terminals.list.length === 0) {
      createTerminal();
      return;
    }
    const id = focusOrder[0] ?? terminals.list[terminals.list.length - 1].id;
    editorsM.focusTerminalTab(id);
    editorsM.editors.pendingFocus = true;
  }

  /** 사이드바 목록의 세션에 붙는다 — 이 창에 이미 열려 있으면 그 탭을 앞으로 (같은 세션을 두 탭으로
   *  보려면 새 탭 옵션 — 컨텍스트 메뉴). tmux 가 다중 attach 를 지원하므로 다른 창·PC 와 동시에 본다 */
  function attachTerminal(info: TerminalInfo, opts: { newTab?: boolean; at?: TerminalTabAt } = {}): TerminalInstance | null {
    if (!opts.newTab) {
      const open = terminals.list.find((t) => t.tmux?.id === info.id);
      if (open) {
        editorsM.focusTerminalTab(open.id);
        return open;
      }
    }
    return register(backend.createTerminal(80, 24, info.id), info.name, undefined, opts.at);
  }

  /** 목록 등록 + 탭 열기 — 생성과 인수(adopt)가 공유한다 */
  function register(session: TerminalSession, title: string, restoreBuffer?: string, at?: TerminalTabAt): TerminalInstance {
    const inst: TerminalInstance = { id: nextId++, title, session };
    if (restoreBuffer) inst.restoreBuffer = restoreBuffer;
    // tmux 세션 정보(와이어 v17) — 탭 제목이 세션 이름이 되고 사이드바가 "열려 있음" 을 대조한다.
    // 실패(null)면 이 터미널은 plain 으로 떴다 — 배지에 사유를 올린다 (데몬 방식은 tmux 인 채로)
    session.onTmux?.((info, error) => {
      const r = terminals.list.find((t) => t.id === inst.id);
      if (!r) return;
      if (info) {
        r.tmux = info;
        r.title = info.name;
        editorsM.renameTerminalTab(inst.id, info.name);
        // tmux 가 다시 되면 이전 실패 배지를 내린다 — 종전엔 onTerminalMode(재접속)만 비워 세션 끝까지 남았다
        state.error = null;
        void refreshTerminals();
      } else {
        state.error = error ?? 'tmux 실패';
        notify('warning', `tmux 를 쓸 수 없어 일반 터미널로 엽니다: ${state.error}`);
      }
    });
    // 셸이 스스로 종료(exit·crash)하면 탭도 닫는다 (VS Code 기본 동작). 실제 종료 코드가
    // 있으면(≠ null) 셸이 떴다는 뜻이라 코드와 무관하게 닫는다 — exit·Ctrl-D 는 $? 를
    // 물려받으므로 code 0 만 닫으면 실패한 명령 직후의 정상 종료가 유령 탭으로 남는다.
    // WHY: spawn 실패(code null)에 닫아버리면 데몬의 에러 출력("pty 생성 실패" 등)을 읽을 수
    //      없고, 패널 열기→자동 생성→즉시 닫힘 루프로 패널 전체가 고착된다.
    //      그 탭만 유지해 에러를 보이고, 정리는 kill 버튼 몫
    session.onExit((code) => {
      if (code !== null) disposeTerminal(inst.id);
    });
    terminals.list.push(inst);
    editorsM.openTerminalTab(inst.id, title, at);
    return inst;
  }

  function snapshotOf(t: TerminalInstance): TerminalSnapshot {
    return { term: t.session.id, title: t.title, buffer: serializeBuffer?.(t.id) ?? '' };
  }

  /** 창 이동 핸드오프용 스냅샷 — 데몬 쪽 term id·제목·xterm 버퍼. id 를 주면 그 하나만 */
  function snapshot(id?: number): TerminalSnapshot[] {
    return terminals.list.filter((t) => id === undefined || t.id === id).map(snapshotOf);
  }

  /** 목록에서 빼되 데몬 터미널은 죽이지 않는다 — 다른 창의 세션이 이어받는다 (release) */
  function releaseTerminal(id: number): void {
    const idx = terminals.list.findIndex((t) => t.id === id);
    if (idx === -1) return;
    terminals.list[idx].session.release?.();
    removeAt(idx);
  }

  /** 목록에서 뺀 뒤의 뒷정리 — 탭 닫기 (release·dispose 공용). 셸 종료·세션 회수·창 이동이
   *  전부 여기를 지난다. 탭 × 경유(훅)면 탭은 이미 없어 no-op */
  function removeAt(idx: number): void {
    const [inst] = terminals.list.splice(idx, 1);
    inputBlocked.delete(inst.session.id);
    const fi = focusOrder.indexOf(inst.id);
    if (fi >= 0) focusOrder.splice(fi, 1);
    editorsM.closeTerminalTabs(inst.id);
  }

  /** 다른 창에서 넘어온 터미널 인수 — from 이 없으면 같은 세션(id 재-attach)의 기존 터미널,
   *  있으면 같은 root 의 다른 세션 것을 데몬에서 옮겨 받는다 (와이어 v10). 백엔드가 인수를
   *  지원하지 않으면(mock·empty) 무동작. at 은 탭을 열 그룹·index (드롭 위치) */
  function adoptTerminals(snaps: TerminalSnapshot[], from?: string, at?: TerminalTabAt): void {
    if (!backend.adoptTerminal) return;
    for (const s of snaps) {
      const session = backend.adoptTerminal(from ? { from: { session: from, term: s.term } } : { term: s.term });
      register(session, s.title, s.buffer, at);
    }
  }

  /** 탭 닫기 = tmux 클라이언트 종료 = detach — 세션은 서버에 남는다 (plain 이면 셸이 죽는다) */
  function disposeTerminal(id: number): void {
    const idx = terminals.list.findIndex((t) => t.id === id);
    if (idx === -1) return;
    terminals.list[idx].session.dispose();
    removeAt(idx);
    void refreshTerminals();
  }

  /** 사이드바 목록 갱신 — 이 워크스페이스의 살아 있는 tmux 세션. 지원 없는 백엔드는 빈 목록 */
  async function refreshTerminals(): Promise<void> {
    if (!backend.listTerminals) {
      state.list = [];
      return;
    }
    state.list = await backend.listTerminals().catch((e: unknown) => {
      console.warn(`listTerminals 실패: ${errText(e)}`);
      return [];
    });
  }

  /** 복원용 목록 조회 (workspaceState) — 조회가 실패(예외)하면 500ms 뒤 한 번만 재시도한다 (ssh 재접속 등
   *  일시적 실패 대비). 성공한 결과는 비어 있어도 그대로 반환한다 — 재부팅처럼 세션이 진짜 없어진 경우를
   *  지연 없이 즉시 접기 위함. 재시도도 실패하면 throw — 복원이 실패를 빈 목록으로 오인해 저장된 자리를
   *  접지 않게. 받은 목록은 state.list 에도 반영한다 (ticket term-layout-restore-flaky) */
  async function listTerminalsFor(): Promise<TerminalInfo[]> {
    if (!backend.listTerminals) return [];
    try {
      state.list = await backend.listTerminals();
      return state.list;
    } catch (e) {
      console.warn(`listTerminals 실패, 500ms 뒤 재시도: ${errText(e)}`);
      await new Promise((r) => setTimeout(r, 500));
      state.list = await backend.listTerminals();
      return state.list;
    }
  }

  /** 강제 종료 확인 (Ctrl+닫기) — tmux 세션이 없는 탭(plain)은 그냥 닫는다. "다시 묻지 않기" 를
   *  체크했으면(localStorage) 확인 없이 바로 종료한다 */
  function requestKill(id: number): void {
    const inst = terminals.list.find((t) => t.id === id);
    if (!inst) return;
    if (!inst.tmux || !backend.killTerminal) {
      disposeTerminal(id);
      return;
    }
    if (localStorage.getItem(KILL_NO_CONFIRM_KEY) === '1') {
      void killListed(inst.tmux.id);
      return;
    }
    void askKill(inst.tmux.id);
  }
  /** 강제 종료 확인 — 탭 닫기는 detach 라 세션이 남지만 이것은 tmux 세션을 죽인다.
   *  보조 버튼 "종료, 다시 묻지 않기" 가 종전 체크박스를 대신한다 (OS 다이얼로그에 체크박스가 없다) */
  async function askKill(tmuxId: string): Promise<void> {
    const choice = await confirm({ message: '터미널을 정말 종료하시겠습니까?', confirmLabel: '종료', secondaryLabel: '종료, 다시 묻지 않기' });
    if (choice === 'cancel') return;
    if (choice === 'secondary') localStorage.setItem(KILL_NO_CONFIRM_KEY, '1');
    await killListed(tmuxId);
  }

  /** tmux 세션 종료 — 이 창의 탭도 닫는다 (클라이언트는 어차피 서버가 끊는다) */
  async function killListed(tmuxId: string): Promise<void> {
    try {
      await backend.killTerminal?.(tmuxId);
    } catch (e) {
      notify('error', `Kill terminal: ${errText(e)}`);
    }
    for (const t of terminals.list.filter((t) => t.tmux?.id === tmuxId)) disposeTerminal(t.id);
    void refreshTerminals();
  }

  async function renameListed(tmuxId: string, name: string): Promise<void> {
    try {
      await backend.renameTerminal?.(tmuxId, name);
    } catch (e) {
      notify('error', `Rename terminal: ${errText(e)}`);
    }
    for (const t of terminals.list.filter((t) => t.tmux?.id === tmuxId)) {
      t.tmux = { id: tmuxId, name };
      t.title = name;
      editorsM.renameTerminalTab(t.id, name);
    }
    void refreshTerminals();
  }

  // 입력 배압 진입 — 입력이 소비되지 않아 이후 입력이 로컬 대기 중임을 알린다.
  // (셸 정체가 보통이지만 장시간 끊김 중에도 도달한다 — 문구는 원인을 단정하지 않는다)
  // 에피소드당 한 번만 (해제 후 재진입하면 다시). 해제 알림은 소음이라 생략
  const inputBlocked = new Set<number>();
  backend.onInputBlocked?.((term, blocked) => {
    if (!blocked) {
      inputBlocked.delete(term);
      return;
    }
    if (inputBlocked.has(term)) return;
    inputBlocked.add(term);
    const title = terminals.list.find((t) => t.session.id === term)?.title ?? 'terminal';
    notify('warning', `Terminal "${title}" is not consuming input — further input is queued`);
  });

  // 재연결은 됐지만 데몬 세션이 회수된 경우(장기 끊김) — 명단(deadTerms)의 터미널만 죽었다.
  // 끊김 중 만든 터미널은 새 세션에 살아 있으므로 남긴다.
  // 응답 없는 유령으로 남기는 대신 정리하고 알린다 (다음 패널 열기가 새 터미널을 만든다)
  backend.onSessionLost?.((deadTerms) => {
    const gone = terminals.list.filter((t) => deadTerms.includes(t.session.id));
    if (gone.length === 0) return;
    for (const t of gone) disposeTerminal(t.id);
    notify('warning', 'Terminal sessions were lost while disconnected');
  });

  return {
    terminals, state, createTerminal, toggleTerminal, attachTerminal, disposeTerminal, snapshot, releaseTerminal, adoptTerminals,
    refreshTerminals, listTerminalsFor, requestKill, killListed, renameListed,
  };
}

// ---- 터미널 줌 — 편집기 줌과 별개의 값(사용자 결정 2026-09-08: 터미널 개별 배율). 범위·단위는
//      편집기와 같고, 세션 무관·창 단위라 편집기와 같은 방식(loadWindowZoom)으로 기억한다. terminalHost 가
//      지켜보다 열려 있는 모든 xterm 의 fontSize 를 바꾸고 fit 한다
const TERMINAL_ZOOM_KEY = 'superlite.terminalZoom';
function clampTerminalZoom(percent: number): number {
  const snapped = Math.round(percent / EDITOR_ZOOM_STEP) * EDITOR_ZOOM_STEP;
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, snapped));
}
export const terminalView = reactive({ zoom: loadWindowZoom(TERMINAL_ZOOM_KEY) });
export function setTerminalZoom(percent: number): void {
  terminalView.zoom = clampTerminalZoom(percent);
  saveWindowZoom(TERMINAL_ZOOM_KEY, terminalView.zoom);
}
export function stepTerminalZoom(dir: 1 | -1): void {
  setTerminalZoom(terminalView.zoom + dir * EDITOR_ZOOM_STEP);
}

/** 창 배율 핸드오프 (ticket zoom-per-window) — 새 창(세션 분리·탭 분리·보조창 복원)이 출처 창의 편집기·터미널
 *  배율을 물려받는 데 쓴다. 출처가 fontZoom() 으로 만들어 핸드오프에 싣고, 새 창이 applyFontZoom 으로 받는다 */
export type FontZoom = { editor: number; terminal: number };
export function fontZoom(): FontZoom {
  return { editor: editorView.zoom, terminal: terminalView.zoom };
}
export function applyFontZoom(z: FontZoom): void {
  setEditorZoom(z.editor);
  setTerminalZoom(z.terminal);
}

// ---- 활성 세션 전달 shim

export const terminals = viewOf(() => ctx().terminals.terminals);
export const terminalState = viewOf(() => ctx().terminals.state);
export const createTerminal = (at?: TerminalTabAt): TerminalInstance => ctx().terminals.createTerminal(at);
export const toggleTerminal = (): void => ctx().terminals.toggleTerminal();
export const disposeTerminal = (id: number): void => ctx().terminals.disposeTerminal(id);
export const attachTerminal = (info: TerminalInfo, opts?: { newTab?: boolean }): TerminalInstance | null =>
  ctx().terminals.attachTerminal(info, opts);
export const refreshTerminals = (): Promise<void> => ctx().terminals.refreshTerminals();
export const requestKillTerminal = (id: number): void => ctx().terminals.requestKill(id);
export const killListedTerminal = (tmuxId: string): Promise<void> => ctx().terminals.killListed(tmuxId);
export const renameListedTerminal = (tmuxId: string, name: string): Promise<void> =>
  ctx().terminals.renameListed(tmuxId, name);
