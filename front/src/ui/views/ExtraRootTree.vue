<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { ExtraRoot } from '../../model/files';
import Sash from '../widgets/Sash.vue';
import FileTree from './FileTree.vue';

// 추가 탐색기 섹션 (ticket explorer-extra-roots) — 드롭한 폴더를 루트로 하는 트리 하나. Download 뷰와 같은
// pane-header(접이식, 위 경계 sash 로 높이) 아래에 FileTree 를 그대로 얹는다. 섹션은 워크스페이스 안 폴더만
// 되므로(사용자 결정 2026-09-14) 경로가 전부 루트 상대다 — 메인 트리와 같은 파일 조작·감시 갱신·git 표식이
// 그대로 동작하고, 트리 사이 드래그 이동도 성립한다. 선택·펼침은 섹션마다 독립이다 (사용자 결정 2026-09-13).
// 헤더는 draggable — 섹션끼리 순서를 바꾼다 (메인 트리는 위, Download 는 아래 고정이라 그 사이에서만).
// 놓일 자리는 섹션 사이의 삽입선으로 보인다 (line prop — 사용자 요청 2026-09-14: 헤더 외곽선은 어디로
// 가는지 읽히지 않는다). 헤더 오른쪽에는 메인 탐색기 제목과 같은 액션(새 파일·새 폴더·모두 접기)과 x 가 있다
const props = defineProps<{
  root: ExtraRoot;
  /** 순서 바꾸기 삽입선 — 이 섹션 위/아래 경계에 그린다 (bottom 은 마지막 섹션, 곧 Download 바로 위) */
  line?: 'top' | 'bottom' | null;
}>();
const emit = defineEmits<{
  remove: [];
  reorderStart: [];
  reorderEnd: [];
}>();

const open = ref(true);
const ROW_H = 22;
const MIN_H = ROW_H * 4;
const height = ref(ROW_H * 10);
let startH = 0;
function resize(dy: number): void {
  height.value = Math.max(MIN_H, startH - dy); // 위쪽 경계를 끄므로 위로(dy<0) 갈수록 커진다
}

/** 헤더 드래그 = 섹션 순서 바꾸기. 진행 상태·놓을 자리 계산은 부모(ExplorerView)가 목록 전체를 보고 한다.
 *  트리 행 드래그(파일 이동)와 섞이지 않게 전용 타입을 싣는다 — 트리 드롭 판정은 editorDrag 를 보므로 겹치지 않는다 */
const DND_SECTION = 'application/x-superlite-extra-root';
function onHeaderDragStart(e: DragEvent): void {
  e.dataTransfer?.setData(DND_SECTION, props.root.abs);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  emit('reorderStart');
}

// ---- 헤더 액션 — 메인 탐색기 제목의 것과 같다 (사용자 요청 2026-09-14). 접혀 있으면 먼저 펼치고 입력을 연다
const treeRef = ref<{ newFile: () => void; newFolder: () => void } | null>(null);
async function runAction(what: 'newFile' | 'newFolder'): Promise<void> {
  if (!open.value) {
    open.value = true;
    await nextTick();
  }
  treeRef.value?.[what]();
}
</script>

<template>
  <div class="xr-pane" :style="open ? { height: `${height}px` } : undefined">
    <Sash v-if="open" direction="horizontal" class="xr-sash" @dragstart="startH = height" @resize="resize" />
    <div
      class="pane-header collapsed"
      :title="root.abs"
      draggable="true"
      @click="open = !open"
      @dragstart="onHeaderDragStart"
      @dragend="emit('reorderEnd')"
    >
      <span class="codicon twisty" :class="open ? 'codicon-chevron-down' : 'codicon-chevron-right'" />
      <span class="title">{{ root.name }}</span>
      <span class="spacer" />
      <span class="codicon codicon-new-file action" title="New File..." @click.stop="runAction('newFile')" />
      <span class="codicon codicon-new-folder action" title="New Folder..." @click.stop="runAction('newFolder')" />
      <span class="codicon codicon-collapse-all action" title="Collapse Folders" @click.stop="root.tree.collapseAll()" />
      <span class="codicon codicon-close action" title="Remove Explorer" @click.stop="emit('remove')" />
    </div>
    <FileTree v-if="open" ref="treeRef" :tree="root.tree" />
    <!-- 순서 바꾸기 삽입선 — 놓으면 이 경계로 온다 -->
    <div v-if="line" class="insert-line" :class="line" />
  </div>
</template>

<style scoped>
.xr-pane {
  position: relative; /* sash 기준 */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.xr-sash {
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  z-index: 1;
}
/* pane header — ExplorerView 의 Download 뷰 헤더와 같은 규격 */
.pane-header {
  display: flex;
  align-items: center;
  height: 22px;
  flex-shrink: 0;
  background: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarSectionHeader-foreground);
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
}
/* 순서 바꾸기 삽입선 — 섹션 경계에 2px. 마지막 섹션의 아래 선이 곧 Download 바로 위다 */
.insert-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--vscode-focusBorder);
  pointer-events: none;
  z-index: 2;
}
.insert-line.top {
  top: 0;
}
.insert-line.bottom {
  bottom: 0;
}
.pane-header .twisty {
  font-size: 16px;
  margin: 0 2px;
  flex-shrink: 0;
}
.pane-header .title {
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pane-header .spacer {
  flex: 1;
}
.pane-header .action {
  font-size: 16px;
  margin-right: 6px;
  cursor: pointer;
  flex-shrink: 0;
}
.pane-header .action:hover {
  color: var(--vscode-foreground);
}
</style>
