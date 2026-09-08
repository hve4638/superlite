import { reactive } from 'vue';
import { notify } from '../../model/notifications';
import { DND_EDITOR, DND_FILE, multiWindow, sessionRoot, sessions } from '../../model/sessions';
import { windowLabel } from '../../model/window';

// WHY: dataTransfer 는 보안상 dragover 중 내용을 읽을 수 없다 — 드래그 중인 대상의
//      식별자는 모듈 상태로 공유해야 드롭 존이 출처를 알고 하이라이트·no-op 판정을 한다.
export const editorDrag = reactive({
  /** none: 드래그 없음, tab: 탭바의 탭, file: 탐색기 파일, folder: 탐색기 폴더 (폴더 탭으로 열린다),
   *  new-folder·new-terminal: 타이틀바 아이콘 — 놓는 자리(탭 index·그룹·분할)에 새 폴더 탭(루트)·새 터미널 */
  kind: 'none' as 'none' | 'tab' | 'file' | 'folder' | 'new-folder' | 'new-terminal',
  groupId: 0,
  tabId: '',
  path: '',
  /** 탐색기 드래그의 선택 집합 전체 (path 는 그 첫 항목) — 트리 안 드롭(이동·복사)이 읽는다.
   *  편집기 쪽 드롭은 여전히 path 하나만 연다 (ponytail) */
  paths: [] as string[],
});

export function startTabDrag(groupId: number, tabId: string): void {
  editorDrag.kind = 'tab';
  editorDrag.groupId = groupId;
  editorDrag.tabId = tabId;
}

export function startFileDrag(path: string, kind: 'file' | 'folder' = 'file', paths: string[] = [path]): void {
  editorDrag.kind = kind;
  editorDrag.path = path;
  editorDrag.paths = paths;
}

/** 타이틀바 아이콘 드래그 — 놓는 자리에 새 탭을 만든다 (클릭은 활성 그룹 끝) */
export function startNewTabDrag(kind: 'new-folder' | 'new-terminal'): void {
  editorDrag.kind = kind;
}

export function endEditorDrag(): void {
  editorDrag.kind = 'none';
}

/** 다른 창에서 끌고 온 편집기 탭·탐색기 경로인가 — 이 창의 드래그가 아니고(editorDrag 없음) 창 간 MIME 이
 *  실려 있다. dragover 중엔 타입만 읽히므로 출처·root 판정은 드롭 때(readForeignDrop) */
export function isForeignDrag(e: DragEvent): boolean {
  if (editorDrag.kind !== 'none' || !multiWindow()) return false;
  const types = e.dataTransfer?.types;
  return types !== undefined && (types.includes(DND_EDITOR) || types.includes(DND_FILE));
}

/** 다른 창의 탭·탐색기 경로가 이 창 위를 지나는 중인가 — 본문 드롭 존(drop-layer)은 드래그 중에만 monaco 를
 *  덮는데, 창 밖에서 온 드래그는 editorDrag 가 없어 층이 생기지 않아 monaco 가 이벤트를 삼켰다 (Windows 실측
 *  2026-09-08). 창 단위 dragenter 로 켜고, 창을 벗어나거나(dragleave relatedTarget null) 놓으면 끈다 */
export const foreignDrag = reactive({ active: false });

/** 창 단위 외부 드래그 추적 등록 — 편집기 영역이 마운트될 때 한 번 (EditorArea) */
export function trackForeignDrag(): () => void {
  const enter = (e: DragEvent) => { if (isForeignDrag(e)) foreignDrag.active = true; };
  const leave = (e: DragEvent) => { if (e.relatedTarget === null) foreignDrag.active = false; };
  const drop = () => { foreignDrag.active = false; };
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragleave', leave);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('drop', drop);
  };
}

export type ForeignDrop =
  | { kind: 'tab'; window: string; session: string; groupId: number; tabId: string }
  | { kind: 'file' | 'folder'; path: string };

/** 창 간 드롭 데이터를 읽는다 — 같은 root 의 세션에만 (와이어 경로가 root 상대). 자기 창 것·root 불일치는
 *  null (불일치는 알린다). 탭은 상태가 출처 창에 있으니 호출측이 requestTabsMove 로 이동을 요청하고,
 *  경로는 이 창이 자기 세션에서 디스크로부터 연다 */
export function readForeignDrop(e: DragEvent): ForeignDrop | null {
  const rawTab = e.dataTransfer?.getData(DND_EDITOR);
  const rawFile = rawTab ? '' : e.dataTransfer?.getData(DND_FILE);
  const raw = rawTab || rawFile;
  if (!raw) return null;
  const d = JSON.parse(raw) as { window: string; root: string | null; session: string; groupId: number; tabId: string; path: string; kind: 'file' | 'folder' };
  if (d.window === windowLabel) return null;
  if (d.root === null || d.root !== sessionRoot(sessions.activeId)) {
    notify('warning', `${rawTab ? 'Editor tabs' : 'Files'} can only be dropped between windows of the same folder`);
    return null;
  }
  return rawTab ? { kind: 'tab', window: d.window, session: d.session, groupId: d.groupId, tabId: d.tabId } : { kind: d.kind, path: d.path };
}
