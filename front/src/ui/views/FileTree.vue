<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { parentOf, type createFiles, type TreeNode } from '../../model/files';
import { activeTab, baseName, editors, openFile } from '../../model/editors';
import { openFolder } from '../../model/host';
import { createDir, createFile, deleteEntry, renameEntry, saveClipboardImage, transferEntries, undoFileOp } from '../../model/fileops';
import { decorationFor } from '../../model/scm';
import { DND_FILE, multiWindow, remoteHost, sessionRoot, sessions } from '../../model/sessions';
import { windowLabel } from '../../model/window';
import { downloadEntry, uploadDropped, type DroppedEntry } from '../../model/transfer';
import { openContextMenu, workbench, type ContextMenuItem } from '../../model/workbench';
import { editorDrag, endEditorDrag, startFileDrag } from '../editor/tabDnd';
import FileIcon from '../widgets/FileIcon.vue';
import InlineNameInput from '../widgets/InlineNameInput.vue';
import { confirm, confirming } from '../../model/dialog';
import { toAbsPath } from '../../model/files';

/**
 * 탐색기 트리 하나 — 메인 워크스페이스 트리와 추가 탐색기 섹션(ticket explorer-extra-roots)이 함께 쓴다.
 * 트리 상태(펼침·선택·로드)는 받은 인스턴스(tree)에 있고, 파일 조작(fileops)은 경로만 받으므로 어느
 * 트리에서 불러도 같다 — 섹션이 워크스페이스 안으로 제한되어 모든 경로가 루트 상대이기 때문이다
 * (사용자 결정 2026-09-14). 그래서 트리 사이의 드래그 이동·복사도 경로 변환 없이 그대로 성립한다.
 * primary 는 메인 트리 — 활성 편집기 autoReveal 은 여기서만 한다.
 */
const props = defineProps<{ tree: ReturnType<typeof createFiles>; primary?: boolean }>();

/** 이 트리의 루트 경로 (메인은 '', 섹션은 그 폴더의 루트 상대 경로) */
const base = computed(() => props.tree.base);
const files = computed(() => props.tree.files);

type EditMode = 'createFile' | 'createDir' | 'rename';
interface Editing {
  mode: EditMode;
  /** 입력이 속한 디렉토리 (트리 루트면 base) */
  dir: string;
  /** rename 대상의 원래 경로 */
  path?: string;
  initial: string;
}
const editing = ref<Editing | null>(null);
/** 백엔드 거부(동시 생성 등) — 입력을 남겨 정정 기회를 준다 */
const opError = ref<string | null>(null);

/** 조상이 같은 목록에 있는 경로를 뺀다 — 폴더와 그 안 항목을 함께 골랐을 때 조작은 폴더 한 번이면 된다 */
function topLevel(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)));
}

/** 확인 대화상자의 이름 목록 (VS Code getFileNamesMessage — 10개까지, 나머지는 개수만) */
function namesDetail(names: string[]): string {
  const MAX = 10;
  const lines = names.slice(0, MAX);
  if (names.length > MAX) lines.push(`...${names.length - MAX} additional files not shown`);
  return lines.join('\n');
}

