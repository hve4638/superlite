<script setup lang="ts">
import { ref } from 'vue';
import type { LayoutBranch, LayoutNode } from '../../model/editors';
import { editors, resizeSplit } from '../../model/editors';
import EditorGroupView from './EditorGroupView.vue';
import Sash from '../widgets/Sash.vue';

const props = defineProps<{ node: LayoutNode }>();

// VS Code 에디터 그룹 최소 크기 (MINIMUM_EDITOR_WIDTH/HEIGHT)
const MIN_W = 220;
const MIN_H = 70;

const containerEl = ref<HTMLElement | null>(null);

function groupOf(id: number) {
  return editors.groups.find((g) => g.id === id);
}

// v-for 키 — 리프는 그룹 id, 분기는 포함한 리프 id 들. 트리가 바뀌어도 같은 그룹이면
// 키가 유지되어 monaco 가 리마운트되지 않는다.
function keyOf(node: LayoutNode): string {
  return typeof node === 'number' ? `g${node}` : `b(${node.children.map(keyOf).join(',')})`;
}

function sizeOf(i: number): number {
  const b = props.node as LayoutBranch;
  return b.sizes?.[i] ?? 1;
}

// 경계 드래그 — 시작 스냅샷 기준 누적 델타 (Sash 계약)
let startSizes: number[] = [];
let totalPx = 1;

function onSashStart() {
  const b = props.node as LayoutBranch;
  startSizes = b.children.map((_, i) => b.sizes?.[i] ?? 1);
  const el = containerEl.value;
  totalPx = Math.max(1, b.dir === 'row' ? el?.clientWidth ?? 1 : el?.clientHeight ?? 1);
}

function onSashResize(boundary: number, delta: number) {
  const b = props.node as LayoutBranch;
  resizeSplit(b, boundary, startSizes, delta, totalPx, b.dir === 'row' ? MIN_W : MIN_H);
}
</script>

<template>
  <EditorGroupView v-if="typeof node === 'number' && groupOf(node)" :group="groupOf(node)!" />
  <div v-else-if="typeof node !== 'number'" ref="containerEl" class="split" :class="node.dir">
    <div
      v-for="(c, i) in node.children"
      :key="keyOf(c)"
      class="cell"
      :style="{ flex: `${sizeOf(i)} 1 0%` }"
    >
      <Sash
        v-if="i > 0"
        :direction="node.dir === 'row' ? 'vertical' : 'horizontal'"
        class="cell-sash"
        @dragstart="onSashStart()"
        @resize="(d: number) => onSashResize(i, d)"
      />
      <EditorLayoutNode :node="c" class="cell-content" />
    </div>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  min-width: 0;
  min-height: 0;
}
.split.column {
  flex-direction: column;
}
.cell {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
}
.cell-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.split.row > .cell + .cell {
  border-left: 1px solid var(--vscode-editorGroup-border);
}
.split.column > .cell + .cell {
  border-top: 1px solid var(--vscode-editorGroup-border);
}
.split.row > .cell > .cell-sash {
  left: -2px;
}
.split.column > .cell > .cell-sash {
  top: -2px;
}
</style>
