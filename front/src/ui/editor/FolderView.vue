<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DirEntry } from '../../backend/types';
import {
  editors, folderPrefs, navigateFolderTab, openFile, setFolderSort, setFolderStyle, toggleFolderPreviewPane,
  type FolderStyle, type FolderTab,
} from '../../model/editors';
import { acquireDir, files, folderParent, isAbsPath, releaseDir, toAbsPath, toWorkspacePath } from '../../model/files';
import { openFolder } from '../../model/host';
import { createDir, createFile, deleteEntry, renameEntry, undoFileOp } from '../../model/fileops';
import { openContextMenu, workbench, type ContextMenuItem } from '../../model/workbench';
import FolderColumn, { type ColumnRow } from './FolderColumn.vue';
import FolderDetails from './FolderDetails.vue';
import FolderIcons from './FolderIcons.vue';
import FolderPreview from './FolderPreview.vue';
import { typeOf } from './folderFmt';
import InlineNameInput from '../widgets/InlineNameInput.vue';
import ConfirmDialog from '../widgets/ConfirmDialog.vue';

// 폴더 탭 — 상태(현재 폴더 path·이력·정렬·스타일)는 탭(FolderTab)과 editors.folderView(커서)에 있고
// 이 컴포넌트는 스타일에 따라 다르게 그린다: columns(yazi 3열: 부모/현재/미리보기) ·
// details(Windows 탐색기 자세히 보기: 이름·수정한 날짜·유형·크기, 머리글 정렬) · icons(큰 아이콘
// 그리드). details·icons 는 미리보기 창(folderPrefs.previewPane, 오른쪽)을 토글로 켠다. 툴바는 공통 —
// 뒤로/앞으로(탭 이력)·위로·breadcrumb(조각 클릭 이동)·보기 전환·미리보기 창.
// 나열은 files.listing (acquireDir/releaseDir 참조 계수 — 감시·파일 조작 리프레시가 트리와 같은
// 경로로 갱신), 탭 안 이동은 navigateFolderTab (탭 id·path 가 바뀌고 이 인스턴스는 그대로 따라간다).
// 키: ↑↓ j/k 이동(icons 는 ←→ ±1·↑↓ ±열), → l Enter 진입·열기, ← h Backspace 상위, Alt+←/→ 뒤로/앞으로,
// Alt+↑ 위로, F2·Delete·Ctrl+Z 는 fileops. 워크스페이스 밖(절대 경로)에서는 파일 조작이 없다.
// ponytail: 다중 선택·숨김 토글·썸네일 없음, 탐색기 트리 선택과 동기화하지 않는다
const props = defineProps<{ groupId: number; tabId: string; path: string }>();

const tab = computed(() => editors.groups.find((g) => g.id === props.groupId)?.tabs.find((t) => t.id === props.tabId) as FolderTab | undefined);
const style = computed<FolderStyle>(() => tab.value?.style ?? 'columns');
const explorerStyle = computed(() => style.value !== 'columns');
const showPreview = computed(() => style.value === 'columns' || folderPrefs.previewPane);

const parent = computed(() => folderParent(props.path, workbench.rootPath));
/** 워크스페이스 밖(절대 경로) — 나열·미리보기·파일 열기는 되지만 생성·rename·삭제는 루트 안 전용이라 숨긴다 */
const outside = computed(() => isAbsPath(props.path));
const listing = computed(() => files.listing.get(props.path));

// ---- 정렬 — columns 는 나열 순서(디렉토리 우선 이름순) 그대로, details·icons 는 탭의 sort. 디렉토리는 항상 앞
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
const entries = computed<DirEntry[]>(() => {
  const list = listing.value?.entries ?? [];
  const s = tab.value?.sort;
  if (!explorerStyle.value || !s || (s.key === 'name' && s.asc)) return list;
  const cmp = (a: DirEntry, b: DirEntry): number => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    let r = 0;
    if (s.key === 'name') r = collator.compare(a.name, b.name);
    else if (s.key === 'mtime') r = (a.mtime ?? 0) - (b.mtime ?? 0);
    else if (s.key === 'size') r = (a.size ?? 0) - (b.size ?? 0);
    else r = collator.compare(typeOf(a), typeOf(b)) || collator.compare(a.name, b.name);
    return s.asc ? r : -r;
  };
  return [...list].sort(cmp);
});

