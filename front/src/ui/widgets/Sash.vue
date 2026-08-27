<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  /** vertical: 좌우 리사이즈(세로 막대), horizontal: 상하 리사이즈(가로 막대) */
  direction: 'vertical' | 'horizontal';
}>();

const emit = defineEmits<{
  (e: 'dragstart'): void;
  /** 드래그 시작점 기준 누적 픽셀 델타 (vertical → dx, horizontal → dy).
      WHY: 증분 델타를 클램프된 현재 크기에 더하면, 경계를 지나쳤다 되돌아오는
      순간부터 크기가 움직여 커서와 경계에 갭이 생긴다 — 시작점 기준 누적이어야
      커서가 경계를 되넘을 때까지 크기가 고정된다 (VS Code 동작). */
  (e: 'resize', total: number): void;
}>();

const hovered = ref(false);
const dragging = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

// WHY: VS Code sash 는 즉시 하이라이트되지 않고 300ms hover 후 색이 나타난다.
function onEnter() {
  hoverTimer = setTimeout(() => (hovered.value = true), 300);
}
function onLeave() {
  clearTimeout(hoverTimer);
  hovered.value = false;
}

function onPointerDown(e: PointerEvent) {
  dragging.value = true;
  const start = props.direction === 'vertical' ? e.clientX : e.clientY;
  emit('dragstart');
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);

  const move = (ev: PointerEvent) => {
    const cur = props.direction === 'vertical' ? ev.clientX : ev.clientY;
    emit('resize', cur - start);
  };
  const up = () => {
    dragging.value = false;
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  // WHY: 터치 제스처/브라우저 개입으로 pointerup 없이 끝나면 move 리스너가 남아
  //      버튼을 떼고도 리사이즈되는 유령 드래그가 생긴다
  el.addEventListener('pointercancel', up);
}
</script>

<template>
  <div
    class="sash"
    :class="[direction, { hover: hovered || dragging }]"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @pointerdown="onPointerDown"
  />
</template>

<style scoped>
.sash {
  position: absolute;
  z-index: 35;
  touch-action: none;
}
.sash.vertical {
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: ew-resize;
}
.sash.horizontal {
  left: 0;
  right: 0;
  height: 4px;
  cursor: ns-resize;
}
.sash.hover {
  background: var(--vscode-sash-hoverBorder);
  transition: background-color 0.1s ease-out;
}
</style>
