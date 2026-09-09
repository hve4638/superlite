<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { editors } from '../../model/editors';
import { activeSessionEmpty } from '../../model/sessions';
import EditorLayoutNode from './EditorLayoutNode.vue';
import { trackForeignDrag } from './tabDnd';
import StartPage from '../StartPage.vue';

// 다른 창의 탭·탐색기 드래그가 이 창에 들어오면 그룹 본문의 드롭 층을 띄운다 (cross-window-editor-drop)
onBeforeUnmount(trackForeignDrag());
</script>

<template>
  <div class="editor-area">
    <!-- 빈 세션(루트 없음)은 에디터 대신 시작 페이지 — 열 파일 자체가 없다 -->
    <StartPage v-if="activeSessionEmpty()" />
    <EditorLayoutNode v-else :node="editors.layout" class="root" />
  </div>
</template>

<style scoped>
.editor-area {
  flex: 1;
  display: flex;
  min-width: 0;
  background: var(--vscode-editor-background);
}
.root {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
