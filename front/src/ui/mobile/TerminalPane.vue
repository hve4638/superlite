<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import {
  attachTerminal, click, fitTerminal, focusTerminal, mods, pressKey, setTermFont, TERMINAL_BACKGROUND, termFont, toggleMod, wheel,
  type BarKey, type Mod,
} from './termHost';

// 터미널 탭 본문 (ticket mobile-shell) — 편집기 영역(EditorArea)의 터미널 탭이 활성일 때. xterm / 키바(수정키·키·마우스 모드 토글).
// 제스처 (사용자 확정 2026-09-14): 한 손가락 끌기 = 스크롤(마우스 모드면 포인터 이동), 탭 = 포커스(마우스 모드면 클릭),
// 두 손가락 = 핀치 확대·축소 또는 두 손가락 끌기 스크롤. 마우스 모드는 터미널 영역 안에 갇힌 가상 포인터 — 터치패드처럼
// 끌어서 옮기고 탭이 클릭 (tmux·TUI 의 마우스 액션용). 다른 탭으로 옮겨도 스크롤백은 termHost 바인딩에 남는다 —
// detach 는 탭 줄의 × (model closeTab → disposeTerminal)
const props = defineProps<{ term: number }>();
const host = ref<HTMLElement | null>(null);
const mouseMode = ref(false);
const pointer = reactive({ x: 40, y: 40 });
let ro: ResizeObserver | null = null;

onMounted(() => {
  if (!host.value) return;
  attachTerminal(props.term, host.value);
  ro = new ResizeObserver(() => fitTerminal(props.term));
  ro.observe(host.value);
  void nextTick(() => {
    fitTerminal(props.term);
    focusTerminal(props.term);
    const r = host.value?.getBoundingClientRect();
    if (r) {
      pointer.x = r.width / 2;
      pointer.y = r.height / 2;
    }
  });
});
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});

// ---- 터치 제스처. touch-action: none 이라 브라우저 스크롤·핀치 줌은 오지 않는다. stopPropagation — xterm 6 의
//      document 수준 Gesture(터치→스크롤)가 겹치지 않게
const TAP_MOVE = 8;
const TAP_MS = 350;
let start: { x: number; y: number; at: number } | null = null;
let last: { x: number; y: number } | null = null;
let moved = false;
let pinch: { d0: number; size0: number; y0: number; zooming: boolean } | null = null;
const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
const avgY = (e: TouchEvent) => (e.touches[0].clientY + e.touches[1].clientY) / 2;
function hostRect(): DOMRect {
  return host.value!.getBoundingClientRect();
}
function pointerClient(): { x: number; y: number } {
  const r = hostRect();
  return { x: r.left + pointer.x, y: r.top + pointer.y };
}
function onStart(e: TouchEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, at: Date.now() };
    last = { x: t.clientX, y: t.clientY };
    moved = false;
    pinch = null;
  } else if (e.touches.length === 2) {
    pinch = { d0: dist(e), size0: termFont.size, y0: avgY(e), zooming: false };
    moved = true;
  }
}
function onMove(e: TouchEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (pinch && e.touches.length === 2) {
    const ratio = dist(e) / pinch.d0;
    if (pinch.zooming || Math.abs(ratio - 1) > 0.1) {
      pinch.zooming = true;
      setTermFont(pinch.size0 * ratio);
    } else {
      const y = avgY(e);
      const p = pointerClient();
      wheel(props.term, -(y - pinch.y0), mouseMode.value ? p.x : e.touches[0].clientX, mouseMode.value ? p.y : e.touches[0].clientY);
      pinch.y0 = y;
    }
    return;
  }
  if (e.touches.length !== 1 || !last || !start) return;
  const t = e.touches[0];
  const dx = t.clientX - last.x;
  const dy = t.clientY - last.y;
  last = { x: t.clientX, y: t.clientY };
  if (Math.abs(t.clientX - start.x) > TAP_MOVE || Math.abs(t.clientY - start.y) > TAP_MOVE) moved = true;
  if (mouseMode.value) {
    const r = hostRect();
    pointer.x = Math.min(r.width - 1, Math.max(0, pointer.x + dx));
    pointer.y = Math.min(r.height - 1, Math.max(0, pointer.y + dy));
  } else if (moved) {
    wheel(props.term, -dy, t.clientX, t.clientY);
  }
}
function onEnd(e: TouchEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (pinch) {
    if (e.touches.length < 2) pinch = null;
    if (e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return;
  }
  if (start && !moved && e.touches.length === 0 && Date.now() - start.at < TAP_MS) {
    if (mouseMode.value) {
      const p = pointerClient();
      click(props.term, p.x, p.y);
    } else {
      focusTerminal(props.term);
    }
  }
  if (e.touches.length === 0) {
    start = null;
    last = null;
  }
}

// ---- 키바. pointerdown 에서 처리하고 기본 동작을 막아 xterm 의 textarea 가 포커스를 잃지 않게 (키보드가 내려가지 않는다).
//      화살표는 누르고 있으면 반복. 맨 끝은 마우스 모드 토글
const KEYS: { key: BarKey; label: string; icon?: string; repeat?: boolean }[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'up', label: '↑', icon: 'arrow-up', repeat: true },
  { key: 'down', label: '↓', icon: 'arrow-down', repeat: true },
  { key: 'left', label: '←', icon: 'arrow-left', repeat: true },
  { key: 'right', label: '→', icon: 'arrow-right', repeat: true },
];
const MODS: { mod: Mod; label: string }[] = [
  { mod: 'ctrl', label: 'Ctrl' },
  { mod: 'shift', label: 'Shift' },
  { mod: 'alt', label: 'Alt' },
];
let repeatTimer: ReturnType<typeof setTimeout> | null = null;
let repeatIv: ReturnType<typeof setInterval> | null = null;
function keyDown(e: PointerEvent, k: (typeof KEYS)[number]): void {
  e.preventDefault();
  pressKey(props.term, k.key);
  if (!k.repeat) return;
  stopRepeat();
  repeatTimer = setTimeout(() => {
    repeatIv = setInterval(() => pressKey(props.term, k.key), 60);
  }, 400);
}
function stopRepeat(): void {
  if (repeatTimer) clearTimeout(repeatTimer);
  if (repeatIv) clearInterval(repeatIv);
  repeatTimer = repeatIv = null;
}
function modDown(e: PointerEvent, m: Mod): void {
  e.preventDefault();
  toggleMod(m);
}
function toggleMouse(e: PointerEvent): void {
  e.preventDefault();
  mouseMode.value = !mouseMode.value;
  focusTerminal(props.term);
}
</script>

