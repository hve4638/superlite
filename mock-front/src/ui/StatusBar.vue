<script setup lang="ts">
import { computed } from 'vue';
import { activeTab, editors, indentOf, languageLabel } from '../model/editors';
import { scm } from '../model/scm';

// diff 탭도 path 를 가지므로 kind 무관하게 파일 정보를 표시한다 (VS Code 동일)
const fileTab = computed(() => activeTab());
const branchLabel = computed(() => (scm.dirty ? `${scm.branch}*` : scm.branch));
</script>

<template>
  <div class="statusbar">
    <div class="statusbar-left">
      <div class="statusbar-item remote" title="Open a Remote Window">
        <span class="codicon codicon-remote" />
      </div>
      <div v-if="scm.branch" class="statusbar-item" :title="`${scm.branch} (Git)`">
        <span class="codicon codicon-source-control" />
        <span>{{ branchLabel }}</span>
      </div>
      <div class="statusbar-item" title="No Problems">
        <span class="codicon codicon-error" />
        <span>0</span>
        <span class="codicon codicon-warning" />
        <span>0</span>
      </div>
    </div>
    <div class="statusbar-right">
      <template v-if="fileTab">
        <div class="statusbar-item">
          <span>Ln {{ editors.cursor.line }}, Col {{ editors.cursor.col }}</span>
        </div>
        <div class="statusbar-item">
          <span>Spaces: {{ indentOf(fileTab.path) }}</span>
        </div>
        <div class="statusbar-item"><span>UTF-8</span></div>
        <div class="statusbar-item"><span>LF</span></div>
        <div class="statusbar-item"><span>{{ languageLabel(fileTab.path) }}</span></div>
      </template>
      <div class="statusbar-item" title="No Notifications">
        <span class="codicon codicon-bell" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  background: var(--vscode-statusBar-background);
  color: var(--vscode-statusBar-foreground);
  font-size: 12px;
  flex-shrink: 0;
  overflow: hidden;
}
.statusbar-left,
.statusbar-right {
  display: flex;
  align-items: center;
  height: 100%;
}
.statusbar-left {
  padding-left: 2px;
}
.statusbar-right {
  padding-right: 2px;
}
.statusbar-item {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 100%;
  padding: 0 5px;
  cursor: pointer;
  white-space: nowrap;
}
.statusbar-item:hover {
  background: var(--vscode-statusBarItem-hoverBackground);
}
.statusbar-item .codicon {
  font-size: 14px;
}
</style>
