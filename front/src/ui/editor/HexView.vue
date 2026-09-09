<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { editors, ensureHex, HEX_CHUNK, loadHexChunk } from '../../model/editors';

// hex 뷰어 — HxD 식 3열(offset / 16바이트 hex / ASCII). 보이는 행만 그리고, 바이트도 보이는
// 행이 걸친 청크만 범위 읽기로 가져온다 (editors.hex 의 HexDoc — 크기는 ensureHex, 청크는
// loadHexChunk). GB 파일: 총 높이가 브라우저 요소 높이 한계를 넘으면 스크롤 트랙을 축척해
// scrollTop 을 행 인덱스로 사상한다 — 렌더 행은 scrollTop 을 따라가는 컨테이너 안에 상대 배치라
// 트랙 높이와 무관하다. ponytail: 뷰어 전용 — 편집·선택·검색 없음
const props = defineProps<{ path: string }>();

const ROW_BYTES = 16;
const ROW_H = 20;
/** 화면 밖 여유 행 — 스크롤 중 빈 줄이 비치지 않게 */
const OVERSCAN = 8;
/** 스크롤 트랙 높이 상한 — Chrome 의 요소 높이 한계(약 33M px) 아래. 넘는 파일은 축척 */
const TRACK_MAX = 16_000_000;

const doc = computed(() => editors.hex.get(props.path));
watchEffect(() => {
  if (doc.value === undefined) void ensureHex(props.path);
});

const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewH = ref(0);

let ro: ResizeObserver | null = null;
onMounted(() => {
  const el = scroller.value;
  if (!el) return;
  viewH.value = el.clientHeight;
  ro = new ResizeObserver(() => (viewH.value = el.clientHeight));
  ro.observe(el);
});
onBeforeUnmount(() => ro?.disconnect());

const rowCount = computed(() => (doc.value ? Math.ceil(doc.value.size / ROW_BYTES) : 0));
// 헤더 1행 + 본문 — 축척 전 실제 높이
const fullH = computed(() => (rowCount.value + 1) * ROW_H);
const trackH = computed(() => Math.min(fullH.value, TRACK_MAX));
const scale = computed(() => trackH.value / Math.max(fullH.value, 1));

const visibleRows = computed(() => Math.ceil(viewH.value / ROW_H));
/** 뷰포트 상단에 오는 행 — 축척 시 scrollTop 을 행으로 사상 (트랙 끝이 마지막 행에 오도록) */
const topRow = computed(() => {
  if (scale.value === 1) return Math.floor(scrollTop.value / ROW_H);
  const maxTop = Math.max(trackH.value - viewH.value, 1);
  // 헤더가 한 행을 차지하므로 트랙 끝에서 마지막 행이 뷰포트 안에 들어오게 1행 덜 뺀다
  return Math.floor((scrollTop.value / maxTop) * Math.max(rowCount.value - visibleRows.value + 1, 0));
});
const firstRow = computed(() => Math.max(0, topRow.value - OVERSCAN));
const lastRow = computed(() => Math.min(rowCount.value, topRow.value + visibleRows.value + OVERSCAN));
// 축척 없을 때는 절대 위치(행 경계 사이 픽셀 오프셋 유지 — 부드러운 스크롤). 축척 시엔 topRow 가
// 뷰포트 상단(헤더 아래)에 오도록 렌더 창을 scrollTop 에 붙이고 행 단위로 스냅
const containerTop = computed(() =>
  scale.value === 1 ? firstRow.value * ROW_H : scrollTop.value - (topRow.value - firstRow.value) * ROW_H,
);

// 보이는 행이 걸친 청크(±1 선읽기)를 요청한다 — 이미 있거나 진행 중이면 loadHexChunk 가 거른다
watchEffect(() => {
  const d = doc.value;
  if (!d || rowCount.value === 0) return;
  const c0 = Math.max(0, Math.floor((firstRow.value * ROW_BYTES) / HEX_CHUNK) - 1);
  const c1 = Math.min(Math.ceil(d.size / HEX_CHUNK) - 1, Math.floor((lastRow.value * ROW_BYTES) / HEX_CHUNK) + 1);
  for (let c = c0; c <= c1; c++) void loadHexChunk(props.path, c);
});

const rows = computed(() => {
  const d = doc.value;
  if (!d) return [];
  const out: { i: number; offset: string; hex: string; ascii: string }[] = [];
  for (let i = firstRow.value; i < lastRow.value; i++) {
    const start = i * ROW_BYTES;
    const end = Math.min(start + ROW_BYTES, d.size);
    const chunk = d.chunks.get(Math.floor(start / HEX_CHUNK));
    let hex = '';
    let ascii = '';
    for (let j = start; j < end; j++) {
      const v = chunk?.[j % HEX_CHUNK];
      // 미도착 청크는 빈 칸 — 도착하면 chunks(반응형)가 이 computed 를 다시 돌린다
      hex += (j > start ? ' ' : '') + (v === undefined ? '  ' : v.toString(16).padStart(2, '0').toUpperCase());
      // 출력 가능한 ASCII 만 — 나머지는 HxD 처럼 '.' (제어·0x7F 이상)
      ascii += v === undefined ? ' ' : v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '.';
    }
    out.push({ i, offset: start.toString(16).padStart(8, '0').toUpperCase(), hex, ascii });
  }
  return out;
});
</script>

<template>
  <div ref="scroller" class="hex-scroll" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
    <div v-if="doc" class="hex-track" :style="{ height: `${trackH}px` }">
      <div class="hex-window" :style="{ top: `${containerTop}px` }">
        <div class="hex-head" :style="{ top: `${scrollTop - containerTop}px` }">
          <span class="offset">Offset(h)</span>
          <span class="hex">00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F</span>
          <span class="ascii">Decoded text</span>
        </div>
        <div v-for="r in rows" :key="r.i" class="hex-row" :style="{ top: `${(r.i - firstRow + 1) * ROW_H}px` }">
          <span class="offset">{{ r.offset }}</span>
          <span class="hex">{{ r.hex }}</span>
          <span class="ascii">{{ r.ascii }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hex-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: monospace;
  font-size: 13px;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
}
.hex-track {
  position: relative;
  white-space: pre;
}
/* 렌더 창 — scrollTop 을 따라가며 그 안에 행을 상대 배치 (트랙 높이와 무관) */
.hex-window {
  position: absolute;
  left: 0;
  right: 0;
}
.hex-head,
.hex-row {
  position: absolute;
  left: 0;
  right: 0;
  height: 20px;
  line-height: 20px;
  display: flex;
}
/* 헤더는 항상 뷰포트 상단 — 렌더 창 기준 (scrollTop - containerTop) 에 둔다 */
.hex-head {
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  z-index: 1;
}
.offset {
  width: 10ch;
  flex-shrink: 0;
  padding-left: 12px;
  color: var(--vscode-editorLineNumber-foreground);
}
.hex {
  width: 49ch;
  flex-shrink: 0;
  padding-left: 12px;
}
.ascii {
  padding-left: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>
