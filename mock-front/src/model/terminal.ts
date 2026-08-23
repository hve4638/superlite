import { reactive } from '@vue/reactivity';
import { backend } from './host';
import type { TerminalSession } from '../backend/types';
import { notify } from './notifications';

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