/** 트리 행 + (생성 중이면) 입력 행. 입력 행은 대상 디렉토리 바로 아래 — 정렬 위치는 커밋 후 리프레시가 잡는다 */
const rows = computed(() => {
  const out: Array<{ node?: TreeNode; inputDepth?: number }> = props.tree.visibleNodes().map((n) => ({ node: n }));
  const ed = editing.value;
  if (!ed || ed.mode === 'rename') return out;
  if (ed.dir === base.value) {
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
  let dir = base.value;
  if (node) {
    if (node.kind === 'directory') {
      dir = node.path;
      if (!files.value.expanded.has(node.path)) await props.tree.toggleDir(node); // 입력 행이 보이려면 펼쳐야 한다
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
  const dup = props.tree.visibleNodes().some(
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
    props.tree.select(target);
  } catch (e) {
    opError.value = e instanceof Error ? e.message : String(e);
  }
}

function cancelEdit(): void {
  editing.value = null;
  opError.value = null;
}

/** 삭제 확인 — 한 번의 확인 뒤 순차 삭제 (VS Code 문구, 여럿이면 confirmMultiDelete / 미저장은 confirmDeleteDirtyMultiple) */
async function askDelete(nodes: TreeNode[]): Promise<void> {
  if (nodes.length === 0) return;
  const dirty = [...editors.docs].some(
    ([p, d]) => nodes.some((n) => p === n.path || p.startsWith(`${n.path}/`)) && d.content !== d.savedContent,
  );
  const ask = nodes.length === 1
    ? {
        message: dirty
          ? `Are you sure you want to delete '${nodes[0].name}' with unsaved changes? Your changes will be lost.`
          : `Are you sure you want to permanently delete '${nodes[0].name}'${nodes[0].kind === 'directory' ? ' and its contents' : ''}?`,
        detail: 'This action is irreversible!',
      }
    : {
        message: dirty
          ? 'You are deleting files with unsaved changes. Do you want to continue?'
          : `Are you sure you want to permanently delete the following ${nodes.length} files/directories and their contents?`,
        detail: `${namesDetail(nodes.map((n) => n.name))}\nThis action is irreversible!`,
      };
  if ((await confirm({ ...ask, confirmLabel: 'Delete' })) !== 'confirm') return;
  const top = new Set(topLevel(nodes.map((n) => n.path)));
  // 순차 — 실패는 model 이 notify 하고 다음 항목으로 (undo 는 항목별 스택)
  for (const n of nodes) if (top.has(n.path)) await deleteEntry(n.path, n.kind);
}

/** 원격(ssh) 세션인가 — Download 메뉴·드롭 업로드는 원격에서만 (VS Code 원격 탐색기와 동일) */
const isRemote = computed(() => remoteHost(sessionRoot(sessions.activeId) ?? '') !== null);

/** 행 메뉴 — 선택 집합(sel, 우클릭 행 포함)에 작용. 여럿이면 새 세션·Rename 은 빠지고 Copy Path 는 줄바꿈 나열,
 *  Download 는 차례로, Delete 는 한 번의 확인으로 전체 (VS Code 파리티) */
function menuFor(node: TreeNode, sel: TreeNode[]): ContextMenuItem[] {
  const multi = sel.length > 1;
  return [
    // 폴더 행 — 그 폴더를 root 로 하는 새 세션 탭 (이미 열린 세션이면 포커스만, 원격이면 그 호스트의 경로)
    ...(node.kind === 'directory' && !multi
      ? [{ label: 'Open in New Session', run: () => openFolder(toAbsPath(node.path, workbench.rootPath)) }, { separator: true }]
      : []),
    { label: 'New File...', run: () => void startCreate('createFile', node) },
    { label: 'New Folder...', run: () => void startCreate('createDir', node) },
    { separator: true },
    { label: 'Cut', keybinding: 'Ctrl+X', enabled: false },
    { label: 'Copy', keybinding: 'Ctrl+C', enabled: false },
    { label: 'Copy Path', run: () => void navigator.clipboard.writeText(sel.map((n) => n.path).join('\n')) },
    ...(isRemote.value
      ? [{ separator: true }, { label: 'Download... (D)', key: 'd', run: () => void downloadAll(sel) }]
      : []),
    { separator: true },
    { label: 'Rename...', keybinding: 'F2', enabled: !multi, run: () => startRename(node) },
    { label: 'Delete', keybinding: 'Delete', run: () => void askDelete(sel) },
  ];
}

async function downloadAll(nodes: TreeNode[]): Promise<void> {
  for (const n of nodes) await downloadEntry(n.path, n.kind);
}

const BACKGROUND_MENU: ContextMenuItem[] = [
  { label: 'New File...', run: () => void startCreate('createFile', null) },
  { label: 'New Folder...', run: () => void startCreate('createDir', null) },
];

/** 디렉토리 twistie — 펼침 chevron, 로드가 800ms 를 넘기면 스피너 (VS Code tree-item-loading) */
function twistieClass(node: TreeNode): string {
  if (files.value.slowDirs.has(node.path)) return 'codicon-loading codicon-modifier-spin loading';
  return files.value.expanded.has(node.path) ? 'codicon-chevron-down' : 'codicon-chevron-right';
}

function onRowClick(node: TreeNode, e: MouseEvent): void {
  // Ctrl = 토글, Shift = 앵커부터 범위 — 둘 다 펼침·열기 없이 선택만 바꾼다 (VS Code 트리)
  if (e.ctrlKey || e.metaKey) {
    props.tree.toggleSelect(node.path);
    return;
  }
  if (e.shiftKey) {
    props.tree.rangeSelect(node.path);
    return;
  }
  props.tree.select(node.path);
  if (node.kind === 'directory') {
    void props.tree.toggleDir(node);
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
// 선택 밖의 행을 끌면 그 행만 선택하고 끈다. 선택 집합(조상이 같이 선택된 항목은 뺀 것)은 editorDrag.paths 로
// 트리의 드롭(이동·복사)이 읽고, DND_FILE 에도 paths 로 실린다 (explorer-multiselect-dnd).
// 다른 트리(메인 ↔ 섹션, 섹션 ↔ 섹션)에 놓는 이동도 같은 경로 체계라 이 값 그대로 성립한다
function onRowDragStart(e: DragEvent, node: TreeNode): void {
  if (!files.value.selected.has(node.path)) props.tree.select(node.path);
  const paths = topLevel(props.tree.selectedNodes().map((n) => n.path));
  const kind = node.kind === 'directory' ? 'folder' : 'file';
  e.dataTransfer?.setData('text/plain', paths.join('\n'));
  // 다른 창의 편집기 영역이 같은 root 세션에서 열 수 있게 — 출처 창·root·경로 (cross-window-editor-drop)
  if (multiWindow()) {
    e.dataTransfer?.setData(DND_FILE, JSON.stringify({ window: windowLabel, root: sessionRoot(sessions.activeId), path: node.path, kind, paths }));
  }
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'; // Ctrl 드롭 = 복사
  setDragBadge(e, paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`);
  startFileDrag(node.path, kind, paths);
}

/** 커서 옆 파일명 배지 (VS Code monaco-drag-image) — 임시 요소를 body 에 붙여 setDragImage 하고 다음 프레임에 뗀다.
 *  WHY: setDragImage 는 호출 시점에 렌더된 요소만 받는다 — scoped 스타일이 안 닿아 아래 전역 style 블록에 둔다 */
function setDragBadge(e: DragEvent, label: string): void {
  if (!e.dataTransfer) return;
  const el = document.createElement('div');
  el.className = 'explorer-drag-badge';
  el.textContent = label;
  document.body.appendChild(el);
  e.dataTransfer.setDragImage(el, -10, -10);
  requestAnimationFrame(() => el.remove());
}

function onRowContextMenu(node: TreeNode, e: MouseEvent): void {
  // 선택 안에서 우클릭하면 선택 유지, 밖이면 그 행만 선택 (VS Code)
  if (!files.value.selected.has(node.path)) props.tree.select(node.path);
  openContextMenu(e.clientX, e.clientY, menuFor(node, props.tree.selectedNodes()));
}

function onTreeContextMenu(e: MouseEvent): void {
  openContextMenu(e.clientX, e.clientY, BACKGROUND_MENU);
}

// ---- OS 드롭 업로드 (원격 세션의 트리 = data-upload-zone, osdrop 의 "열기" 처리가 비켜 준다).
// 대상 폴더: 폴더 행은 그 폴더, 파일 행은 그 부모, 행 밖은 트리 루트. VS Code 처럼 대상 폴더 행을 강조
/** 드래그 중 대상 폴더 (null = 드래그 아님) */
const dropDir = ref<string | null>(null);
/** 덮어쓰기 확인 — 업로드는 충돌 이름을 모아 한 번, 드래그 이동·복사는 항목마다 (VS Code 문구) */
const askReplace = async (message: string, detail: string): Promise<boolean> =>
  (await confirm({ message, detail, confirmLabel: 'Replace' })) === 'confirm';

const dirOf = (node: TreeNode): string => (node.kind === 'directory' ? node.path : parentOf(node.path));

/** 대상 폴더의 영역 — 폴더 행 + 펼쳐져 보이는 서브트리 행 전부 (VS Code list.dropBackground). 접힌 폴더면 그 행만, 트리 루트는 outline 이 대신한다 */
const inDropRegion = (node: TreeNode): boolean =>
  dropDir.value !== null && (node.path === dropDir.value || node.path.startsWith(`${dropDir.value}/`));
/** 트리 루트가 드롭 대상인가 — 컨테이너 테두리로 보인다 */
const rootDrop = computed(() => dropDir.value !== null && dropDir.value === base.value);

// ---- 드래그 이동·복사 (explorer-multiselect-dnd) — 탐색기 행 드래그(editorDrag.paths)만. 출처가 다른
// 트리여도 경로 체계가 같아 그대로 받는다 (영역 간 이동, 2026-09-14). 자기 자신·자기 하위·이미 있는
// 부모로는 드롭 불가 (VS Code). Ctrl 을 누르고 놓으면 복사
/** 이 트리에 놓을 수 있는 행 드래그인가 — 절대 경로(워크스페이스 밖 폴더 탭)는 파일 조작 대상이 아니다 */
const treeDrag = (): boolean =>
  (editorDrag.kind === 'file' || editorDrag.kind === 'folder') && editorDrag.paths.length > 0
  && !editorDrag.paths.some((p) => p.startsWith('/') || /^[a-zA-Z]:/.test(p));

function canDropInto(dir: string): boolean {
  return editorDrag.paths.every((src) => dir !== src && !dir.startsWith(`${src}/`) && parentOf(src) !== dir);
}

function onDragOver(e: DragEvent, dir: string): void {
  if (treeDrag()) {
    e.stopPropagation();
    if (!canDropInto(dir)) {
      dropDir.value = null;
      return; // preventDefault 없음 = 놓을 수 없음 커서
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    dropDir.value = dir;
    return;
  }
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
  if (treeDrag()) {
    e.preventDefault();
    e.stopPropagation();
    dropDir.value = null;
    if (!canDropInto(dir)) return;
    void dropEntries([...editorDrag.paths], dir, e.ctrlKey ? 'copy' : 'move');
    return;
  }
  if (!isRemote.value || !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.stopPropagation();
  dropDir.value = null;
  // WHY: 항목 접근은 드롭 이벤트 안에서만 유효하다 — 동기로 뽑아 넘긴다 (entry 가 없으면 File 로)
  const entries = [...e.dataTransfer.items]
    .filter((it) => it.kind === 'file')
    .map((it) => it.webkitGetAsEntry() ?? it.getAsFile())
    .filter((en): en is DroppedEntry => en !== null);
  void uploadDropped(dir, entries, (names) => askReplace(
    `${names.length === 1 ? `'${names[0]}' already exists` : `${names.length} items already exist`} in the destination. Do you want to replace?`,
    'Files with the same names will be overwritten. Other files in existing folders are kept.',
  ));
}

/** 이동 확인 끄기 (VS Code explorer.confirmDragAndDrop) — 대화상자의 보조 버튼 "Move, Don't Ask Again" 이 세운다 (종전 체크박스 — OS 다이얼로그에 없다). 복사는 묻지 않는다 */
const DND_CONFIRM_KEY = 'superlite.explorer.confirmDragAndDrop';

async function dropEntries(paths: string[], dir: string, mode: 'move' | 'copy'): Promise<void> {
  if (mode === 'move' && localStorage.getItem(DND_CONFIRM_KEY) !== '0') {
    const dest = dir === '' ? baseName(workbench.rootPath.replace(/\\/g, '/')) : baseName(dir);
    const choice = await confirm({
      message: paths.length === 1
        ? `Are you sure you want to move '${baseName(paths[0])}' into '${dest}'?`
        : `Are you sure you want to move the following ${paths.length} files into '${dest}'?`,
      detail: paths.length === 1 ? undefined : namesDetail(paths.map(baseName)),
      confirmLabel: 'Move',
      secondaryLabel: "Move, Don't Ask Again",
    });
    if (choice === 'cancel') return;
    if (choice === 'secondary') localStorage.setItem(DND_CONFIRM_KEY, '0');
  }
  const done = await transferEntries(paths, dir, mode, (name) => askReplace(
    `A file or folder with the name '${name}' already exists in the destination folder. Do you want to replace it?`,
    'This action is irreversible!',
  ));
  // 선택은 옮겨진(복사된) 쪽으로 — 놓은 폴더가 펼쳐져 있어야 보인다 (접혀 있으면 집합에만 남는다)
  props.tree.select(done[0] ?? null);
  for (const p of done.slice(1)) files.value.selected.add(p);
}

/** 트리 포커스 한정 키 — F2/Delete/Ctrl+Z. 에디터의 같은 키와 충돌하지 않는다 */
function onTreeKeydown(e: KeyboardEvent): void {
  // 입력 행이 유실된 채 editing 만 남는 상태(대상 디렉토리 외부 소멸 등)의 탈출구
  if (e.key === 'Escape' && editing.value) {
    cancelEdit();
    return;
  }
  if (editing.value || confirming()) return;
  const vis = props.tree.visibleNodes();
  const sel = files.value.selectedPath !== null ? vis.find((n) => n.path === files.value.selectedPath) ?? null : null;
  const multi = props.tree.selectedNodes();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // ↑/↓ 포커스 이동(단일 선택), Shift+↑/↓ 는 앵커부터 범위 확장 (VS Code list)
    e.preventDefault();
    if (vis.length === 0) return;
    const i = sel ? vis.indexOf(sel) : -1;
    const next = vis[Math.max(0, Math.min(vis.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (e.shiftKey) props.tree.rangeSelect(next.path);
    else props.tree.select(next.path);
    scrollRowIntoView(next.path);
  } else if (e.key === 'a' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    props.tree.selectAll();
  } else if (e.key === 'F2' && sel && multi.length <= 1) {
    e.preventDefault();
    startRename(sel);
  } else if (e.key === 'Delete' && multi.length > 0) {
    e.preventDefault();
    void askDelete(multi);
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
// immediate 로 그 시점의 활성 탭을 잡는다. 선택 행이 뷰포트 밖이면 스크롤한다.
// 섹션 트리는 대상이 아니다 — 같은 파일이 여러 트리에서 동시에 선택되면 포커스 기준이 흐려진다
watch(
  () => activeTab()?.path ?? null,
  async (path) => {
    if (!path || !props.primary) return;
    await props.tree.revealPath(path);
    scrollRowIntoView(path);
  },
  { immediate: true },
);

/** 행이 뷰포트 밖이면 가운데로 스크롤 */
function scrollRowIntoView(path: string): void {
  const el = treeEl.value;
  const i = rows.value.findIndex((r) => r.node?.path === path);
  if (!el || i < 0) return;
  const top = i * ROW_H;
  if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
    el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 2));
  }
}

/** 행 밖(빈 영역) 클릭 판정 — 가상 스크롤 래퍼가 있어 .self 로는 잡히지 않는다 */
function outsideRows(e: Event): boolean {
  return (e.target as HTMLElement).closest('.row') === null;
}

/**
 * 트리 포커스 한정 붙여넣기 — 클립보드 이미지를 선택 위치에 파일로 저장 (텍스트 등은 무시).
 * WHY: 터미널과 같은 방침으로 navigator.clipboard.read()(권한 프롬프트) 대신 네이티브
 *      paste 이벤트를 쓴다. tabindex div 는 편집 가능 요소가 아니라 paste 가 요소로
 *      배달되지 않으므로 window 에서 받아 activeElement 로 판정한다 — 포커스를 가진 트리 하나만 받는다.
 */
function onPaste(e: ClipboardEvent): void {
  if (editing.value || confirming()) return; // 인라인 입력·다이얼로그의 붙여넣기는 건드리지 않는다
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

/** 포커스 행(selectedPath)의 TreeNode — 보이는 행에 없으면 null (다중 선택이어도 포커스 하나만) */
function selectedNode(): TreeNode | null {
  return files.value.selectedPath !== null
    ? props.tree.visibleNodes().find((n) => n.path === files.value.selectedPath) ?? null
    : null;
}

async function pasteImage(blob: Blob): Promise<void> {
  // 대상 디렉토리는 새 파일 생성과 같은 규칙 — 선택이 폴더면 그 안, 파일이면 부모, 없으면 트리 루트
  const sel = selectedNode();
  const dir = sel === null ? base.value : sel.kind === 'directory' ? sel.path : parentOf(sel.path);
  const saved = await saveClipboardImage(dir, blob); // 실패는 model 이 notify 한다
  if (saved !== null) props.tree.select(saved);
}

onMounted(() => window.addEventListener('paste', onPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));

// 트리 포커스 요청 (ticket terminal-path-links — 디렉토리 링크가 reveal 뒤 사이드바를 포커스한다).
// nextTick: showViewlet 직후면 사이드바가 아직 그려지기 전이라 즉시 focus 가 무시된다
watch(
  () => files.value.pendingFocus,
  (v) => {
    if (!v) return;
    files.value.pendingFocus = false;
    void nextTick(() => treeEl.value?.focus());
  },
);

function decoColor(node: TreeNode): string | undefined {
  const deco = decorationFor(node.path, node.kind === 'directory');
  return deco ? `var(${deco.color})` : undefined;
}

// 폴더 pane 헤더는 사이드바 제목에 병합됐다 (VS Code merged-header — 제목이 워크스페이스명) —
// 새 파일·새 폴더는 인라인 입력 상태가 여기 살아 SideBar 의 제목 액션이 이 둘을 부른다.
// 위치는 VS Code 규칙 — 선택(포커스)이 폴더면 그 안, 파일이면 부모, 없으면 트리 루트
defineExpose({
  newFile: () => void startCreate('createFile', selectedNode()),
  newFolder: () => void startCreate('createDir', selectedNode()),
});
</script>

<template>
  <div
    ref="treeEl"
    class="tree"
    :class="{ 'drop-root': rootDrop }"
    :data-upload-zone="isRemote ? '' : undefined"
    tabindex="0"
    @keydown="onTreeKeydown"
    @scroll.passive="onTreeScroll"
    @dragover="onDragOver($event, base)"
    @dragleave="onTreeDragLeave"
    @drop="onDrop($event, base)"
    @click="outsideRows($event) && tree.select(null)"
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
              selected: files.selected.has(row.node.path),
              focused: files.selectedPath === row.node.path,
              'drop-target': row.node.kind === 'directory' && dropDir === row.node.path,
              'drop-region': inDropRegion(row.node),
            }"
            :style="{ paddingLeft: `${row.node.depth * 8}px` }"
            draggable="true"
            @dragstart="onRowDragStart($event, row.node)"
            @dragend="endEditorDrag(); dropDir = null"
            @dragover="onDragOver($event, dirOf(row.node))"
            @drop="onDrop($event, dirOf(row.node))"
            @click="onRowClick(row.node, $event)"
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
</template>

<style scoped>
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
  user-select: none; /* Shift+클릭 범위 선택이 텍스트 선택을 만들지 않게 */
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row.selected {
  background: var(--vscode-list-inactiveSelectionBackground);
}
.tree:focus-within .row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
/* 포커스 행 — 선택 집합 안에서 키보드·범위 선택의 기준 (VS Code list.focusOutline) */
.tree:focus-within .row.focused {
  outline: 1px solid var(--vscode-list-focusOutline);
  outline-offset: -1px;
}
/* 드롭 대상 강조 (이동·업로드 공통, VS Code 동일 감각) — 대상 폴더 행 + 펼쳐진 서브트리 행은 배경(drop-region),
   폴더 행 자체는 focusBorder 테두리(drop-target), 트리 루트(행 밖·루트 파일 위)는 트리 테두리 */
.row.drop-region {
  background: var(--vscode-list-dropBackground);
}
.row.drop-target {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
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

<style>
/* 드래그 배지 (VS Code .monaco-drag-image) — body 에 잠깐 붙는 요소라 scoped 밖. 화면 밖에 두되 렌더는 되어야 setDragImage 가 받는다 */
.explorer-drag-badge {
  position: absolute;
  top: -1000px;
  display: inline-block;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  color: var(--vscode-list-activeSelectionForeground);
  background: var(--vscode-list-activeSelectionBackground);
  border: 1px solid var(--vscode-focusBorder);
}
</style>
