<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DirEntry } from '../../backend/types';
import FileIcon from '../widgets/FileIcon.vue';
import type { ColumnRow } from './FolderColumn.vue';

// 폴더 탭 '큰 아이콘 보기' — Windows 탐색기 large icons 근사: 고정 크기 타일 그리드 (아이콘 + 두 줄
// 라벨). 행 단위 가상 스크롤 — 열 수는 너비에서 계산해 부모의 키보드 이동(↑↓ = ±cols)에 노출한다.
// 이미지 썸네일은 없다 (파일 아이콘만). 생성 입력 행은 그리드 위에 한 줄
const props = defineProps<{
  listing: { entries: DirEntry[] | null; error?: string } | undefined;
  rows: ColumnRow[];
  cursor: string | null;
  renaming: string | null;
  focused: boolean;
}>();
const emit = defineEmits<{
  click: [entry: DirEntry];
  dblclick: [entry: DirEntry];
  contextmenu: [entry: DirEntry | null, e: MouseEvent];
}>();

const TILE_W = 104;
const TILE_H = 96;
const OVERSCAN = 2;

const el = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(0);
const width = ref(0);
const cols = computed(() => Math.max(1, Math.floor(width.value / TILE_W)));
const entries = computed(() => props.rows.filter((r) => r.entry).map((r) => r.entry!));
const hasInput = computed(() => props.rows.some((r) => r.input));
const rowCount = computed(() => Math.ceil(entries.value.length / cols.value));
const win = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / TILE_H) - OVERSCAN);
  const end = Math.min(rowCount.value, Math.ceil((scrollTop.value + viewportH.value) / TILE_H) + OVERSCAN);
  return { start, tiles: entries.value.slice(start * cols.value, end * cols.value) };
});
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (!el.value) return;
  const measure = () => {
    viewportH.value = el.value?.clientHeight ?? 0;
    width.value = el.value?.clientWidth ?? 0;
  };
  measure();
  ro = new ResizeObserver(measure);
  ro.observe(el.value);
});
onBeforeUnmount(() => ro?.disconnect());

watch(
  () => [props.cursor, entries.value.length, cols.value] as const,
  ([target]) => {
    const e = el.value;
    if (!e || !target) return;
    const i = entries.value.findIndex((x) => x.path === target);
    if (i < 0) return;
    const top = Math.floor(i / cols.value) * TILE_H + (hasInput.value ? 24 : 0);
    if (top < e.scrollTop) e.scrollTop = top;
    else if (top + TILE_H > e.scrollTop + e.clientHeight) e.scrollTop = top + TILE_H - e.clientHeight;
  },
  { immediate: true, flush: 'post' },
);

function outsideTiles(e: Event): boolean {
  return (e.target as HTMLElement).closest('.tile') === null;
}

defineExpose({ cols });
</script>

<template>
  <div
    ref="el"
    class="icons"
    :class="{ focused }"
    @scroll.passive="scrollTop = el?.scrollTop ?? 0"
    @contextmenu="outsideTiles($event) && ($event.preventDefault(), emit('contextmenu', null, $event))"
  >
    <div v-if="!listing || (listing.entries === null && !listing.error)" class="notice">
      <span class="codicon codicon-loading codicon-modifier-spin loading" /> Loading…
    </div>
    <div v-else-if="listing.error" class="notice error">{{ listing.error }}</div>
    <template v-else>
      <div v-if="hasInput" class="input-row">
        <span class="codicon codicon-file icon-sm" />
        <slot name="input" />
      </div>
      <div v-if="entries.length === 0 && !hasInput" class="notice">This folder is empty.</div>
      <div v-else class="inner" :style="{ height: `${rowCount * TILE_H}px` }">
        <div class="window" :style="{ transform: `translateY(${win.start * TILE_H}px)` }">
          <div
            v-for="e in win.tiles"
            :key="e.path"
            class="tile"
            :class="{ cursor: e.path === cursor, editing: e.path === renaming }"
            :title="e.name"
            @click="emit('click', e)"
            @dblclick="emit('dblclick', e)"
            @contextmenu.prevent="emit('contextmenu', e, $event)"
          >
            <span class="big">
              <span v-if="e.kind === 'directory'" class="codicon codicon-folder" />
              <FileIcon v-else :name="e.name" />
            </span>
            <slot v-if="e.path === renaming" name="rename" />
            <span v-else class="label">{{ e.name }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.icons {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  padding: 4px;
  box-sizing: border-box;
}
.input-row {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 4px;
}
.icon-sm {
  font-size: 16px;
  margin-right: 6px;
  color: var(--vscode-icon-foreground);
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
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
}
.tile {
  width: 104px;
  height: 96px;
  box-sizing: border-box;
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  border-radius: 4px;
  cursor: pointer;
  color: var(--vscode-foreground);
}
.tile:hover {
  background: var(--vscode-list-hoverBackground);
}
.tile.cursor {
  background: var(--vscode-list-inactiveSelectionBackground);
}
.focused .tile.cursor {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.big {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.big .codicon {
  font-size: 40px;
  color: var(--vscode-icon-foreground);
}
.big .file-icon {
  transform: scale(2.4);
}
.label {
  width: 96px;
  margin-top: 4px;
  font-size: 12px;
  line-height: 15px;
  text-align: center;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
}
.tile.editing {
  overflow: visible;
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
