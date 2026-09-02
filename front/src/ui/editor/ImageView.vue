<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { editors, imageMime } from '../../model/editors';

// 이미지 뷰어 — 체커보드 배경, 영역 전체에서 휠 줌(커서 지점 고정)·드래그 팬,
// 더블클릭으로 fit 복귀. 해상도·크기·배율 표시는 statusbar 몫 (editors.imageView 를
// 여기서 세우고 statusbar 가 읽는다). 데이터는 doc.image(base64)에서 온다.
const props = defineProps<{ path: string; data: string }>();

/** 휠 줌 배율 한계 — VS Code 이미지 프리뷰의 min 10% / max 2000% 와 동일 */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 20;

const scroller = ref<HTMLElement | null>(null);
const img = ref<HTMLImageElement | null>(null);

const iv = computed(() => editors.imageView.get(props.path));
const src = computed(() => `data:${imageMime(props.path)};base64,${props.data}`);

// 숫자 배율이면 원본 크기 x 배율로 고정 폭 — fit 은 CSS(contain)가 맡는다
const imgStyle = computed(() => {
  const v = iv.value;
  if (!v || v.zoom === 'fit') return undefined;
  return { width: `${v.w * v.zoom}px` };
});

function onLoad(e: Event) {
  const el = e.target as HTMLImageElement;
  // 배율은 유지 — 외부 변경 재로드(src 교체)가 사용자의 줌 상태를 되돌리지 않는다
  editors.imageView.set(props.path, {
    w: el.naturalWidth, h: el.naturalHeight, zoom: iv.value?.zoom ?? 'fit',
  });
}

/** 휠 줌 — 커서가 가리키는 이미지 지점이 줌 후에도 같은 화면 위치에 오도록 스크롤 보정 */
async function onWheel(e: WheelEvent) {
  const v = iv.value;
  const el = scroller.value;
  const im = img.value;
  if (!v || !el || !im) return;
  const rect = im.getBoundingClientRect();
  // 현재 배율은 실측(fit 상태 포함) — 커서의 이미지 내 상대 지점도 여기서 잡는다
  const cur = rect.width / v.w;
  const px = (e.clientX - rect.left) / rect.width;
  const py = (e.clientY - rect.top) / rect.height;
  // 지수 스텝 — 트랙패드의 잦은 소량 delta 와 휠 틱(±100) 양쪽에서 매끄럽다
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur * Math.pow(2, -e.deltaY / 400)));
  v.zoom = next;
  await nextTick();
  const nrect = im.getBoundingClientRect();
  el.scrollLeft += nrect.left + px * nrect.width - e.clientX;
  el.scrollTop += nrect.top + py * nrect.height - e.clientY;
}

// 드래그 팬 — 스크롤 컨테이너를 마우스로 끈다 (fit 등 오버플로 없는 상태에선 no-op)
const drag = ref<{ x: number; y: number } | null>(null);
function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  drag.value = { x: e.clientX, y: e.clientY };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  const el = scroller.value;
  if (!drag.value || !el) return;
  el.scrollLeft -= e.clientX - drag.value.x;
  el.scrollTop -= e.clientY - drag.value.y;
  drag.value = { x: e.clientX, y: e.clientY };
}
function onPointerUp() {
  drag.value = null;
}
</script>

<template>
  <div
    ref="scroller"
    class="image-scroll"
    :class="{ fit: !iv || iv.zoom === 'fit', dragging: drag }"
    @wheel.prevent="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="iv && (iv.zoom = 'fit')"
  >
    <img ref="img" :src="src" :alt="path" :style="imgStyle" draggable="false" @load="onLoad" />
  </div>
</template>

<style scoped>
.image-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  cursor: grab;
  user-select: none;
  /* 투명 이미지 판별용 체커보드 — 테마 변수가 없어 편집기 배경 위 저대비 회색으로 근사 */
  background:
    repeating-conic-gradient(rgba(128, 128, 128, 0.14) 0% 25%, transparent 0% 50%)
    0 0 / 20px 20px;
}
.image-scroll.dragging {
  cursor: grabbing;
}
.image-scroll.fit {
  align-items: center;
  justify-content: center;
}
.image-scroll.fit img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.image-scroll img {
  /* 스크롤 컨테이너(flex)가 이미지를 줄이지 않게 고유 크기를 고정하고, 작으면 중앙에 */
  flex-shrink: 0;
  margin: auto;
}
</style>
