<script setup lang="ts">
import { computed, ref } from 'vue';
import { sideBarPinned, toggleSideBarPinned, workbench } from '../model/workbench';
import { runSearch, clearSearch, collapseAllResults } from '../model/search';
import { refreshHosts } from '../model/remote';
import { collapseAll, refreshTree } from '../model/files';
import { activeSessionEmpty } from '../model/sessions';
import { createTerminal, refreshTerminals } from '../model/terminal';
import { openSshConfig, openTmuxConf } from '../model/configfiles';
import ExplorerView from './views/ExplorerView.vue';
import SearchView from './views/SearchView.vue';
import ScmView from './views/ScmView.vue';
import RemoteView from './views/RemoteView.vue';
import TerminalsView from './views/TerminalsView.vue';

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  scm: 'Source Control',
  remote: 'Remote Explorer',
  terminals: 'Terminals',
};

const view = computed(() => {
  switch (workbench.activeViewlet) {
    case 'search': return SearchView;
    case 'scm': return ScmView;
    case 'remote': return RemoteView;
    case 'terminals': return TerminalsView;
    default: return ExplorerView;
  }
});
// 탐색기 제목은 워크스페이스명 — VS Code 의 단일 뷰 병합(merged-header) 제목과 같다. 폴더가 없을 때
// (빈 세션·원격 접속 중이라 이름 미도착)는 VS Code 대로 "Explorer"
const title = computed(() => {
  if (workbench.activeViewlet === 'explorer' && !activeSessionEmpty() && workbench.workspaceName) {
    return workbench.workspaceName;
  }
  return TITLES[workbench.activeViewlet];
});

/** 뷰 인스턴스 — 탐색기의 새 파일·새 폴더 인라인 입력 (defineExpose) */
const viewRef = ref<{ newFile?: () => void; newFolder?: () => void } | null>(null);

// 뷰별 타이틀 액션 (탐색기는 폴더 pane 헤더의 액션이 제목으로 올라온 것 — 빈 세션엔 없음)
const ACTIONS: Record<string, { icon: string; label: string; run: () => void }[]> = {
  explorer: [
    { icon: 'codicon-new-file', label: 'New File...', run: () => viewRef.value?.newFile?.() },
    { icon: 'codicon-new-folder', label: 'New Folder...', run: () => viewRef.value?.newFolder?.() },
    { icon: 'codicon-refresh', label: 'Refresh Explorer', run: () => void refreshTree() },
    { icon: 'codicon-collapse-all', label: 'Collapse Folders in Explorer', run: collapseAll },
  ],
  search: [
    { icon: 'codicon-refresh', label: 'Refresh', run: () => void runSearch() },
    { icon: 'codicon-clear-all', label: 'Clear Search Results', run: clearSearch },
    { icon: 'codicon-collapse-all', label: 'Collapse All', run: collapseAllResults },
  ],
  remote: [
    { icon: 'codicon-refresh', label: 'Refresh', run: () => void refreshHosts() },
    { icon: 'codicon-edit', label: 'Edit SSH Config (this machine)', run: openSshConfig },
  ],
  terminals: [
    { icon: 'codicon-add', label: 'New Terminal', run: () => void createTerminal() },
    { icon: 'codicon-refresh', label: 'Refresh', run: () => void refreshTerminals() },
    { icon: 'codicon-settings-gear', label: 'Edit tmux.conf (applied profile)', run: () => void openTmuxConf() },
  ],
};
const actions = computed(() => {
  if (workbench.activeViewlet === 'explorer' && activeSessionEmpty()) return [];
  return ACTIONS[workbench.activeViewlet] ?? [];
});
</script>

<template>
  <div class="sidebar" :style="{ width: `${workbench.sideBarWidth}px` }">
    <div class="composite-title">
      <div class="title-label">{{ title }}</div>
      <div class="title-actions">
        <span
          v-for="a in actions"
          :key="a.icon"
          class="codicon"
          :class="a.icon"
          :title="a.label"
          @click="a.run()"
        />
        <!-- 고정/해제 — 플로팅(기본)은 편집기 위에 떠 있고, 고정하면 자리를 나눠 쓴다 (ticket floating-sidebar) -->
        <span
          class="codicon"
          :class="sideBarPinned() ? 'codicon-pinned' : 'codicon-pin'"
          :title="sideBarPinned() ? 'Unpin Side Bar' : 'Pin Side Bar'"
          @click="toggleSideBarPinned()"
        />
        <span
          v-if="workbench.activeViewlet !== 'search'"
          class="codicon codicon-ellipsis"
          title="Views and More Actions..."
        />
      </div>
    </div>
    <div class="composite-content">
      <component :is="view" ref="viewRef" />
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--vscode-sideBar-background);
  color: var(--vscode-sideBar-foreground);
  flex-shrink: 0;
  overflow: hidden;
}
.composite-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 35px;
  padding: 0 8px;
  flex-shrink: 0;
}
.title-label {
  /* WHY: VS Code composite 타이틀은 11px 대문자 (font-weight 는 normal) */
  font-size: 11px;
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-actions .codicon {
  font-size: 16px;
  padding: 2px;
  border-radius: 5px;
  cursor: pointer;
}
.title-actions .codicon:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.composite-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
