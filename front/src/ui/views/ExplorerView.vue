<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { files, parentOf, revealPath, toAbsPath, visibleNodes, toggleDir, type TreeNode } from '../../model/files';
import { activeTab, editors, openFile } from '../../model/editors';
import { openFolder } from '../../model/host';
import { createDir, createFile, deleteEntry, renameEntry, saveClipboardImage, undoFileOp } from '../../model/fileops';
import { decorationFor } from '../../model/scm';
import { DND_FILE, activeSessionEmpty, multiWindow, remoteHost, sessionRoot, sessions } from '../../model/sessions';
import { windowLabel } from '../../model/window';
import { downloadEntry, uploadDropped, type DroppedEntry } from '../../model/transfer';
import { connection } from '../../model/watch';
import { openContextMenu, openQuickInput, workbench, type ContextMenuItem } from '../../model/workbench';
import { endEditorDrag, startFileDrag } from '../editor/tabDnd';
import FileIcon from '../widgets/FileIcon.vue';
import InlineNameInput from '../widgets/InlineNameInput.vue';
import ConfirmDialog from '../widgets/ConfirmDialog.vue';
import ProgressBar from '../widgets/ProgressBar.vue';

type EditMode = 'createFile' | 'createDir' | 'rename';
interface Editing {
  mode: EditMode;
  /** 입력이 속한 디렉토리 ('' = 루트) */
  dir: string;
  /** rename 대상의 원래 경로 */
  path?: string;
  initial: string;
}

