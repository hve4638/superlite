<script setup lang="ts">
import { computed } from 'vue';
import type { EditorGroup } from '../../model/editors';
import { editors } from '../../model/editors';
import TabBar from './TabBar.vue';
import MonacoHost from './MonacoHost.vue';
import FileIcon from '../widgets/FileIcon.vue';

const props = defineProps<{ group: EditorGroup }>();

const active = computed(() => props.group.tabs.find((t) => t.id === props.group.activeTabId) ?? null);
// WHY: VS Code 는 diff 에디터에 breadcrumbs 를 표시하지 않는다
const crumbs = computed(() =>
  active.value && active.value.kind === 'file' ? active.value.path.split('/') : [],
);

function focusGroup() {
  editors.activeGroupId = props.group.id;
}

const SHORTCUTS = [
  { label: 'Show All Commands', keys: ['Ctrl', 'Shift', 'P'] },
  { label: 'Go to File', keys: ['Ctrl', 'P'] },
  { label: 'Toggle Terminal', keys: ['Ctrl', '`'] },
];
</script>

<template>
  <div class="editor-group" @mousedown="focusGroup">
    <template v-if="group.tabs.length">
      <TabBar :group="group" />
      <div v-if="crumbs.length" class="breadcrumbs">
        <template v-for="(seg, i) in crumbs" :key="i">
          <span v-if="i > 0" class="codicon codicon-chevron-right sep" />
          <span class="crumb">
            <FileIcon v-if="i === crumbs.length - 1" :name="seg" />
            <span class="crumb-label">{{ seg }}</span>
          </span>
        </template>
      </div>
      <MonacoHost :group="group" />
    </template>
    <div v-else class="watermark">
      <div class="watermark-grid">
        <template v-for="s in SHORTCUTS" :key="s.label">
          <span class="watermark-label">{{ s.label }}</span>
          <span class="watermark-keys">
            <template v-for="(k, i) in s.keys" :key="i">
              <span v-if="i > 0" class="key-sep">+</span>
              <span class="key">{{ k }}</span>
            </template>
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--vscode-editor-background);
}
.breadcrumbs {
  display: flex;
  align-items: center;
  height: 22px;
  flex-shrink: 0;
  /* WHY: VS Code 는 첫 항목 앞에 공백문자(' ')를 렌더한다 — 4px 로 근사 */
  padding-left: 4px;
  background: var(--vscode-breadcrumb-background);
  color: var(--vscode-breadcrumb-foreground);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
}
.crumb {
  display: flex;
  align-items: center;
  height: 22px;
  cursor: pointer;
}
.crumb:hover .crumb-label {
  color: var(--vscode-breadcrumb-focusForeground);
}
.crumb .file-icon {
  margin-right: 6px;
}
.breadcrumbs .sep {
  font-size: 16px;
  flex-shrink: 0;
  margin: 0 4px;
}
.watermark {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* VS Code watermark: 라벨 오른쪽 정렬 / 키 왼쪽 정렬 2열 */
.watermark-grid {
  display: grid;
  grid-template-columns: auto auto;
  column-gap: 24px;
  row-gap: 8px;
  align-items: center;
}
.watermark-label {
  text-align: right;
  color: var(--vscode-descriptionForeground);
  letter-spacing: 0.04em;
  font-size: 13px;
}
.watermark-keys {
  display: flex;
  align-items: center;
}
.key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 12px;
  padding: 3px 5px;
  margin: 0 2px;
  font-size: 11px;
  line-height: 10px;
  border-radius: 3px;
  color: var(--vscode-keybindingLabel-foreground);
  background: var(--vscode-keybindingLabel-background);
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
  box-shadow: inset 0 -1px 0 var(--vscode-keybindingLabel-border);
}
.key:first-child {
  margin-left: 0;
}
.key-sep {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
</style>
