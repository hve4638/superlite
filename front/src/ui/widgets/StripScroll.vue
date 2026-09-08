<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';

// 탭 스트립 가로 스크롤 컨테이너 (ticket tab-strip-overflow) — 세션 탭(TitleBar)·에디터 탭(TabBar) 공용.
// VS Code 탭바 동작: 넘치면 가로 스크롤, 휠 세로 입력을 가로로, 넘친 쪽 끝에 페이드, 3px 슬라이더는
// hover 중에만, 드래그 중 가장자리에 머물면 자동 스크롤. 액션(+·자물쇠 등)은 이 컨테이너 밖에 둔다.
// WHY: 네이티브 스크롤바는 높이를 차지해 35px 탭의 아래 1px 라인을 잘라먹는다 — 숨기고 슬라이더를 덧그린다.
//      DnD 삽입 판정은 탭 요소 rect 기준이라 스크롤 영역 안에서도 그대로 맞는다.

/** 드래그 자동 스크롤을 시작하는 가장자리 폭·프레임당 이동량 */
const EDGE = 40;
const STEP = 6;

const scrollEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const state = reactive({ left: false, right: false, scrollable: false, thumbLeft: 0, thumbWidth: 0, thumbDrag: false });

function update(): void {
  const el = scrollEl.value;
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  state.scrollable = max > 1;
  state.left = el.scrollLeft > 1;
  state.right = el.scrollLeft < max - 1;
  if (state.scrollable) {
    const ratio = el.clientWidth / el.scrollWidth;
    state.thumbWidth = Math.max(el.clientWidth * ratio, 20);
    state.thumbLeft = (el.scrollLeft / max) * (el.clientWidth - state.thumbWidth);
  }
}

/** 세로 휠을 가로 스크롤로 — 넘칠 때만 삼킨다 (터치패드 가로 입력은 브라우저 기본) */
function onWheel(e: WheelEvent): void {
  const el = scrollEl.value;
  if (!el || !state.scrollable || e.deltaX !== 0 || e.deltaY === 0) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY;
}

// 드래그 자동 스크롤 — dragover 는 포인터가 멈추면 드물게 와서 rAF 루프로 민다. 자식(탭)이
// stopPropagation 해도 받도록 capture 로 듣는다
let autoDir = 0;
let raf = 0;
function autoTick(): void {
  const el = scrollEl.value;
  if (!el || autoDir === 0) return;
  el.scrollLeft += autoDir * STEP;
  raf = requestAnimationFrame(autoTick);
}
function stopAuto(): void {
  autoDir = 0;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}
function onDragOver(e: DragEvent): void {
  const el = scrollEl.value;
  if (!el || !state.scrollable) return stopAuto();
  const r = el.getBoundingClientRect();
  const dir = e.clientX < r.left + EDGE && state.left ? -1 : e.clientX > r.right - EDGE && state.right ? 1 : 0;
  if (dir === autoDir) return;
  stopAuto();
  autoDir = dir;
  if (dir !== 0) raf = requestAnimationFrame(autoTick);
}
function onDragLeave(e: DragEvent): void {
  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
  stopAuto();
}

// 슬라이더 드래그 — pointer capture 로 스트립 밖까지 따라간다
let grabX = 0;
let grabScroll = 0;
function onThumbDown(e: PointerEvent): void {
  const el = scrollEl.value;
  if (!el) return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  grabX = e.clientX;
  grabScroll = el.scrollLeft;
  state.thumbDrag = true;
}
function onThumbMove(e: PointerEvent): void {
  const el = scrollEl.value;
  if (!el || !state.thumbDrag) return;
  const track = el.clientWidth - state.thumbWidth;
  const max = el.scrollWidth - el.clientWidth;
  el.scrollLeft = grabScroll + ((e.clientX - grabX) / track) * max;
}
function onThumbUp(): void {
  state.thumbDrag = false;
}

/** 자식 하나가 보이도록 최소한만 스크롤 — 활성 탭 전환 때 부모가 부른다 (스트립 안 selector) */
function reveal(selector: string): void {
  const el = scrollEl.value;
  const child = el?.querySelector<HTMLElement>(selector);
  if (!el || !child) return;
  const left = child.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
  const right = left + child.offsetWidth;
  if (left < el.scrollLeft) el.scrollLeft = left;
  else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
}
defineExpose({ reveal });

let ro: ResizeObserver | null = null;
onMounted(() => {
  const el = scrollEl.value;
  if (!el || !contentEl.value) return;
  ro = new ResizeObserver(update);
  ro.observe(el);
  ro.observe(contentEl.value); // 탭 추가·제거·라벨 폭 변화는 컨테이너가 아니라 내용 크기로 온다
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dragover', onDragOver, true);
  el.addEventListener('dragleave', onDragLeave, true);
  el.addEventListener('drop', stopAuto, true);
  window.addEventListener('dragend', stopAuto);
  update();
});
onUnmounted(() => {
  ro?.disconnect();
  stopAuto();
  window.removeEventListener('dragend', stopAuto);
});
</script>

<template>
  <div class="strip" :class="{ 'can-left': state.left, 'can-right': state.right, 'thumb-drag': state.thumbDrag }">
    <div ref="scrollEl" class="strip-scroll" @scroll="update">
      <div ref="contentEl" class="strip-content">
        <slot />
      </div>
    </div>
    <div
      v-if="state.scrollable"
      class="strip-thumb"
      :style="{ left: `${state.thumbLeft}px`, width: `${state.thumbWidth}px` }"
      @pointerdown="onThumbDown"
      @pointermove="onThumbMove"
      @pointerup="onThumbUp"
      @pointercancel="onThumbUp"
    />
  </div>
</template>

<style scoped>
/* 페이드 색은 부모가 --strip-bg 로 준다 (타이틀바·탭바 배경이 다르다) */
.strip {
  position: relative;
  display: flex;
  min-width: 0;
  --strip-bg: var(--vscode-editorGroupHeader-tabsBackground);
}
.strip-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.strip-scroll::-webkit-scrollbar {
  display: none;
}
.strip-content {
  display: flex;
  align-items: stretch;
  flex: none;
}
/* 넘침 표시 — 더 있는 쪽 끝의 페이드 */
.strip::before,
.strip::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s;
  z-index: 11;
}
.strip::before {
  left: 0;
  background: linear-gradient(to right, var(--strip-bg), transparent);
}
.strip::after {
  right: 0;
  background: linear-gradient(to left, var(--strip-bg), transparent);
}
.strip.can-left::before,
.strip.can-right::after {
  opacity: 1;
}
/* 슬라이더 — VS Code 탭바처럼 3px, hover·드래그 중에만 */
.strip-thumb {
  position: absolute;
  bottom: 0;
  height: 3px;
  background: var(--vscode-scrollbarSlider-background);
  opacity: 0;
  transition: opacity 0.1s;
  z-index: 12;
}
.strip:hover .strip-thumb,
.strip.thumb-drag .strip-thumb {
  opacity: 1;
}
.strip-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
.strip.thumb-drag .strip-thumb {
  background: var(--vscode-scrollbarSlider-activeBackground);
}
</style>
