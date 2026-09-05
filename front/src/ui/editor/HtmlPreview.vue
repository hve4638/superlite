<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { editors } from '../../model/editors';

// HTML 프리뷰 — 같은 path 의 편집 버퍼(doc.content)를 sandbox iframe srcdoc 으로 렌더한다.
// 타이핑마다 iframe 이 다시 뜨므로 디바운스. allow-same-origin 을 주지 않아 문서 스크립트가
// 앱 DOM·저장소에 닿지 못한다. ponytail: 상대 경로 리소스(css·img)는 해석되지 않는다 —
// 서빙 서버가 없다. 필요해지면 데몬 readFile 로 인라인 치환.
const props = defineProps<{ path: string }>();

const DEBOUNCE_MS = 300;
const html = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => editors.docs.get(props.path)?.content ?? '',
  (content) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      html.value = content;
    }, html.value === '' ? 0 : DEBOUNCE_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer);
});
</script>

<template>
  <iframe class="html-preview" :srcdoc="html" sandbox="allow-scripts" :title="path" />
</template>

<style scoped>
.html-preview {
  flex: 1;
  min-height: 0;
  border: 0;
  background: #fff;
}
</style>
