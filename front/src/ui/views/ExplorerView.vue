<script setup lang="ts">
import { computed, ref } from 'vue';
import { collapseAll, files, parentOf, refreshTree, visibleNodes, toggleDir, type TreeNode } from '../../model/files';
import { editors, openFile } from '../../model/editors';
import { createDir, createFile, deleteEntry, renameEntry, undoFileOp } from '../../model/fileops';
import { decorationFor } from '../../model/scm';
import { workbench, openContextMenu, type ContextMenuItem } from '../../model/workbench';
import { endEditorDrag, startFileDrag } from '../editor/tabDnd';
import FileIcon from '../widgets/FileIcon.vue';
import InlineNameInput from '../widgets/InlineNameInput.vue';
import ConfirmDialog from '../widgets/ConfirmDialog.vue';

type EditMode = 'createFile' | 'createDir' | 'rename';
interface Editing {
  mode: EditMode;
  /** 입력이 속한 디렉토리 ('' = 루트) */
  dir: string;
  /** rename 대상의 원래 경로 */
  path?: string;
  initial: string;
}

const editing = ref<Editing | null>(null);
/** 백엔드 거부(동시 생성 등) — 입력을 남겨 정정 기회를 준다 */
const opError = ref<string | null>(null);
const confirming = ref<TreeNode | null>(null);

/** 트리 행 + (생성 중이면) 입력 행. 입력 행은 대상 디렉토리 바로 아래 — 정렬 위치는 커밋 후 리프레시가 잡는다 */
const rows = computed(() => {
  const out: Array<{ node?: TreeNode; inputDepth?: number }> = visibleNodes().map((n) => ({ node: n }));
  const ed = editing.value;
  if (!ed || ed.mode === 'rename') return out;
  if (ed.dir === '') {
    out.unshift({ inputDepth: 0 });
  } else {
    const i = out.findIndex((r) => r.node?.path === ed.dir);
    if (i !== -1) out.splice(i + 1, 0, { inputDepth: out[i].node!.depth + 1 });
  }
  return out;
});

function isRenaming(node: TreeNode): boolean {
  return editing.value?.mode === 'rename' && editing.value.path === node.path;
}

async function startCreate(mode: 'createFile' | 'createDir', node: TreeNode | null): Promise<void> {
  let dir = '';
  if (node) {
    if (node.kind === 'directory') {
      dir = node.path;
      if (!files.expanded.has(node.path)) await toggleDir(node); // 입력 행이 보이려면 펼쳐야 한다
    } else {
      dir = parentOf(node.path);
    }
  }
  opError.value = null;
  editing.value = { mode, dir, initial: '' };
}

function startRename(node: TreeNode): void {
  opError.value = null;
  editing.value = { mode: 'rename', dir: parentOf(node.path), path: node.path, initial: node.name };
}

/** VS Code explorer 검증 — 빈 이름/중복/부적합 문자. 생성은 a/b/c 중첩 허용, rename 은 불허 */
function validateName(value: string): string | null {
  const ed = editing.value;
  if (!ed) return null;
  const name = value.trim();
  if (!name) return 'A file or folder name must be provided.';
  const allowSlash = ed.mode !== 'rename';
  const segments = name.split('/');
  if (
    (!allowSlash && name.includes('/')) ||
    name.includes('\\') ||
    name.endsWith('/') ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    return `The name "${name}" is not valid as a file or folder name. Please choose a different name.`;
  }
  // 중복은 로드된 형제 기준 — 중첩 경로의 심층 중복은 백엔드(배타적 생성)가 최종 거부한다
  const first = segments[0];
  const dup = visibleNodes().some(
    (n) => parentOf(n.path) === ed.dir && n.path !== ed.path && n.name === first
      // 중첩 생성에서 첫 세그먼트가 기존 "디렉토리" 와 겹치는 건 정상 (그 안에 만든다)
      && !(ed.mode !== 'rename' && segments.length > 1 && n.kind === 'directory'),
  );
  if (dup) {
    return `A file or folder ${first} already exists at this location. Please choose a different name.`;
  }
  return null;
}

