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
    <!-- 빈 세션(루트 없음)은 에디터 대신 시작 페이지 — 열 파일 자체가 없다. 단, 문서 없는 탭(설정 탭·클라이언트 설정
         파일 탭 — 백엔드 연결이 필요 없다)이 열려 있으면 편집기 영역을 그리고, 다 닫히면 시작 페이지로 돌아온다 (ticket user-settings) -->
    <StartPage v-if="activeSessionEmpty() && !editors.groups.some((g) => g.tabs.length > 0)" />
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
