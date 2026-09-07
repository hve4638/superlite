import { reactive } from 'vue';

// WHY: dataTransfer 는 보안상 dragover 중 내용을 읽을 수 없다 — 드래그 중인 대상의
//      식별자는 모듈 상태로 공유해야 드롭 존이 출처를 알고 하이라이트·no-op 판정을 한다.
export const editorDrag = reactive({
  /** none: 드래그 없음, tab: 탭바의 탭, file: 탐색기 파일, folder: 탐색기 폴더 (폴더 탭으로 열린다),
   *  new-folder·new-terminal: 타이틀바 아이콘 — 놓는 자리(탭 index·그룹·분할)에 새 폴더 탭(루트)·새 터미널 */
  kind: 'none' as 'none' | 'tab' | 'file' | 'folder' | 'new-folder' | 'new-terminal',
  groupId: 0,
  tabId: '',
  path: '',
});

export function startTabDrag(groupId: number, tabId: string): void {
  editorDrag.kind = 'tab';
  editorDrag.groupId = groupId;
  editorDrag.tabId = tabId;
}

export function startFileDrag(path: string, kind: 'file' | 'folder' = 'file'): void {
  editorDrag.kind = kind;
  editorDrag.path = path;
}

/** 타이틀바 아이콘 드래그 — 놓는 자리에 새 탭을 만든다 (클릭은 활성 그룹 끝) */
export function startNewTabDrag(kind: 'new-folder' | 'new-terminal'): void {
  editorDrag.kind = kind;
}

export function endEditorDrag(): void {
  editorDrag.kind = 'none';
}