async function commitEdit(name: string): Promise<void> {
  const ed = editing.value;
  if (!ed) return;
  const target = ed.dir === '' ? name : `${ed.dir}/${name}`;
  try {
    if (ed.mode === 'rename') {
      if (target !== ed.path) await renameEntry(ed.path!, target);
      editing.value = null;
    } else if (ed.mode === 'createFile') {
      await createFile(target);
      editing.value = null;
      await openFile(target); // VS Code: 새 파일은 바로 연다
    } else {
      await createDir(target);
      // 새 폴더는 접힌 채 둔다 — expanded 에만 넣으면 children 미로드 모순 상태가 된다
      editing.value = null;
    }
    files.selectedPath = target;
  } catch (e) {
    opError.value = e instanceof Error ? e.message : String(e);
  }
}

function cancelEdit(): void {
  editing.value = null;
  opError.value = null;
}

const confirmMessage = computed(() => {
  const node = confirming.value;
  if (!node) return { message: '', detail: '' };
  const dirty = [...editors.docs].some(
    ([p, d]) => (p === node.path || p.startsWith(`${node.path}/`)) && d.content !== d.savedContent,
  );
  return {
    message: dirty
      ? `Are you sure you want to delete '${node.name}' with unsaved changes? Your changes will be lost.`
      : `Are you sure you want to permanently delete '${node.name}'${node.kind === 'directory' ? ' and its contents' : ''}?`,
    detail: 'This action is irreversible!',
  };
});

function onConfirmDelete(): void {
  const node = confirming.value;
  confirming.value = null;
  if (node) void deleteEntry(node.path, node.kind); // 실패는 model 이 notify 한다
}

function menuFor(node: TreeNode): ContextMenuItem[] {
  return [
    { label: 'New File...', run: () => void startCreate('createFile', node) },
    { label: 'New Folder...', run: () => void startCreate('createDir', node) },
    { separator: true },
    { label: 'Cut', keybinding: 'Ctrl+X', enabled: false },
    { label: 'Copy', keybinding: 'Ctrl+C', enabled: false },
    { label: 'Copy Path', keybinding: 'Shift+Alt+C', run: () => void navigator.clipboard.writeText(node.path) },
    { separator: true },
    { label: 'Rename...', keybinding: 'F2', run: () => startRename(node) },
    { label: 'Delete', keybinding: 'Delete', run: () => (confirming.value = node) },
  ];
}