// ---- 커서
const view = computed(() => editors.folderView.get(props.path));
/** 실효 커서 — 저장된 경로가 나열에 있으면 그것, 사라졌으면 같은 인덱스 자리, 없으면 첫 항목 */
const cursor = computed<DirEntry | null>(() => {
  const list = entries.value;
  if (list.length === 0) return null;
  const v = view.value;
  if (!v) return list[0];
  return list.find((e) => e.path === v.cursor) ?? list[Math.min(v.index, list.length - 1)];
});
function setCursor(dir: string, entry: DirEntry, index: number): void {
  editors.folderView.set(dir, { cursor: entry.path, index });
}
function selectEntry(e: DirEntry): void {
  const i = entries.value.indexOf(e);
  if (i >= 0) setCursor(props.path, e, i);
}
function moveCursor(delta: number): void {
  const list = entries.value;
  if (list.length === 0) return;
  const i = cursor.value ? list.indexOf(cursor.value) : 0;
  cursorTo(i + delta);
}
function cursorTo(index: number): void {
  const list = entries.value;
  if (list.length === 0) return;
  const i = Math.max(0, Math.min(list.length - 1, index));
  setCursor(props.path, list[i], i);
}

// ---- 이동
function goTo(dir: string, cursorEntry?: DirEntry, via?: 'back' | 'forward'): void {
  dir = toWorkspacePath(dir, workbench.rootPath);
  if (cursorEntry) {
    // 도착 폴더의 커서를 미리 세운다 — 상위로 갈 때 떠나온 폴더, 부모 열 클릭은 그 항목
    const list = files.listing.get(dir)?.entries;
    const i = list ? list.findIndex((e) => e.path === cursorEntry.path) : -1;
    editors.folderView.set(dir, { cursor: cursorEntry.path, index: Math.max(i, 0) });
  }
  navigateFolderTab(props.groupId, props.tabId, dir, { via });
}
function enter(entry: DirEntry): void {
  if (entry.kind === 'directory') goTo(entry.path);
  else void openFile(entry.path);
}
/** 이 폴더가 부모 열에서 갖는 경로 — 부모가 절대면 절대 꼴 (루트 '' 의 부모 열에서는 root 절대 경로) */
const selfInParent = computed(() =>
  parent.value !== null && isAbsPath(parent.value) && !isAbsPath(props.path)
    ? `${workbench.rootPath.replace(/\\/g, '/')}${props.path === '' ? '' : `/${props.path}`}`
    : props.path,
);
function goUp(): void {
  if (parent.value === null) return;
  goTo(parent.value, { name: '', path: selfInParent.value, kind: 'directory' });
}
const canBack = computed(() => (tab.value?.histIndex ?? 0) > 0);
const canForward = computed(() => tab.value !== undefined && tab.value.histIndex < tab.value.history.length - 1);
function goBack(): void {
  const t = tab.value;
  if (!t || !canBack.value) return;
  goTo(t.history[t.histIndex - 1], undefined, 'back');
}
function goForward(): void {
  const t = tab.value;
  if (!t || !canForward.value) return;
  goTo(t.history[t.histIndex + 1], undefined, 'forward');
}

