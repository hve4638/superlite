import { reactive } from 'vue';

// WHY: dataTransfer 는 보안상 dragover 중 내용을 읽을 수 없다 — 드래그 중인 대상의
//      식별자는 모듈 상태로 공유해야 드롭 존이 출처를 알고 하이라이트·no-op 판정을 한다.
export const editorDrag = reactive({
  /** none: 드래그 없음, tab: 탭바의 탭, file: 탐색기 파일 */
  kind: 'none' as 'none' | 'tab' | 'file',
  groupId: 0,
  tabId: '',
  path: '',
});

export function startTabDrag(groupId: number, tabId: string): void {
  editorDrag.kind = 'tab';
  editorDrag.groupId = groupId;
  editorDrag.tabId = tabId;
}

export function startFileDrag(path: string): void {
  editorDrag.kind = 'file';
  editorDrag.path = path;
}

export function endEditorDrag(): void {
  editorDrag.kind = 'none';
}
