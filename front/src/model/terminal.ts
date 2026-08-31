import { reactive } from '@vue/reactivity';
import type { TerminalSession, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { notify } from './notifications';
import type { createWorkbench } from './workbench';

export interface TerminalInstance {
  id: number;
  title: string;
  session: TerminalSession;
}

/** 세션별 터미널 모듈 — 목록·배압 상태와 backend 이벤트 구독이 세션에 묶인다 */
export function createTerminals(backend: ThinBackend, workbenchM: ReturnType<typeof createWorkbench>) {
  const { workbench, togglePanel } = workbenchM;

  let nextId = 1;

  const terminals = reactive({
    // WHY: session 객체는 반응성이 필요 없고 xterm 이 직접 잡는 외부 핸들이라
    //      reactive 프록시로 감싸지 않도록 markRaw 성격의 shallow 구조를 유지한다.
    //      (list 는 push/splice 만 추적하면 충분)
    list: [] as TerminalInstance[],
    activeId: 0,
  });

  function createTerminal(): TerminalInstance {
    const session = backend.createTerminal(80, 24);
    const inst: TerminalInstance = { id: nextId++, title: 'bash', session };
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
    terminals.activeId = inst.id;
    return inst;
  }

  function disposeTerminal(id: number): void {
    const idx = terminals.list.findIndex((t) => t.id === id);
    if (idx === -1) return;
    terminals.list[idx].session.dispose();
    inputBlocked.delete(terminals.list[idx].session.id);
    terminals.list.splice(idx, 1);
    if (terminals.activeId === id) {
      terminals.activeId = terminals.list[terminals.list.length - 1]?.id ?? 0;
    }
    // WHY: 마지막 터미널이 빠지면 패널을 닫는다 (VS Code) — kill 버튼·셸 종료·세션 회수가
    //      전부 이 함수를 지나므로 여기가 합류점이다
    if (terminals.list.length === 0 && workbench.panelVisible) togglePanel();
  }

  function setActiveTerminal(id: number): void {
    terminals.activeId = id;
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

  return { terminals, createTerminal, disposeTerminal, setActiveTerminal };
}

// ---- 활성 세션 전달 shim

export const terminals = viewOf(() => ctx().terminals.terminals);
export const createTerminal = (): TerminalInstance => ctx().terminals.createTerminal();
export const disposeTerminal = (id: number): void => ctx().terminals.disposeTerminal(id);
export const setActiveTerminal = (id: number): void => ctx().terminals.setActiveTerminal(id);