/** 빈 세션의 'Open Folder' — 경로 입력 퀵인풋 (시작 페이지와 동일) */
function openDefault(): void {
  openQuickInput('folder');
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

/** 원격(ssh) 세션인가 — Download 메뉴·드롭 업로드는 원격에서만 (VS Code 원격 탐색기와 동일) */
const isRemote = computed(() => remoteHost(sessionRoot(sessions.activeId) ?? '') !== null);

function menuFor(node: TreeNode): ContextMenuItem[] {
  return [
    // 폴더 행 — 그 폴더를 root 로 하는 새 세션 탭 (이미 열린 세션이면 포커스만, 원격이면 그 호스트의 경로)
    ...(node.kind === 'directory'
      ? [{ label: 'Open in New Session', run: () => openFolder(toAbsPath(node.path, workbench.rootPath)) }, { separator: true }]
      : []),
    { label: 'New File...', run: () => void startCreate('createFile', node) },
    { label: 'New Folder...', run: () => void startCreate('createDir', node) },
    { separator: true },
    { label: 'Cut', keybinding: 'Ctrl+X', enabled: false },
    { label: 'Copy', keybinding: 'Ctrl+C', enabled: false },
    { label: 'Copy Path', keybinding: 'Shift+Alt+C', run: () => void navigator.clipboard.writeText(node.path) },
    ...(isRemote.value
      ? [{ separator: true }, { label: 'Download...', run: () => void downloadEntry(node.path, node.kind) }]
      : []),
    { separator: true },
    { label: 'Rename...', keybinding: 'F2', run: () => startRename(node) },
    { label: 'Delete', keybinding: 'Delete', run: () => (confirming.value = node) },
  ];
}

const BACKGROUND_MENU: ContextMenuItem[] = [
  { label: 'New File...', run: () => void startCreate('createFile', null) },
  { label: 'New Folder...', run: () => void startCreate('createDir', null) },
];

/** 디렉토리 twistie — 펼침 chevron, 로드가 800ms 를 넘기면 스피너 (VS Code tree-item-loading) */
function twistieClass(node: TreeNode): string {
  if (files.slowDirs.has(node.path)) return 'codicon-loading codicon-modifier-spin loading';
  return files.expanded.has(node.path) ? 'codicon-chevron-down' : 'codicon-chevron-right';
}

function onRowClick(node: TreeNode): void {
  files.selectedPath = node.path;
  if (node.kind === 'directory') {
    void toggleDir(node);
  } else {
    // focus:false — 단일 클릭은 포커스가 트리에 남아야 Delete/F2 가 파일 조작으로 이어진다
    void openFile(node.path, { preview: true, focus: false });
  }
}

function onRowDblClick(node: TreeNode): void {
  if (node.kind === 'file') void openFile(node.path);
}

// 파일·폴더 행을 에디터 영역으로 끌기 — 드롭 처리(열기/분할)는 에디터 쪽 드롭 존이 한다.
// 폴더는 폴더 탭(yazi 식 탐색 화면)으로 열린다 (explorer-folder-tab)
function onRowDragStart(e: DragEvent, node: TreeNode): void {
  const kind = node.kind === 'directory' ? 'folder' : 'file';
  e.dataTransfer?.setData('text/plain', node.path);
  // 다른 창의 편집기 영역이 같은 root 세션에서 열 수 있게 — 출처 창·root·경로 (cross-window-editor-drop)
  if (multiWindow()) {
    e.dataTransfer?.setData(DND_FILE, JSON.stringify({ window: windowLabel, root: sessionRoot(sessions.activeId), path: node.path, kind }));
  }
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  startFileDrag(node.path, kind);
}

function onRowContextMenu(node: TreeNode, e: MouseEvent): void {
  files.selectedPath = node.path;
  openContextMenu(e.clientX, e.clientY, menuFor(node));
}

function onTreeContextMenu(e: MouseEvent): void {
  openContextMenu(e.clientX, e.clientY, BACKGROUND_MENU);
}

// ---- OS 드롭 업로드 (원격 세션의 트리 = data-upload-zone, osdrop 의 "열기" 처리가 비켜 준다).
// 대상 폴더: 폴더 행은 그 폴더, 파일 행은 그 부모, 행 밖은 루트. VS Code 처럼 대상 폴더 행을 강조
/** 드래그 중 대상 폴더 ('' = 루트, null = 드래그 아님) */
const dropDir = ref<string | null>(null);
/** 덮어쓰기 확인 — 같은 이름의 최상위 항목이 이미 있을 때 (resolve 로 답한다) */
const replaceAsk = ref<{ names: string[]; resolve: (ok: boolean) => void } | null>(null);

const dirOf = (node: TreeNode): string => (node.kind === 'directory' ? node.path : parentOf(node.path));

function onDragOver(e: DragEvent, dir: string): void {
  if (!isRemote.value || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  dropDir.value = dir;
}

function onTreeDragLeave(e: DragEvent): void {
  // 자식 사이 이동에도 dragleave 가 온다 — 트리 밖으로 나갈 때만 강조를 지운다
  if (!treeEl.value?.contains(e.relatedTarget as Node | null)) dropDir.value = null;
}

function onDrop(e: DragEvent, dir: string): void {
  if (!isRemote.value || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.stopPropagation();
  dropDir.value = null;
  // WHY: 항목 접근은 드롭 이벤트 안에서만 유효하다 — 동기로 뽑아 넘긴다 (entry 가 없으면 File 로)
  const entries = [...e.dataTransfer.items]
    .filter((it) => it.kind === 'file')
    .map((it) => it.webkitGetAsEntry() ?? it.getAsFile())
    .filter((en): en is DroppedEntry => en !== null);
  void uploadDropped(dir, entries, (names) => new Promise((resolve) => (replaceAsk.value = { names, resolve })));
}

function answerReplace(ok: boolean): void {
  replaceAsk.value?.resolve(ok);
  replaceAsk.value = null;
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

const treeEl = ref<HTMLElement | null>(null);

/**
 * 가상 스크롤 — 보이는 행(+여유)만 DOM 에 둔다. 행 높이는 고정 22px (spec) 이라 위치 계산이
 * 산술이다. WHY: 큰 디렉토리(수만 항목)를 펼치면 전체 렌더가 메인 스레드를 수 초 잠갔다 —
 * VS Code 탐색기도 가상 리스트다. 상단 오프셋은 transform 으로 (레이아웃 재계산 없음)
 */
const ROW_H = 22;
const OVERSCAN = 10;
const scrollTop = ref(0);
const viewportH = ref(0);
const win = computed(() => {
  const total = rows.value.length;
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop.value + viewportH.value) / ROW_H) + OVERSCAN);
  return { start, rows: rows.value.slice(start, end), total };
});
function onTreeScroll(): void {
  scrollTop.value = treeEl.value?.scrollTop ?? 0;
}
let treeRo: ResizeObserver | null = null;
onMounted(() => {
  const el = treeEl.value;
  if (!el) return;
  viewportH.value = el.clientHeight;
  treeRo = new ResizeObserver(() => (viewportH.value = el.clientHeight));
  treeRo.observe(el);
});
onBeforeUnmount(() => treeRo?.disconnect());

// 활성 편집기를 트리에 드러낸다 (VS Code explorer.autoReveal). 탐색기가 나중에 열려도
// immediate 로 그 시점의 활성 탭을 잡는다. 선택 행이 뷰포트 밖이면 스크롤한다
watch(
  () => activeTab()?.path ?? null,
  async (path) => {
    if (!path) return;
    await revealPath(path);
    const el = treeEl.value;
    const i = rows.value.findIndex((r) => r.node?.path === path);
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 2));
    }
  },
  { immediate: true },
);