/** breadcrumb 조각 — 안: 워크스페이스명 › 세그먼트, 밖: '/'(또는 드라이브) › 세그먼트. 클릭은 그 접두 경로로 */
const crumbs = computed<{ label: string; path: string }[]>(() => {
  if (!outside.value) {
    const out = [{ label: workbench.workspaceName, path: '' }];
    if (props.path === '') return out;
    const segs = props.path.split('/');
    segs.forEach((s, i) => out.push({ label: s, path: segs.slice(0, i + 1).join('/') }));
    return out;
  }
  const segs = props.path.split('/');
  const out: { label: string; path: string }[] = [];
  if (segs[0] === '') out.push({ label: '/', path: '/' });
  else out.push({ label: segs[0], path: segs[0] });
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === '') continue;
    out.push({ label: segs[i], path: segs[0] === '' ? `/${segs.slice(1, i + 1).join('/')}` : segs.slice(0, i + 1).join('/') });
  }
  return out;
});

// ---- 나열 참조 (부모·현재·미리보기 폴더) — 바뀌는 것만 acquire/release
const previewEntry = computed<DirEntry | null>(() => (showPreview.value ? cursor.value : null));
const previewDir = computed(() => (previewEntry.value?.kind === 'directory' ? previewEntry.value.path : null));
const held = new Set<string>();
watch(
  () => new Set([style.value === 'columns' ? parent.value : null, props.path, previewDir.value].filter((p): p is string => p !== null)),
  (next) => {
    for (const p of next) if (!held.has(p)) { acquireDir(p); held.add(p); }
    for (const p of [...held]) if (!next.has(p)) { releaseDir(p); held.delete(p); }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  for (const p of held) releaseDir(p);
  held.clear();
});

// ---- 파일 조작 (탐색기와 같은 인라인 입력·확인 대화상자, fileops 재사용)
type EditMode = 'createFile' | 'createDir' | 'rename';
const editing = ref<{ mode: EditMode; path?: string; initial: string } | null>(null);
const opError = ref<string | null>(null);
const confirming = ref<DirEntry | null>(null);

const rows = computed<ColumnRow[]>(() => {
  const ed = editing.value;
  const base = entries.value.map((entry) => ({ entry }));
  return ed && ed.mode !== 'rename' ? [{ input: true }, ...base] : base;
});
const renaming = computed(() => (editing.value?.mode === 'rename' ? editing.value.path ?? null : null));

function startCreate(mode: 'createFile' | 'createDir'): void {
  opError.value = null;
  editing.value = { mode, initial: '' };
}
function startRename(entry: DirEntry): void {
  opError.value = null;
  editing.value = { mode: 'rename', path: entry.path, initial: entry.name };
}
/** 탐색기 검증과 같은 규칙 — 빈 이름/중복/부적합 문자. 생성은 a/b/c 중첩 허용, rename 은 불허 */
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
  const first = segments[0];
  const dup = entries.value.some(
    (e) => e.path !== ed.path && e.name === first
      && !(ed.mode !== 'rename' && segments.length > 1 && e.kind === 'directory'),
  );
  if (dup) return `A file or folder ${first} already exists at this location. Please choose a different name.`;
  return null;
}
async function commitEdit(name: string): Promise<void> {
  const ed = editing.value;
  if (!ed) return;
  const target = props.path === '' ? name : `${props.path}/${name}`;
  try {
    if (ed.mode === 'rename') {
      if (target !== ed.path) await renameEntry(ed.path!, target);
    } else if (ed.mode === 'createFile') {
      await createFile(target);
      await openFile(target); // 탐색기와 같다 — 새 파일은 바로 연다
    } else {
      await createDir(target);
    }
    editing.value = null;
    // 조작 결과에 커서 — 리프레시(refreshAfter)가 끝난 뒤라 나열에 있다
    const i = entries.value.findIndex((e) => e.path === target);
    if (i >= 0) setCursor(props.path, entries.value[i], i);
    refocus();
  } catch (e) {
    opError.value = e instanceof Error ? e.message : String(e);
  }
}
function cancelEdit(): void {
  editing.value = null;
  opError.value = null;
  refocus();
}
const confirmMessage = computed(() => {
  const e = confirming.value;
  if (!e) return { message: '', detail: '' };
  const dirty = [...editors.docs].some(
    ([p, d]) => (p === e.path || p.startsWith(`${e.path}/`)) && d.content !== d.savedContent,
  );
  return {
    message: dirty
      ? `Are you sure you want to delete '${e.name}' with unsaved changes? Your changes will be lost.`
      : `Are you sure you want to permanently delete '${e.name}'${e.kind === 'directory' ? ' and its contents' : ''}?`,
    detail: 'This action is irreversible!',
  };
});
function onConfirmDelete(): void {
  const e = confirming.value;
  confirming.value = null;
  if (e) void deleteEntry(e.path, e.kind); // 실패는 model 이 notify 한다
  refocus();
}