<template>
  <div class="term-pane">
    <div
      class="term-wrap"
      :style="{ background: TERMINAL_BACKGROUND }"
      @touchstart="onStart"
      @touchmove="onMove"
      @touchend="onEnd"
      @touchcancel="onEnd"
      @contextmenu.prevent
    >
      <div ref="host" class="term-host" />
      <div v-if="mouseMode" class="pointer" :style="{ left: `${pointer.x}px`, top: `${pointer.y}px` }" />
    </div>
    <div class="keybar">
      <button v-for="m in MODS" :key="m.mod" :class="{ on: mods[m.mod] }" @pointerdown="modDown($event, m.mod)">{{ m.label }}</button>
      <button
        v-for="k in KEYS"
        :key="k.key"
        @pointerdown="keyDown($event, k)"
        @pointerup="stopRepeat"
        @pointercancel="stopRepeat"
        @pointerleave="stopRepeat"
      >
        <span v-if="k.icon" class="codicon" :class="`codicon-${k.icon}`" />
        <template v-else>{{ k.label }}</template>
      </button>
      <button class="mouse" :class="{ on: mouseMode }" title="Mouse mode" @pointerdown="toggleMouse"><span class="codicon codicon-inspect" /></button>
    </div>
  </div>
</template>

<style scoped>
.term-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.term-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  padding: 4px;
  box-sizing: border-box;
}
.term-host {
  position: relative;
  width: 100%;
  height: 100%;
}
.term-host :deep(.term-attach) {
  position: relative;
  width: 100%;
  height: 100%;
}
.term-host :deep(.xterm) {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
}
.term-host :deep(.xterm .xterm-viewport) {
  background: v-bind(TERMINAL_BACKGROUND) !important;
}
.pointer {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: rgba(55, 148, 255, 0.5);
  box-shadow: 0 0 4px #000;
  pointer-events: none;
}
.keybar {
  display: flex;
  height: 44px;
  flex-shrink: 0;
  gap: 4px;
  padding: 4px;
  box-sizing: border-box;
  background: var(--vscode-activityBar-background, #181818);
  border-top: 1px solid var(--vscode-widget-border, #2b2b2b);
  touch-action: none;
}
.keybar button {
  flex: 1;
  min-width: 0;
  border-radius: 6px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  font-size: 14px;
  user-select: none;
}
.keybar button.on {
  background: var(--sl-accent, #0e639c);
  color: #fff;
}
.keybar button.mouse {
  background: none;
  border: 1px solid var(--vscode-button-secondaryBackground, #3a3d41);
}
.keybar button.mouse.on {
  background: var(--sl-accent, #0e639c);
}
.keybar .codicon {
  font-size: 18px;
}
</style>