/** 행 밖(빈 영역) 클릭 판정 — 가상 스크롤 래퍼가 있어 .self 로는 잡히지 않는다 */
function outsideRows(e: Event): boolean {
  return (e.target as HTMLElement).closest('.row') === null;
}

/**
 * 트리 포커스 한정 붙여넣기 — 클립보드 이미지를 선택 위치에 파일로 저장 (텍스트 등은 무시).
 * WHY: 터미널과 같은 방침으로 navigator.clipboard.read()(권한 프롬프트) 대신 네이티브
 *      paste 이벤트를 쓴다. tabindex div 는 편집 가능 요소가 아니라 paste 가 요소로
 *      배달되지 않으므로 window 에서 받아 activeElement 로 판정한다.
 */
function onPaste(e: ClipboardEvent): void {
  if (editing.value || confirming.value) return; // 인라인 입력·다이얼로그의 붙여넣기는 건드리지 않는다
  const tree = treeEl.value;
  if (!tree || !(document.activeElement && tree.contains(document.activeElement))) return;
  const item = [...(e.clipboardData?.items ?? [])].find(
    (i) => i.kind === 'file' && i.type.startsWith('image/'),
  );
  const blob = item?.getAsFile();
  if (!blob) return;
  e.preventDefault();
  void pasteImage(blob);
}

async function pasteImage(blob: Blob): Promise<void> {
  // 대상 디렉토리는 새 파일 생성과 같은 규칙 — 선택이 폴더면 그 안, 파일이면 부모, 없으면 루트
  const sel = files.selectedPath !== null
    ? visibleNodes().find((n) => n.path === files.selectedPath) ?? null
    : null;
  const dir = sel === null ? '' : sel.kind === 'directory' ? sel.path : parentOf(sel.path);
  const saved = await saveClipboardImage(dir, blob); // 실패는 model 이 notify 한다
  if (saved !== null) files.selectedPath = saved;
}

onMounted(() => window.addEventListener('paste', onPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));

function decoColor(node: TreeNode): string | undefined {
  const deco = decorationFor(node.path, node.kind === 'directory');
  return deco ? `var(${deco.color})` : undefined;
}

// 폴더 pane 헤더는 사이드바 제목에 병합됐다 (VS Code merged-header — 제목이 워크스페이스명) —
// 새 파일·새 폴더는 인라인 입력 상태가 여기 살아 SideBar 의 제목 액션이 이 둘을 부른다
defineExpose({
  newFile: () => void startCreate('createFile', null),
  newFolder: () => void startCreate('createDir', null),
});
</script>

