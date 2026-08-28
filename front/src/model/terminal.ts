import { reactive } from '@vue/reactivity';
import { backend } from './host';
import type { TerminalSession } from '../backend/types';
import { notify } from './notifications';
import { workbench, togglePanel } from './workbench';

export interface TerminalInstance {
  id: number;
  title: string;
  session: TerminalSession;
}

let nextId = 1;

export const terminals = reactive({
  // WHY: session 객체는 반응성이 필요 없고 xterm 이 직접 잡는 외부 핸들이라
  //      reactive 프록시로 감싸지 않도록 markRaw 성격의 shallow 구조를 유지한다.
  //      (list 는 push/splice 만 추적하면 충분)
  list: [] as TerminalInstance[],
  activeId: 0,
});

export function createTerminal(): TerminalInstance {
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

export function disposeTerminal(id: number): void {
  const idx = terminals.list.findIndex((t) => t.id === id);
  if (idx === -1) return;
  terminals.list[idx].session.dispose();
  terminals.list.splice(idx, 1);
  if (terminals.activeId === id) {
    terminals.activeId = terminals.list[terminals.list.length - 1]?.id ?? 0;
  }
  // WHY: 마지막 터미널이 빠지면 패널을 닫는다 (VS Code) — kill 버튼·셸 종료·세션 회수가
  //      전부 이 함수를 지나므로 여기가 합류점이다
  if (terminals.list.length === 0 && workbench.panelVisible) togglePanel();
}

export function setActiveTerminal(id: number): void {
  terminals.activeId = id;
}

// 재연결은 됐지만 데몬 세션이 회수된 경우(장기 끊김) — 이쪽 터미널은 전부 죽었다.
// 응답 없는 유령으로 남기는 대신 정리하고 알린다 (다음 패널 열기가 새 터미널을 만든다)
backend.onSessionLost?.(() => {
  if (terminals.list.length === 0) return;
  for (const t of [...terminals.list]) disposeTerminal(t.id);
  notify('warning', 'Terminal sessions were lost while disconnected');
});
