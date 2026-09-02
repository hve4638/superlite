<script setup lang="ts">
import { editors, openDiff, openFile } from '../../model/editors';
import { activeSessionEmpty } from '../../model/sessions';
import EditorLayoutNode from './EditorLayoutNode.vue';
import StartPage from '../StartPage.vue';

// DEV 전용 테스트 훅 — playwright 검증 스크립트가 파일을 열 수 있게 한다
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__test = { openFile, openDiff };
}
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