const BACKGROUND_MENU: ContextMenuItem[] = [
  { label: 'New File...', run: () => void startCreate('createFile', null) },
  { label: 'New Folder...', run: () => void startCreate('createDir', null) },
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

// 파일 행을 에디터 영역으로 끌기 — 드롭 처리(이동/분할)는 에디터 쪽 드롭 존이 한다
function onRowDragStart(e: DragEvent, node: TreeNode): void {
  e.dataTransfer?.setData('text/plain', node.path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  startFileDrag(node.path);
}

function onRowContextMenu(node: TreeNode, e: MouseEvent): void {
  files.selectedPath = node.path;
  openContextMenu(e.clientX, e.clientY, menuFor(node));
}

function onTreeContextMenu(e: MouseEvent): void {
  openContextMenu(e.clientX, e.clientY, BACKGROUND_MENU);
}

/** 트리 포커스 한정 키 — F2/Delete/Ctrl+Z. 에디터의 같은 키와 충돌하지 않는다 */
function onTreeKeydown(e: KeyboardEvent): void {
  // 입력 행이 유실된 채 editing 만 남는 상태(대상 디렉토리 외부 소멸 등)의 탈출구
  if (e.key === 'Escape' && editing.value) {
    cancelEdit();
    return;
  }
  if (editing.value || confirming.value) return;
  const sel = files.selectedPath !== null
    ? visibleNodes().find((n) => n.path === files.selectedPath) ?? null
    : null;
  if (e.key === 'F2' && sel) {
    e.preventDefault();
    startRename(sel);
  } else if (e.key === 'Delete' && sel) {
    e.preventDefault();
    confirming.value = sel;
  } else if (e.key === 'z' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    // 스택 항목의 경로가 이후 조작으로 낡았을 수 있다 — 실패한 항목은 버려진다 (redo 없음)
    void undoFileOp(); // 실패는 model 이 notify 한다
  }
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
          <span class="codicon codicon-new-file" title="New File..." @click="startCreate('createFile', null)" />
          <span class="codicon codicon-new-folder" title="New Folder..." @click="startCreate('createDir', null)" />
          <span class="codicon codicon-refresh" title="Refresh Explorer" @click="refreshTree()" />
          <span class="codicon codicon-collapse-all" title="Collapse Folders in Explorer" @click="collapseAll()" />
        </div>
      </div>
      <div
        class="tree"
        tabindex="0"
        @keydown="onTreeKeydown"
        @click.self="files.selectedPath = null"
        @contextmenu.self.prevent="onTreeContextMenu($event)"
      >
        <template v-for="row in rows" :key="row.node?.path ?? '__edit'">
          <!-- rename 중인 행 — 라벨 자리에 인라인 입력 -->
          <div
            v-if="row.node && isRenaming(row.node)"
            class="row editing"
            :style="{ paddingLeft: `${row.node.depth * 8}px` }"
          >
            <span
              v-if="row.node.kind === 'directory'"
              class="twistie codicon"
              :class="files.expanded.has(row.node.path) ? 'codicon-chevron-down' : 'codicon-chevron-right'"
            />
            <span v-else class="twistie leaf" />
            <FileIcon v-if="row.node.kind === 'file'" :name="row.node.name" />
            <InlineNameInput
              :initial="row.node.name"
              :select-stem="row.node.kind === 'file'"
              :validate="validateName"
              :external-error="opError"
              @commit="commitEdit"
              @cancel="cancelEdit"
              @input="opError = null"
            />
          </div>
          <div
            v-else-if="row.node"
            class="row"
            :class="{ selected: files.selectedPath === row.node.path }"
            :style="{ paddingLeft: `${row.node.depth * 8}px` }"
            :draggable="row.node.kind === 'file'"
            @dragstart="onRowDragStart($event, row.node)"
            @dragend="endEditorDrag()"
            @click="onRowClick(row.node)"
            @dblclick="onRowDblClick(row.node)"
            @contextmenu.prevent="onRowContextMenu(row.node, $event)"
          >
            <span
              v-if="row.node.kind === 'directory'"
              class="twistie codicon"
              :class="files.expanded.has(row.node.path) ? 'codicon-chevron-down' : 'codicon-chevron-right'"
            />
            <!-- WHY: 파일 행은 twistie 폭 없이 8px 패딩만 갖는다 (spec: 파일명이 폴더명과 같은 x 에 정렬) -->
            <span v-else class="twistie leaf" />
            <FileIcon v-if="row.node.kind === 'file'" :name="row.node.name" />
            <span class="label" :style="{ color: decoColor(row.node) }">{{ row.node.name }}</span>
            <template v-if="decorationFor(row.node.path, row.node.kind === 'directory')">
              <span
                v-if="row.node.kind === 'directory'"
                class="badge dot codicon codicon-circle-filled"
                :style="{ color: decoColor(row.node) }"
              />
              <span v-else class="badge letter" :style="{ color: decoColor(row.node) }">
                {{ decorationFor(row.node.path, false)!.letter }}
              </span>
            </template>
          </div>
          <!-- 생성 입력 행 (ponytail: 파일 아이콘 실시간 반영 생략 — 커밋 후 리프레시가 그린다) -->
          <div v-else class="row editing" :style="{ paddingLeft: `${row.inputDepth! * 8}px` }">
            <span class="twistie leaf" />
            <InlineNameInput
              initial=""
              :validate="validateName"
              :external-error="opError"
              @commit="commitEdit"
              @cancel="cancelEdit"
              @input="opError = null"
            />
          </div>
        </template>
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
    <ConfirmDialog
      v-if="confirming"
      :message="confirmMessage.message"
      :detail="confirmMessage.detail"
      confirm-label="Delete"
      @confirm="onConfirmDelete"
      @cancel="confirming = null"
    />
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
/* 레퍼런스는 pane hover 시에만 노출하지만, 여기서는 항시 표시한다 (사용자 결정) */
.pane-header .actions {
  display: flex;
  margin-left: auto;
  margin-right: 8px;
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
  outline: none; /* tabindex 포커스 링 억제 — VS Code 트리도 컨테이너 링이 없다 */
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
/* 인라인 입력 행 — 에러 박스가 다음 행 위로 떠야 하므로 overflow 를 만들지 않는다 */
.row.editing {
  overflow: visible;
  cursor: default;
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