const STYLES: { key: FolderStyle; label: string; icon: string }[] = [
  { key: 'columns', label: 'Columns', icon: 'codicon-split-horizontal' },
  { key: 'details', label: 'Details', icon: 'codicon-list-flat' },
  { key: 'icons', label: 'Large icons', icon: 'codicon-symbol-misc' },
];
function menuFor(entry: DirEntry | null): ContextMenuItem[] {
  const viewItems: ContextMenuItem[] = STYLES.map((s) => ({
    label: `View: ${s.label}${style.value === s.key ? ' ✓' : ''}`,
    run: () => setFolderStyle(props.groupId, props.tabId, s.key),
  }));
  const ops: ContextMenuItem[] = outside.value ? [] : [
    { label: 'New File...', run: () => startCreate('createFile') },
    { label: 'New Folder...', run: () => startCreate('createDir') },
  ];
  // 'Open in New Session' — 그 폴더(빈 영역은 현재 폴더)를 root 로 하는 새 세션 탭. 같은 root 세션이 있으면
  // 포커스만. 워크스페이스 밖(절대 경로)에서도 그대로 — 밖을 탐색하다 세션으로 여는 경로
  const session = (dir: string): ContextMenuItem[] => [
    { label: 'Open in New Session', run: () => openFolder(toAbsPath(dir, workbench.rootPath)) },
    { separator: true },
  ];
  if (!entry) return [...session(props.path), ...ops, ...(ops.length ? [{ separator: true }] : []), ...viewItems];
  return [
    ...(entry.kind === 'directory' ? session(entry.path) : []),
    ...ops,
    ...(ops.length ? [{ separator: true }] : []),
    { label: 'Copy Path', run: () => void navigator.clipboard.writeText(entry.path) },
    ...(outside.value ? [] : [
      { separator: true },
      { label: 'Rename...', keybinding: 'F2', run: () => startRename(entry) },
      { label: 'Delete', keybinding: 'Delete', run: () => (confirming.value = entry) },
    ]),
    { separator: true },
    ...viewItems,
  ];
}
function onRowContextMenu(entry: DirEntry | null, e: MouseEvent): void {
  if (entry) selectEntry(entry);
  openContextMenu(e.clientX, e.clientY, menuFor(entry));
}

// ---- 키보드
const iconsRef = ref<InstanceType<typeof FolderIcons> | null>(null);
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && editing.value) {
    cancelEdit();
    return;
  }
  if (editing.value || confirming.value) return;
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    // Windows 탐색기: Alt+← 뒤로, Alt+→ 앞으로, Alt+↑ 위로
    if (e.key === 'ArrowLeft') goBack();
    else if (e.key === 'ArrowRight') goForward();
    else if (e.key === 'ArrowUp') goUp();
    else return;
    e.preventDefault();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) {
    if (e.key === 'z' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void undoFileOp();
    }
    return;
  }
  const cur = cursor.value;
  const grid = style.value === 'icons';
  const cols = grid ? (iconsRef.value?.cols ?? 1) : 1;
  switch (e.key) {
    case 'ArrowDown': moveCursor(cols); break;
    case 'ArrowUp': moveCursor(-cols); break;
    case 'j': moveCursor(1); break;
    case 'k': moveCursor(-1); break;
    case 'PageDown': moveCursor(20 * cols); break; // ponytail: 뷰포트 높이와 무관한 20행 고정 — 실측 행 수가 필요해지면 스크롤 컴포넌트의 viewportH 를 받아 쓴다
    case 'PageUp': moveCursor(-20 * cols); break;
    case 'Home': cursorTo(0); break;
    case 'End': cursorTo(entries.value.length - 1); break;
    case 'ArrowRight': if (grid) moveCursor(1); else if (cur) enter(cur); break;
    case 'ArrowLeft': if (grid) moveCursor(-1); else goUp(); break;
    case 'l': case 'Enter': if (cur) enter(cur); break;
    case 'h': case 'Backspace': goUp(); break;
    case 'F2': if (cur && !outside.value) startRename(cur); break;
    case 'Delete': if (cur && !outside.value) confirming.value = cur; break;
    default: return;
  }
  e.preventDefault();
}

