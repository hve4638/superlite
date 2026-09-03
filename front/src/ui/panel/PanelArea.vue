<script setup lang="ts">
import { ref } from 'vue';
import { togglePanel } from '../../model/workbench';
import { terminals, createTerminal, disposeTerminal } from '../../model/terminal';
import { activeSessionEmpty } from '../../model/sessions';
import TerminalPane from './TerminalPane.vue';
import { onTermDragEnd, onTermDragStart, terminalDraggable } from './termDnd';

type PanelTab = 'problems' | 'output' | 'debug' | 'terminal';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'debug', label: 'Debug Console' },
  { id: 'terminal', label: 'Terminal' },
];

const activeTab = ref<PanelTab>('terminal');

function killActiveTerminal() {
  // 마지막 터미널이면 disposeTerminal 이 패널까지 닫는다 (model 합류점)
  disposeTerminal(terminals.activeId);
}
</script>

<template>
  <div class="panel-area">
    <div class="panel-title">
      <div class="panel-tabs">
        <div
          v-for="tab in TABS"
          :key="tab.id"
          class="panel-tab"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <span class="tab-label">{{ tab.label }}</span>
        </div>
      </div>
      <div v-if="activeTab === 'terminal'" class="title-actions">
        <!-- 활성 터미널의 라벨 — 끌어서 다른 창으로/창 밖(새 창)으로 옮길 수 있다 (termDnd) -->
        <span
          class="single-tab"
          :draggable="terminalDraggable() && terminals.activeId !== 0"
          @dragstart="onTermDragStart($event, terminals.activeId)"
          @dragend="onTermDragEnd($event)"
        >
          <span class="codicon codicon-terminal-bash" />
          <span class="single-tab-label">bash</span>
        </span>
        <!-- 빈 세션은 백엔드 연결이 없어 터미널을 만들 수 없다 -->
        <span
          v-if="!activeSessionEmpty()"
          class="action-icon codicon codicon-plus"
          title="New Terminal"
          @click="createTerminal()"
        />
        <span class="action-icon caret codicon codicon-chevron-down" title="Launch Profile..." />
        <span class="action-icon codicon codicon-split-horizontal" title="Split Terminal" />
        <span
          class="action-icon codicon codicon-trash"
          title="Kill Terminal"
          @click="killActiveTerminal()"
        />
        <span class="action-icon codicon codicon-ellipsis" title="Views and More Actions..." />
        <span class="action-separator" />
        <span class="action-icon codicon codicon-screen-full" title="Maximize Panel Size" />
        <span class="action-icon codicon codicon-close" title="Hide Panel" @click="togglePanel()" />
      </div>
    </div>
    <div class="panel-content">
      <TerminalPane v-show="activeTab === 'terminal'" />
      <div v-show="activeTab === 'problems'" class="problems-message">
        No problems have been detected in the workspace.
      </div>
      <div v-show="activeTab === 'output' || activeTab === 'debug'" class="empty-view" />
    </div>
  </div>
</template>

<style scoped>
.panel-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-panel-background);
}
.panel-title {
  display: flex;
  align-items: center;
  height: 35px;
  flex-shrink: 0;
  padding: 0 8px;
  border-top: 1px solid var(--vscode-panel-border);
}
.panel-tabs {
  display: flex;
  align-items: center;
  height: 100%;
}
.panel-tab {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 10px;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--vscode-panelTitle-inactiveForeground);
  cursor: pointer;
}
.panel-tab:hover,
.panel-tab.active {
  color: var(--vscode-panelTitle-activeForeground);
}
.tab-label {
  line-height: 24px;
  border-bottom: 1px solid transparent;
}
.panel-tab.active .tab-label {
  border-bottom-color: var(--vscode-panelTitle-activeBorder);
}
.title-actions {
  display: flex;
  align-items: center;
  margin-left: auto;
}
.single-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-right: 8px;
  color: var(--vscode-foreground);
}
.single-tab .codicon {
  font-size: 16px;
}
.single-tab-label {
  font-size: 11px;
}
.action-icon {
  font-size: 16px;
  padding: 3px;
  margin-right: 4px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--vscode-foreground);
}
.action-icon:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
/* WHY: + 와 프로필 드롭다운 캐럿은 레퍼런스처럼 한 덩어리(split button)로 붙인다 */
.action-icon.codicon-plus {
  margin-right: 0;
}
.action-icon.caret {
  font-size: 12px;
  padding: 3px 0;
}
.action-separator {
  width: 1px;
  height: 16px;
  margin: 0 9px 0 5px;
  background: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
}
.panel-content {
  flex: 1;
  min-height: 0;
  position: relative;
}
.panel-content > * {
  height: 100%;
}
.problems-message {
  padding-left: 20px;
  line-height: 22px;
  font-size: 13px;
}
</style>
