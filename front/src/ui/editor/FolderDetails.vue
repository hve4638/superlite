<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DirEntry } from '../../backend/types';
import type { FolderSortKey } from '../../model/editors';
import FileIcon from '../widgets/FileIcon.vue';
import type { ColumnRow } from './FolderColumn.vue';
import { fmtDate, fmtSize, typeOf } from './folderFmt';

// 폴더 탭 '자세히 보기' — Windows 탐색기 details: 이름 / 수정한 날짜 / 유형 / 크기 열, 머리글 클릭
// 정렬(표시는 부모의 sort — 화살표만 그린다). 행은 FolderColumn 과 같은 22px 가상 스크롤.
// 정렬된 항목과 생성 입력 행은 부모가 rows 로 준다
const props = defineProps<{
  listing: { entries: DirEntry[] | null; error?: string } | undefined;
  rows: ColumnRow[];
  cursor: string | null;
  renaming: string | null;
  focused: boolean;
  sort: { key: FolderSortKey; asc: boolean };
}>();
const emit = defineEmits<{
  click: [entry: DirEntry];
  dblclick: [entry: DirEntry];
  contextmenu: [entry: DirEntry | null, e: MouseEvent];
  sort: [key: FolderSortKey];
  /** 폴더 행 드래그 시작 (ticket explorer-extra-roots) */
  dragstart: [entry: DirEntry, e: DragEvent];
}>();

const ROW_H = 22;
const OVERSCAN = 10;
const COLUMNS: { key: FolderSortKey; label: string }[] = [
  { key: 'name', label: 'Name' }, { key: 'mtime', label: 'Date modified' }, { key: 'type', label: 'Type' }, { key: 'size', label: 'Size' },
];

const el = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(0);
const win = computed(() => {
  const total = props.rows.length;
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop.value + viewportH.value) / ROW_H) + OVERSCAN);
  return { start, rows: props.rows.slice(start, end), total };
});
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (!el.value) return;
  viewportH.value = el.value.clientHeight;
  ro = new ResizeObserver(() => (viewportH.value = el.value?.clientHeight ?? 0));
  ro.observe(el.value);
});
onBeforeUnmount(() => ro?.disconnect());

watch(
  () => [props.cursor, props.rows.length] as const,
  ([target]) => {
    const e = el.value;
    if (!e || !target) return;
    const i = props.rows.findIndex((r) => r.entry?.path === target);
    if (i < 0) return;
    const top = i * ROW_H;
    if (top < e.scrollTop) e.scrollTop = top;
    else if (top + ROW_H > e.scrollTop + e.clientHeight) e.scrollTop = top + ROW_H - e.clientHeight;
  },
  { immediate: true, flush: 'post' },
);

function outsideRows(e: Event): boolean {
  return (e.target as HTMLElement).closest('.row') === null;
}
</script>

<template>
  <div class="details" :class="{ focused }">
    <div class="head">
      <span
        v-for="c in COLUMNS"
        :key="c.key"
        class="cell"
        :class="[c.key, { sorted: sort.key === c.key }]"
        @click="emit('sort', c.key)"
      >
        {{ c.label }}
        <span v-if="sort.key === c.key" class="codicon" :class="sort.asc ? 'codicon-chevron-up' : 'codicon-chevron-down'" />
      </span>
    </div>
    <div
      ref="el"
      class="body"
      @scroll.passive="scrollTop = el?.scrollTop ?? 0"
      @contextmenu="outsideRows($event) && ($event.preventDefault(), emit('contextmenu', null, $event))"
    >
      <div v-if="!listing || (listing.entries === null && !listing.error)" class="notice">
        <span class="codicon codicon-loading codicon-modifier-spin" /> Loading…
      </div>
      <div v-else-if="listing.error" class="notice error">{{ listing.error }}</div>
      <div v-else-if="rows.length === 0" class="notice">This folder is empty.</div>
      <div v-else class="inner" :style="{ height: `${win.total * ROW_H}px` }">
        <div class="window" :style="{ transform: `translateY(${win.start * ROW_H}px)` }">
          <template v-for="row in win.rows" :key="row.entry?.path ?? '__input'">
            <div v-if="row.input" class="row editing">
              <span class="cell name"><span class="codicon codicon-file icon" /><slot name="input" /></span>
            </div>
            <div
              v-else-if="row.entry"
              class="row"
              :class="{ cursor: row.entry.path === cursor, editing: row.entry.path === renaming }"
              :draggable="row.entry.kind === 'directory'"
              @dragstart="emit('dragstart', row.entry, $event)"
              @click="emit('click', row.entry)"
              @dblclick="emit('dblclick', row.entry)"
              @contextmenu.prevent="emit('contextmenu', row.entry, $event)"
            >
              <span class="cell name">
                <span v-if="row.entry.kind === 'directory'" class="codicon codicon-folder icon" />
                <FileIcon v-else :name="row.entry.name" />
                <slot v-if="row.entry.path === renaming" name="rename" />
                <span v-else class="label">{{ row.entry.name }}</span>
              </span>
              <span class="cell mtime">{{ fmtDate(row.entry.mtime) }}</span>
              <span class="cell type">{{ typeOf(row.entry) }}</span>
              <span class="cell size">{{ row.entry.kind === 'file' ? fmtSize(row.entry.size) : '' }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.details {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  flex-shrink: 0;
  height: 24px;
  border-bottom: 1px solid var(--vscode-editorGroup-border);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  user-select: none;
}
.head .cell {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  cursor: pointer;
  border-right: 1px solid var(--vscode-editorGroup-border);
}
.head .cell:hover {
  background: var(--vscode-list-hoverBackground);
}
.head .cell.sorted {
  color: var(--vscode-foreground);
}
.head .codicon {
  font-size: 12px;
}
.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
}
.inner {
  position: relative;
  /* 마지막 행 아래 여백 — 끝까지 스크롤해도 행이 바닥에 붙지 않게 */
  padding-bottom: 32px;
}
.window {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}
.row {
  display: flex;
  align-items: center;
  height: 22px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  color: var(--vscode-foreground);
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row.cursor {
  background: var(--vscode-list-inactiveSelectionBackground);
}
.focused .row.cursor {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.cell {
  flex-shrink: 0;
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.cell.name {
  flex: 1;
  min-width: 120px;
  display: flex;
  align-items: center;
}
.cell.mtime {
  width: 150px;
}
.cell.type {
  width: 110px;
}
.cell.size {
  width: 90px;
  text-align: right;
}
.row .cell.mtime,
.row .cell.type,
.row .cell.size {
  color: var(--vscode-descriptionForeground);
}
.focused .row.cursor .cell {
  color: inherit;
}
.row .icon {
  flex-shrink: 0;
  width: 16px;
  margin-right: 6px;
  font-size: 16px;
  color: var(--vscode-icon-foreground);
}
.row .file-icon {
  margin-right: 6px;
}
.row .label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
}
.notice.error {
  color: var(--vscode-errorForeground);
  word-break: break-all;
}
</style>