<template>
  <div class="explorer-view">
    <!-- 빈 세션(루트 없음) — 트리 대신 폴더 열기 안내 (VS Code 'No Folder Opened' 뷰) -->
    <div v-if="activeSessionEmpty()" class="no-folder">
      <p>You have not yet opened a folder.</p>
      <button class="no-folder-open" @click="openDefault()">Open Folder</button>
    </div>
    <div v-else class="explorer-pane">
      <!-- 루트 첫 로드 중 — 사이드바 제목 아래 2px 에 겹치는 무한 진행선 (VS Code 뷰 progress) -->
      <ProgressBar v-if="files.loading && !connection.error" />
      <!-- 영구 접속 실패(원격 ssh) — 재연결하지 않으므로 사유를 보인다. 재접속은 탭을 다시 여는 것 -->
      <div v-if="connection.error" class="conn-error">
        <span class="codicon codicon-error" />
        <span>{{ connection.error }}</span>
      </div>
      <div
        ref="treeEl"
        class="tree"
        :class="{ 'drop-root': dropDir === '' }"
        :data-upload-zone="isRemote ? '' : undefined"
        tabindex="0"
        @keydown="onTreeKeydown"
        @scroll.passive="onTreeScroll"
        @dragover="onDragOver($event, '')"
        @dragleave="onTreeDragLeave"
        @drop="onDrop($event, '')"
        @click="outsideRows($event) && (files.selectedPath = null)"
        @contextmenu="outsideRows($event) && (($event.preventDefault(), onTreeContextMenu($event)))"
      >
        <div class="tree-inner" :style="{ height: `${win.total * ROW_H}px` }">
        <div class="tree-window" :style="{ transform: `translateY(${win.start * ROW_H}px)` }">
        <template v-for="row in win.rows" :key="row.node?.path ?? '__edit'">
          <!-- rename 중인 행 — 라벨 자리에 인라인 입력 -->
          <div
            v-if="row.node && isRenaming(row.node)"
            class="row editing"
            :style="{ paddingLeft: `${row.node.depth * 8}px` }"
          >
            <span
              v-if="row.node.kind === 'directory'"
              class="twistie codicon"
              :class="twistieClass(row.node)"
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
            :class="{
              selected: files.selectedPath === row.node.path,
              'drop-target': row.node.kind === 'directory' && dropDir === row.node.path,
            }"
            :style="{ paddingLeft: `${row.node.depth * 8}px` }"
            draggable="true"
            @dragstart="onRowDragStart($event, row.node)"
            @dragend="endEditorDrag()"
            @dragover="onDragOver($event, dirOf(row.node))"
            @drop="onDrop($event, dirOf(row.node))"
            @click="onRowClick(row.node)"
            @dblclick="onRowDblClick(row.node)"
            @contextmenu.prevent="onRowContextMenu(row.node, $event)"
          >
            <span
              v-if="row.node.kind === 'directory'"
              class="twistie codicon"
              :class="twistieClass(row.node)"
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
      </div>
    </div>
    <template v-if="!activeSessionEmpty()">
      <div class="pane-header collapsed">
        <span class="codicon codicon-chevron-right twisty" />
        <span class="title">Outline</span>
      </div>
      <div class="pane-header collapsed">
        <span class="codicon codicon-chevron-right twisty" />
        <span class="title">Timeline</span>
      </div>
    </template>
    <ConfirmDialog
      v-if="confirming"
      :message="confirmMessage.message"
      :detail="confirmMessage.detail"
      confirm-label="Delete"
      @confirm="onConfirmDelete"
      @cancel="confirming = null"
    />
    <ConfirmDialog
      v-if="replaceAsk"
      :message="`${replaceAsk.names.length === 1 ? `'${replaceAsk.names[0]}' already exists` : `${replaceAsk.names.length} items already exist`} in the destination. Do you want to replace?`"
      detail="Files with the same names will be overwritten. Other files in existing folders are kept."
      confirm-label="Replace"
      @confirm="answerReplace(true)"
      @cancel="answerReplace(false)"
    />
  </div>
</template>

<style scoped>
.no-folder {
  padding: 12px 16px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.no-folder-open {
  padding: 5px 0;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  font-size: 13px;
  cursor: pointer;
}
.no-folder-open:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.explorer-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.explorer-pane {
  position: relative; /* 진행선 기준 */
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ===== pane header (Outline·Timeline 스텁 — spec .pane-header: 22px, 11px/700, bg #181818) ===== */
.conn-error {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--vscode-errorForeground);
  word-break: break-all;
}
.conn-error .codicon {
  flex: none;
  font-size: 16px;
}
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
.pane-header .title {
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== file tree ===== */
.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  outline: none; /* tabindex 포커스 링 억제 — VS Code 트리도 컨테이너 링이 없다 */
}
.tree-inner {
  position: relative;
  /* 마지막 행 아래 여백 — 끝까지 스크롤해도 행이 바닥에 붙지 않게 (사용자 요청 2026-09-07) */
  padding-bottom: 32px;
}
.tree-window {
  will-change: transform;
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
/* OS 드롭 업로드 대상 강조 — 폴더 행은 배경, 루트(행 밖·루트 파일 위)는 트리 테두리 (VS Code 동일 감각) */
.row.drop-target {
  background: var(--vscode-list-dropBackground);
}
.tree.drop-root {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
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
/* 로드 스피너(.loading)는 base.css 의 codicon-modifier-spin 공용 규칙 (spec tree.css .codicon-tree-item-loading 상당) */
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
