import { ref } from 'vue';
import { notify } from '../../model/notifications';
import { DND_TERMINAL, detachTerminal, multiWindow, requestTabsMove, sessionRoot, sessions } from '../../model/sessions';
import { windowLabel } from '../../model/window';
import { pointerOutside } from '../dndUtil';

// 터미널 탭의 창 간 DnD — 탭 행(TerminalPane 우측 목록)과 패널 제목의 단일 탭 라벨(PanelArea)이
// 같은 드래그 출처라 여기서 공유한다. 드롭 존은 터미널 영역(TerminalPane) 전체.
// WHY: 같은 창 안에서는 터미널 순서 이동이 없다 — 드래그는 오직 창 밖(새 창)·다른 창용이라
//      dragover 중 로컬 드래그(draggingId)는 받지 않는다

/** 이 창에서 끌고 있는 터미널 인스턴스 id — 다른 창에서 온 드래그와 구분한다 */
const draggingId = ref<number | null>(null);
/** 다른 창의 터미널이 이 창 위에 있다 — 드롭 존 하이라이트 */
export const foreignOver = ref(false);

export function terminalDraggable(): boolean {
  return multiWindow() && sessionRoot(sessions.activeId) !== null;
}

export function onTermDragStart(e: DragEvent, id: number): void {
  e.dataTransfer?.setData('text/plain', String(id));
  e.dataTransfer?.setData(
    DND_TERMINAL,
    JSON.stringify({ window: windowLabel, session: sessions.activeId, root: sessionRoot(sessions.activeId), id }),
  );
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  draggingId.value = id;
}

/** 출처의 dragend — 아무 존도 받지 않았고 창 밖이면 새 창으로 (에디터·세션 탭과 같은 판정) */
export function onTermDragEnd(e: DragEvent): void {
  const id = draggingId.value;
  if (id !== null && e.dataTransfer?.dropEffect === 'none' && pointerOutside(e)) {
    detachTerminal(id, e.screenX - 100, e.screenY - 17);
  }
  draggingId.value = null;
}

function isForeign(e: DragEvent): boolean {
  return draggingId.value === null && multiWindow() && (e.dataTransfer?.types.includes(DND_TERMINAL) ?? false);
}

export function onTermDragOver(e: DragEvent): void {
  if (!isForeign(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  foreignOver.value = true;
}

export function onTermDragLeave(e: DragEvent): void {
  // 자식 요소 사이 이동은 leave 가 아니다 — 하이라이트가 깜빡이지 않게
  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
  foreignOver.value = false;
}

/** 다른 창의 터미널 병합 — 같은 root 의 세션에만 (데몬 adoptTerminal 이 root 일치를 요구한다) */
export function onTermDrop(e: DragEvent): void {
  foreignOver.value = false;
  if (!isForeign(e)) return;
  e.preventDefault();
  const raw = e.dataTransfer?.getData(DND_TERMINAL);
  if (!raw) return;
  const d = JSON.parse(raw) as { window: string; session: string; root: string | null; id: number };
  if (d.window === windowLabel) return;
  if (d.root === null || d.root !== sessionRoot(sessions.activeId)) {
    notify('warning', 'Terminals can only be moved between windows of the same folder');
    return;
  }
  requestTabsMove(d.window, { fromSession: d.session, terminal: d.id }, {});
}
