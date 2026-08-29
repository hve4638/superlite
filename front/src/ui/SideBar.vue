<script setup lang="ts">
import { computed } from 'vue';
import { workbench } from '../model/workbench';
import { runSearch, clearSearch, collapseAllResults } from '../model/search';
import ExplorerView from './views/ExplorerView.vue';
import SearchView from './views/SearchView.vue';
import ScmView from './views/ScmView.vue';

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  scm: 'Source Control',
};

const view = computed(() => {
  switch (workbench.activeViewlet) {
    case 'search': return SearchView;
    case 'scm': return ScmView;
    default: return ExplorerView;
  }
});
const title = computed(() => TITLES[workbench.activeViewlet]);

// 뷰별 타이틀 액션
const ACTIONS: Record<string, { icon: string; label: string; run: () => void }[]> = {
  explorer: [],
  search: [
    { icon: 'codicon-refresh', label: 'Refresh', run: () => void runSearch() },
    { icon: 'codicon-clear-all', label: 'Clear Search Results', run: clearSearch },
    { icon: 'codicon-collapse-all', label: 'Collapse All', run: collapseAllResults },
  ],
  scm: [],
};
const actions = computed(() => ACTIONS[workbench.activeViewlet] ?? []);
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
        <span
          v-if="workbench.activeViewlet !== 'search'"
          class="codicon codicon-ellipsis"
          title="Views and More Actions..."
        />
      </div>
    </div>
    <div class="composite-content">
      <component :is="view" />
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--vscode-sideBar-background);
  color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
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
