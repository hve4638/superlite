<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EditorGroup, Tab } from '../../model/editors';
import { closeTab, editors, moveTabToGroup, openFile, pinTab, setActiveTab, splitActiveEditor } from '../../model/editors';
import { editorDrag, endEditorDrag, startTabDrag } from './tabDnd';
import FileIcon from '../widgets/FileIcon.vue';

const props = defineProps<{ group: EditorGroup }>();

function iconName(tab: Tab): string {
  // diff 탭 이름은 "x (Working Tree)" 라서 아이콘은 실제 파일명으로 찾는다
  return tab.path.slice(tab.path.lastIndexOf('/') + 1);
}

// 같은 이름의 탭이 그룹에 여럿이면 구분용 디렉토리 힌트를 붙인다 (VS Code 동일)
const descriptions = computed(() => {
  const byName = new Map<string, Tab[]>();
  for (const t of props.group.tabs) {
    byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  }
  const out = new Map<string, string>();
  for (const tabs of byName.values()) {
    if (tabs.length < 2) continue;
    for (const t of tabs) out.set(t.id, dirHint(t.path));
  }
  return out;
});

/** 경로의 디렉토리 부분을 짧게 — 루트 상대는 그대로, 절대 경로는 "D:\…\마지막폴더" 로 축약 */
function dirHint(path: string): string {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  if (dir === '') return '';
  const segs = dir.split('/');
  const winAbs = /^[a-zA-Z]:$/.test(segs[0]);
  if (!winAbs && segs[0] !== '') return dir;
  const sep = winAbs ? '\\' : '/';
  if (segs.length <= 2) return segs.join(sep);
  return `${segs[0]}${sep}…${sep}${segs[segs.length - 1]}`;
}

function onClose(tabId: string) {
  closeTab(props.group.id, tabId);
}

function onDragStart(e: DragEvent, tab: Tab) {
  // setData 는 Firefox 의 드래그 시작 요건 — 실제 식별은 tabDrag 모듈 상태로 한다
  e.dataTransfer?.setData('text/plain', tab.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  startTabDrag(props.group.id, tab.id);
}

// 탭 드래그의 삽입 지점 (탭 인덱스 기준) — 삽입선 표시와 드롭 위치에 쓴다
const dropIndex = ref<number | null>(null);

// 탭 위 드래그 — 좌/우 절반 기준으로 삽입 지점 결정 (VS Code 동일)
function onTabDragOver(e: DragEvent, i: number) {
  if (editorDrag.kind === 'none') return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  // 파일 드롭은 끝에 붙인다 — 삽입선 없이 드롭만 받는다
  if (editorDrag.kind !== 'tab') return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropIndex.value = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
}

// 탭 밖 빈 영역 — 끝에 삽입. 다른 그룹의 탭, 같은 그룹의 순서 변경, 탐색기 파일 모두 받는다
function onTabsDragOver(e: DragEvent) {
  if (editorDrag.kind === 'none') return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (editorDrag.kind === 'tab') dropIndex.value = props.group.tabs.length;
}

function onTabsDrop(e: DragEvent) {
  if (editorDrag.kind === 'none') return;
  e.preventDefault();
  if (editorDrag.kind === 'tab') {
    moveTabToGroup(editorDrag.groupId, editorDrag.tabId, props.group.id, dropIndex.value ?? undefined);
  } else {
    void openFile(editorDrag.path, { groupId: props.group.id });
  }
  dropIndex.value = null;
  endEditorDrag();
}
</script>

<template>
  <div class="tabbar">
    <div class="tabs" @dragover="onTabsDragOver" @dragleave="dropIndex = null" @drop="onTabsDrop">
      <div
        v-for="(tab, i) in group.tabs"
        :key="tab.id"
        class="tab"
        :class="{
          active: tab.id === group.activeTabId,
          dirty: tab.dirty,
          preview: tab.preview,
          orphaned: editors.orphaned.has(tab.path),
          'drop-before': editorDrag.kind === 'tab' && dropIndex === i,
          'drop-after': editorDrag.kind === 'tab' && dropIndex === i + 1 && i === group.tabs.length - 1,
        }"
        :title="tab.path"
        draggable="true"
        @dragstart="onDragStart($event, tab)"
        @dragend="dropIndex = null; endEditorDrag()"
        @dragover="onTabDragOver($event, i)"
        @click="setActiveTab(group.id, tab.id)"
        @dblclick="pinTab(group.id, tab.id)"
        @mousedown.middle.prevent="onClose(tab.id)"
      >
        <FileIcon :name="iconName(tab)" />
        <span class="tab-label">{{ tab.name }}</span>
        <span v-if="descriptions.get(tab.id)" class="tab-description">{{ descriptions.get(tab.id) }}</span>
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
/* 이름 중복 구분 힌트 — VS Code label-description 상당 (작고 흐리게) */
.tab-description {
  margin-left: 6px;
  font-size: 11px;
  line-height: 35px;
  white-space: nowrap;
  opacity: 0.7;
}
/* 외부 삭제된 파일 — 라벨 취소선 (VS Code monaco-icon-label.strikethrough 동일) */
.tab.orphaned .tab-label {
  text-decoration: line-through;
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
/* 탭 드래그 삽입선 — box-shadow 라 레이아웃이 밀리지 않는다 */
.tab.drop-before {
  box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
}
.tab.drop-after {
  box-shadow: inset -2px 0 0 var(--vscode-focusBorder);
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
