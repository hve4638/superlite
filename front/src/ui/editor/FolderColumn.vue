<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DirEntry } from '../../backend/types';
import FileIcon from '../widgets/FileIcon.vue';

// 폴더 탭의 열 하나 — 디렉토리 나열을 22px 고정 행으로 그린다 (탐색기와 같은 가상 스크롤:
// 보이는 행 + 여유만 DOM). 로드 중 스피너·실패 사유·빈 폴더 안내까지 열이 맡고, 행 동작은
// 부모(FolderView)가 이벤트로 받는다. rows 의 input 행(생성 입력)과 renaming 행은 슬롯으로 —
// 인라인 입력의 상태·검증은 부모 것이다
export interface ColumnRow {
  entry?: DirEntry;
  /** 생성 입력 행 (현재 열에만) */
  input?: boolean;
}

const props = defineProps<{
  listing: { entries: DirEntry[] | null; error?: string } | undefined;
  /** 나열에 끼워 넣을 행 (생성 입력) — 없으면 entries 그대로 */
  rows?: ColumnRow[];
  /** 커서 행 (현재 열) — 포커스 색 */
  cursor?: string | null;
  /** 강조 행 (부모 열에서 현재 폴더) — 비활성 선택 색 */
  highlight?: string | null;
  /** 라벨 자리에 인라인 입력을 띄울 행 (rename) */
  renaming?: string | null;
  /** 폴더 탭이 키보드 포커스를 가졌는가 — 커서 행을 활성 선택 색으로 (포커스는 부모 컨테이너에 있다) */
  focused?: boolean;
}>();
const emit = defineEmits<{
  click: [entry: DirEntry];
  dblclick: [entry: DirEntry];
  contextmenu: [entry: DirEntry | null, e: MouseEvent];
}>();

const ROW_H = 22;
const OVERSCAN = 10;

const rows = computed<ColumnRow[]>(() => props.rows ?? (props.listing?.entries ?? []).map((entry) => ({ entry })));

const el = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(0);
const win = computed(() => {
  const total = rows.value.length;
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop.value + viewportH.value) / ROW_H) + OVERSCAN);
  return { start, rows: rows.value.slice(start, end), total };
});
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (!el.value) return;
  viewportH.value = el.value.clientHeight;
  ro = new ResizeObserver(() => (viewportH.value = el.value?.clientHeight ?? 0));
  ro.observe(el.value);
});
onBeforeUnmount(() => ro?.disconnect());

// 커서·강조 행이 뷰포트 밖이면 스크롤 — 키보드 이동·폴더 진입 직후 (VS Code list reveal 근사)
watch(
  () => [props.cursor ?? props.highlight, rows.value.length] as const,
  ([target]) => {
    const e = el.value;
    if (!e || !target) return;
    const i = rows.value.findIndex((r) => r.entry?.path === target);
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
  <div
    ref="el"
    class="column"
    :class="{ focused }"
    @scroll.passive="scrollTop = el?.scrollTop ?? 0"
    @contextmenu="outsideRows($event) && ($event.preventDefault(), emit('contextmenu', null, $event))"
  >
    <div v-if="!listing || (listing.entries === null && !listing.error)" class="notice">
      <span class="codicon codicon-loading codicon-modifier-spin" /> Loading…
    </div>
    <div v-else-if="listing.error" class="notice error">{{ listing.error }}</div>
    <div v-else-if="rows.length === 0" class="notice">Empty</div>
    <div v-else class="inner" :style="{ height: `${win.total * ROW_H}px` }">
      <div class="window" :style="{ transform: `translateY(${win.start * ROW_H}px)` }">
        <template v-for="row in win.rows" :key="row.entry?.path ?? '__input'">
          <div v-if="row.input" class="row editing">
            <span class="codicon codicon-file icon" />
            <slot name="input" />
          </div>
          <div
            v-else-if="row.entry"
            class="row"
            :class="{ cursor: row.entry.path === cursor, highlight: row.entry.path === highlight, editing: row.entry.path === renaming }"
            @click="emit('click', row.entry)"
            @dblclick="emit('dblclick', row.entry)"
            @contextmenu.prevent="emit('contextmenu', row.entry, $event)"
          >
            <span v-if="row.entry.kind === 'directory'" class="codicon codicon-folder icon" />
            <FileIcon v-else :name="row.entry.name" />
            <slot v-if="row.entry.path === renaming" name="rename" />
            <span v-else class="label">{{ row.entry.name }}</span>
            <span v-if="row.entry.kind === 'directory'" class="codicon codicon-chevron-right arrow" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.column {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
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
.row {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 6px 0 8px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  color: var(--vscode-foreground);
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row.highlight {
  background: var(--vscode-list-inactiveSelectionBackground);
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
.row .arrow {
  flex-shrink: 0;
  font-size: 14px;
  opacity: 0.6;
}
.row.editing {
  overflow: visible;
}
</style>
