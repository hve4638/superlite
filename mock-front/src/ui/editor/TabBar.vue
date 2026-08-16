<script setup lang="ts">
import type { EditorGroup, Tab } from '../../model/editors';
import { closeTab, setActiveTab, splitActiveEditor } from '../../model/editors';
import FileIcon from '../widgets/FileIcon.vue';

const props = defineProps<{ group: EditorGroup }>();

function iconName(tab: Tab): string {
  // diff 탭 이름은 "x (Working Tree)" 라서 아이콘은 실제 파일명으로 찾는다
  return tab.path.slice(tab.path.lastIndexOf('/') + 1);
}

function onClose(tabId: string) {
  closeTab(props.group.id, tabId);
}
</script>

<template>
  <div class="tabbar">
    <div class="tabs">
      <div
        v-for="tab in group.tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === group.activeTabId, dirty: tab.dirty, preview: tab.preview }"
        :title="tab.path"
        @click="setActiveTab(group.id, tab.id)"
        @mousedown.middle.prevent="onClose(tab.id)"
      >
        <FileIcon :name="iconName(tab)" />
        <span class="tab-label">{{ tab.name }}</span>
        <span class="tab-actions">
          <span class="tab-action" @click.stop="onClose(tab.id)">
            <span class="codicon codicon-close" />
            <span v-if="tab.dirty" class="codicon codicon-circle-filled" />
          </span>
        </span>
      </div>
    </div>
    <div class="group-actions">
      <span class="group-action" title="Split Editor Right (Ctrl+\)" @click="splitActiveEditor()">
        <span class="codicon codicon-split-horizontal" />
      </span>
      <span class="group-action" title="More Actions...">
        <span class="codicon codicon-ellipsis" />
      </span>
    </div>
  </div>
</template>

<style scoped>
.tabbar {
  position: relative;
  display: flex;
  height: 35px;
  flex-shrink: 0;
  background: var(--vscode-editorGroupHeader-tabsBackground);
}
/* WHY: VS Code 는 탭바 하단 1px 라인을 overlay(z9)로 깔고 active 탭이 z10 으로 덮는다 */
.tabbar::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 1px;
  background: var(--vscode-editorGroupHeader-tabsBorder);
  z-index: 9;
  pointer-events: none;
}
.tabs {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.tabs::-webkit-scrollbar {
  display: none;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  height: 35px;
  padding-left: 10px;
  flex-shrink: 0;
  border-right: 1px solid var(--vscode-tab-border);
  background: var(--vscode-tab-inactiveBackground);
  color: var(--vscode-tab-inactiveForeground);
  cursor: pointer;
}
.tab.active {
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-tab-activeForeground);
}
.tab.active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--vscode-tab-activeBorderTop);
  z-index: 6;
}
.tab.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--vscode-tab-activeBorder);
  z-index: 10;
}
.tab-label {
  font-size: 13px;
  line-height: 35px;
  /* WHY: VS Code monaco-icon-label 은 아이콘 16px + padding-right 6px */
  margin-left: 6px;
  white-space: nowrap;
}
.tab.preview .tab-label {
  font-style: italic;
}
.tab-actions {
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tab-action {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
}
.tab-action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.tab-action .codicon {
  font-size: 16px;
}
/* 닫기 버튼: active 탭은 항상, inactive 탭은 hover 시에만 */
.tab:not(.dirty):not(.active):not(:hover) .codicon-close {
  visibility: hidden;
}
/* dirty 탭: ● 표시, 버튼에 hover 하면 × 로 교체 */
.codicon-circle-filled {
  display: none;
}
.tab.dirty .codicon-close {
  display: none;
}
.tab.dirty .codicon-circle-filled {
  display: block;
}
.tab.dirty .tab-action:hover .codicon-close {
  display: block;
}
.tab.dirty .tab-action:hover .codicon-circle-filled {
  display: none;
}
.group-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 8px;
  gap: 4px;
}
.group-action {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  cursor: pointer;
  color: var(--vscode-foreground);
}
.group-action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
</style>
