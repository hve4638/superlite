import { reactive } from '@vue/reactivity';
import type { TerminalSession, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { notify } from './notifications';
import type { createEditors } from './editors';

export interface TerminalInstance {
  id: number;
  title: string;
  session: TerminalSession;
  /** 다른 창에서 넘어온 xterm 버퍼(직렬화) — TerminalPane 이 xterm 을 열 때 먼저 그린다 */
  restoreBuffer?: string;
}

/** 창 이동 핸드오프의 터미널 한 개 — term 은 백엔드(데몬) 쪽 id, buffer 는 xterm 직렬화 */
export interface TerminalSnapshot {
  term: number;
  title: string;
  buffer: string;
}

// xterm 버퍼 직렬화 seam — TerminalPane 이 등록한다 (model 은 xterm 을 모른다).
// 세션 공용 슬롯 — 능력이지 세션 상태가 아니다 (editors 의 applyExternalEdit 과 같은 성격)
let serializeBuffer: ((id: number) => string | null) | null = null;
export function setTerminalSerializer(fn: (id: number) => string | null): void {
  serializeBuffer = fn;
}

// WHY: 페이지 전역 카운터 — 터미널 id 가 세션을 넘어 유일해야 TerminalPane 의 xterm
//      바인딩 맵(id 키, 세션 전환에도 살아남는다)이 세션 간에 충돌하지 않는다
let nextId = 1;

/** 탭을 열 자리 — 그룹·index (창 간 드롭 위치). 없으면 활성 그룹 끝 */
export type TerminalTabAt = { groupId?: number; index?: number };

/** 세션별 터미널 모듈 — 목록·배압 상태와 backend 이벤트 구독이 세션에 묶인다.
 *  터미널은 편집기 탭에 산다 — 등록이 탭을 열고, 정리가 탭을 닫고, 탭 × 는 훅으로 여기 온다 */
export function createTerminals(backend: ThinBackend, editorsM: ReturnType<typeof createEditors>) {
  const terminals = reactive({
    // WHY: session 객체는 반응성이 필요 없고 xterm 이 직접 잡는 외부 핸들이라
    //      reactive 프록시로 감싸지 않도록 markRaw 성격의 shallow 구조를 유지한다.
    //      (list 는 push/splice 만 추적하면 충분)
    list: [] as TerminalInstance[],
  });

  editorsM.setTerminalCloser((term) => disposeTerminal(term));

  function createTerminal(at?: TerminalTabAt): TerminalInstance {
    return register(backend.createTerminal(80, 24), 'bash', undefined, at);
  }

  /** 목록 등록 + 탭 열기 — 생성과 인수(adopt)가 공유한다 */
  function register(session: TerminalSession, title: string, restoreBuffer?: string, at?: TerminalTabAt): TerminalInstance {
    const inst: TerminalInstance = { id: nextId++, title, session };
    if (restoreBuffer) inst.restoreBuffer = restoreBuffer;
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

  function disposeTerminal(id: number): void {
    const idx = terminals.list.findIndex((t) => t.id === id);
    if (idx === -1) return;
    terminals.list[idx].session.dispose();
    removeAt(idx);
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

  return { terminals, createTerminal, disposeTerminal, snapshot, releaseTerminal, adoptTerminals };
}

// ---- 활성 세션 전달 shim

export const terminals = viewOf(() => ctx().terminals.terminals);
export const createTerminal = (at?: TerminalTabAt): TerminalInstance => ctx().terminals.createTerminal(at);
export const disposeTerminal = (id: number): void => ctx().terminals.disposeTerminal(id);
