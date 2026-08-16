<script setup lang="ts">
import { editors, openDiff, openFile } from '../../model/editors';
import EditorGroupView from './EditorGroupView.vue';

// DEV 전용 테스트 훅 — playwright 검증 스크립트가 파일을 열 수 있게 한다
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__test = { openFile, openDiff };
}
</script>

<template>
  <div class="editor-area">
    <EditorGroupView v-for="g in editors.groups" :key="g.id" :group="g" class="group" />
  </div>
</template>

<style scoped>
.editor-area {
  flex: 1;
  display: flex;
  min-width: 0;
  background: var(--vscode-editor-background);
}
.group {
  flex: 1;
  min-width: 0;
}
.group + .group {
  border-left: 1px solid var(--vscode-editorGroup-border);
}
</style>