// ---- 포커스 — 터미널 탭과 같은 규칙: 활성 탭이면 마운트·포커스 요청 때 컨테이너에 포커스
const root = ref<HTMLElement | null>(null);
const focused = ref(false);
const isActiveTab = () =>
  editors.activeGroupId === props.groupId &&
  editors.groups.find((g) => g.id === props.groupId)?.activeTabId === props.tabId;
function refocus(): void {
  void nextTick(() => root.value?.focus());
}
onMounted(() => {
  if (isActiveTab()) {
    editors.pendingFocus = false;
    refocus();
  }
});
watch(
  () => editors.pendingFocus && isActiveTab(),
  (on) => {
    if (!on) return;
    editors.pendingFocus = false;
    refocus();
  },
);
</script>

<template>
  <div
    ref="root"
    class="folder-view"
    tabindex="0"
    @keydown="onKeydown"
    @focus="focused = true"
    @blur="focused = false"
  >
    <div class="toolbar">
      <span class="nav codicon codicon-arrow-left" :class="{ disabled: !canBack }" title="Back (Alt+Left)" @click="goBack()" />
      <span class="nav codicon codicon-arrow-right" :class="{ disabled: !canForward }" title="Forward (Alt+Right)" @click="goForward()" />
      <span class="nav codicon codicon-arrow-up" :class="{ disabled: parent === null }" title="Up (Alt+Up)" @click="goUp()" />
      <div class="crumbs">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="codicon codicon-chevron-right sep" />
          <span class="crumb" :class="{ last: i === crumbs.length - 1 }" @click="i < crumbs.length - 1 && goTo(c.path)">{{ c.label }}</span>
        </template>
      </div>
      <span
        v-for="s in STYLES"
        :key="s.key"
        class="nav codicon"
        :class="[s.icon, { on: style === s.key }]"
        :title="s.label"
        @click="setFolderStyle(groupId, tabId, s.key)"
      />
      <span
        v-if="explorerStyle"
        class="nav codicon codicon-layout-sidebar-right"
        :class="{ on: folderPrefs.previewPane }"
        title="Preview pane"
        @click="toggleFolderPreviewPane()"
      />
    </div>
    <div class="body">
      <!-- columns: 부모 열 -->
      <FolderColumn
        v-if="style === 'columns'"
        class="col-parent"
        :listing="parent === null ? { entries: [] } : files.listing.get(parent)"
        :highlight="selfInParent"
        @click="(e) => parent !== null && goTo(parent, e)"
        @dblclick="(e) => parent !== null && goTo(parent, e)"
        @contextmenu="() => {}"
      />
      <!-- 현재 폴더 — 스타일별 -->
      <FolderColumn
        v-if="style === 'columns'"
        class="col-current"
        :listing="listing"
        :rows="rows"
        :cursor="cursor?.path ?? null"
        :renaming="renaming"
        :focused="focused"
        @click="selectEntry"
        @dblclick="enter"
        @contextmenu="onRowContextMenu"
      >
        <template #input><InlineNameInput initial="" :validate="validateName" :external-error="opError" @commit="commitEdit" @cancel="cancelEdit" @input="opError = null" /></template>
        <template #rename><InlineNameInput :initial="editing?.initial ?? ''" :select-stem="cursor?.kind === 'file'" :validate="validateName" :external-error="opError" @commit="commitEdit" @cancel="cancelEdit" @input="opError = null" /></template>
      </FolderColumn>
      <FolderDetails
        v-else-if="style === 'details'"
        class="col-current"
        :listing="listing"
        :rows="rows"
        :cursor="cursor?.path ?? null"
        :renaming="renaming"
        :focused="focused"
        :sort="tab?.sort ?? { key: 'name', asc: true }"
        @click="selectEntry"
        @dblclick="enter"
        @contextmenu="onRowContextMenu"
        @sort="(k) => setFolderSort(groupId, tabId, k)"
      >
        <template #input><InlineNameInput initial="" :validate="validateName" :external-error="opError" @commit="commitEdit" @cancel="cancelEdit" @input="opError = null" /></template>
        <template #rename><InlineNameInput :initial="editing?.initial ?? ''" :select-stem="cursor?.kind === 'file'" :validate="validateName" :external-error="opError" @commit="commitEdit" @cancel="cancelEdit" @input="opError = null" /></template>
      </FolderDetails>
      <FolderIcons
        v-else
        ref="iconsRef"
        class="col-current"
        :listing="listing"
        :rows="rows"
        :cursor="cursor?.path ?? null"
        :renaming="renaming"
        :focused="focused"
        @click="selectEntry"
        @dblclick="enter"
        @contextmenu="onRowContextMenu"
      >
        <template #input><InlineNameInput initial="" :validate="validateName" :external-error="opError" @commit="commitEdit" @cancel="cancelEdit" @input="opError = null" /></template>
        <template #rename><InlineNameInput :initial="editing?.initial ?? ''" :select-stem="cursor?.kind === 'file'" :validate="validateName" :external-error="opError" @commit="commitEdit" @cancel="cancelEdit" @input="opError = null" /></template>
      </FolderIcons>
      <!-- 미리보기 — columns 의 셋째 열 / details·icons 의 미리보기 창 -->
      <FolderPreview
        v-if="showPreview"
        class="col-preview"
        :class="{ pane: explorerStyle }"
        :entry="previewEntry"
        @open="(e) => previewDir !== null && goTo(previewDir, e)"
      />
    </div>
    <ConfirmDialog
      v-if="confirming"
      :message="confirmMessage.message"
      :detail="confirmMessage.detail"
      confirm-label="Delete"
      @confirm="onConfirmDelete"
      @cancel="confirming = null; refocus()"
    />
  </div>
