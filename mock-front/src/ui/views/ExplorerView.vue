<script setup lang="ts">
import { files, visibleNodes, toggleDir, type TreeNode } from '../../model/files';
import { openFile } from '../../model/editors';
import { decorationFor } from '../../model/scm';
import { workbench, openContextMenu, type ContextMenuItem } from '../../model/workbench';
import FileIcon from '../widgets/FileIcon.vue';

const noop = () => {};

// VS Code Explorer 컨텍스트 메뉴 구성 (run 은 전부 no-op mock)
const ROW_MENU: ContextMenuItem[] = [
  { label: 'New File...', run: noop },
  { label: 'New Folder...', run: noop },
  { separator: true },
  { label: 'Cut', keybinding: 'Ctrl+X', enabled: false },
  { label: 'Copy', keybinding: 'Ctrl+C', enabled: false },
  { label: 'Copy Path', keybinding: 'Shift+Alt+C', run: noop },
  { separator: true },
  { label: 'Rename...', keybinding: 'F2', run: noop },
  { label: 'Delete', keybinding: 'Delete', run: noop },
];

function onRowClick(node: TreeNode): void {
  files.selectedPath = node.path;
  if (node.kind === 'directory') {
    void toggleDir(node);
  } else {
    void openFile(node.path, { preview: true });
  }
}

function onRowDblClick(node: TreeNode): void {
  if (node.kind === 'file') void openFile(node.path);
}

function onRowContextMenu(node: TreeNode, e: MouseEvent): void {
  files.selectedPath = node.path;
  openContextMenu(e.clientX, e.clientY, ROW_MENU);
}

function decoColor(node: TreeNode): string | undefined {
  const deco = decorationFor(node.path, node.kind === 'directory');
  return deco ? `var(${deco.color})` : undefined;
}
</script>

<template>
  <div class="explorer-view">
    <div class="explorer-pane">
      <div class="pane-header">
        <span class="codicon codicon-chevron-down twisty" />
        <span class="title">{{ workbench.workspaceName }}</span>
        <div class="actions">
          <span class="codicon codicon-new-file" title="New File..." />
          <span class="codicon codicon-new-folder" title="New Folder..." />
          <span class="codicon codicon-refresh" title="Refresh Explorer" />
          <span class="codicon codicon-collapse-all" title="Collapse Folders in Explorer" />
        </div>
      </div>
      <div class="tree" @click.self="files.selectedPath = null">
        <div
          v-for="node in visibleNodes()"
          :key="node.path"
          class="row"
          :class="{ selected: files.selectedPath === node.path }"
          :style="{ paddingLeft: `${node.depth * 8}px` }"
          @click="onRowClick(node)"
          @dblclick="onRowDblClick(node)"
          @contextmenu.prevent="onRowContextMenu(node, $event)"
        >
          <span
            v-if="node.kind === 'directory'"
            class="twistie codicon"
            :class="files.expanded.has(node.path) ? 'codicon-chevron-down' : 'codicon-chevron-right'"
          />
          <!-- WHY: 파일 행은 twistie 폭 없이 8px 패딩만 갖는다 (spec: 파일명이 폴더명과 같은 x 에 정렬) -->
          <span v-else class="twistie leaf" />
          <FileIcon v-if="node.kind === 'file'" :name="node.name" />
          <span class="label" :style="{ color: decoColor(node) }">{{ node.name }}</span>
          <template v-if="decorationFor(node.path, node.kind === 'directory')">
            <span
              v-if="node.kind === 'directory'"
              class="badge dot codicon codicon-circle-filled"
              :style="{ color: decoColor(node) }"
            />
            <span v-else class="badge letter" :style="{ color: decoColor(node) }">
              {{ decorationFor(node.path, false)!.letter }}
            </span>
          </template>
        </div>
      </div>
    </div>
    <div class="pane-header collapsed">
      <span class="codicon codicon-chevron-right twisty" />
      <span class="title">Outline</span>
    </div>
    <div class="pane-header collapsed">
      <span class="codicon codicon-chevron-right twisty" />
      <span class="title">Timeline</span>
    </div>
  </div>
</template>

<style scoped>
.explorer-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.explorer-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ===== pane header (spec .pane-header: 22px, 11px/700, bg #181818) ===== */
.pane-header {
  display: flex;
  align-items: center;
  height: 22px;
  flex-shrink: 0;
  background: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarSectionHeader-foreground);
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
}
.pane-header.collapsed {
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
}
.pane-header .twisty {
  font-size: 16px;
  margin: 0 2px;
  flex-shrink: 0;
}
/* WHY: paneview.css — 펼쳐진 헤더의 chevron 은 1px 내려 그린다 */
.pane-header:not(.collapsed) .twisty {
  transform: translateY(1px);
}
.pane-header .title {
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pane-header .actions {
  display: none;
  margin-left: auto;
  margin-right: 8px;
}
/* WHY: VS Code 는 pane 전체 hover 시 헤더 액션을 노출한다 (paneview.css .pane:hover > .pane-header > .actions) */
.explorer-pane:hover .actions {
  display: flex;
}
.pane-header .actions .codicon {
  font-size: 16px;
  padding: 2px;
  margin-right: 4px;
  border-radius: 5px;
}
.pane-header .actions .codicon:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* ===== file tree ===== */
.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.row {
  display: flex;
  align-items: center;
  height: 22px;
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
  white-space: nowrap;
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row.selected {
  background: var(--vscode-list-inactiveSelectionBackground);
}
/* spec .monaco-tl-twistie: 16px 아이콘 + 합 30px 박스.
   WHY: 레퍼런스 렌더에서 chevron 글리프가 박스 좌측 기준 +10px 에 있어 (rect x=51)
        패딩을 10/4 로 나눠 스크린샷 픽셀 위치를 맞춘다 (라벨 x=78 은 유지). */
.row .twistie {
  width: 30px;
  padding: 0 4px 0 10px;
  font-size: 16px;
  flex-shrink: 0;
}
/* 파일 행 twistie 는 폭 0 + 좌측 8px 패딩만 (spec: 파일 아이콘이 폴더 chevron 아래 정렬) */
.row .twistie.leaf {
  width: 8px;
  padding: 0;
}
.row .file-icon {
  margin-right: 6px;
}
.row .label {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* git 데코 배지 (iconlabel.css ::after / decorationsService bubble 수치) */
.row .badge {
  margin-left: auto;
  flex-shrink: 0;
}
.row .badge.letter {
  font-size: 90%;
  font-weight: 600;
  opacity: 0.75;
  margin-right: 16px;
  padding-left: 5px;
}
.row .badge.dot {
  font-size: 14px;
  opacity: 0.4;
  margin-right: 14px;
  padding-left: 5px;
}
</style>