</template>

<style scoped>
.folder-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  outline: none;
  background: var(--vscode-editor-background);
}
.toolbar {
  flex-shrink: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-bottom: 1px solid var(--vscode-editorGroup-border);
  color: var(--vscode-foreground);
  user-select: none;
}
.nav {
  font-size: 16px;
  padding: 3px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--vscode-icon-foreground);
}
.nav:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.nav.disabled {
  opacity: 0.35;
  pointer-events: none;
}
.nav.on {
  background: var(--vscode-toolbar-activeBackground);
  color: var(--vscode-foreground);
}
.crumbs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  margin: 0 6px;
  height: 22px;
  padding: 0 4px;
  border: 1px solid var(--vscode-input-border);
  background: var(--vscode-input-background);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
}
.crumb {
  padding: 0 4px;
  border-radius: 3px;
  cursor: pointer;
  color: var(--vscode-breadcrumb-foreground);
}
.crumb:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-breadcrumb-focusForeground);
}
.crumb.last {
  cursor: default;
  color: var(--vscode-foreground);
}
.crumb.last:hover {
  background: none;
}
.crumbs .sep {
  font-size: 14px;
  flex-shrink: 0;
  opacity: 0.7;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.col-parent {
  flex: 1;
  border-right: 1px solid var(--vscode-editorGroup-border);
}
.col-current {
  flex: 2;
}
.col-preview {
  flex: 2;
  border-left: 1px solid var(--vscode-editorGroup-border);
}
.col-preview.pane {
  flex: 0 0 34%;
}
</style>
