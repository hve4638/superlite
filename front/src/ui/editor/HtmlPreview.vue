<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { editors, previewReloadTick, viewerAutoReload } from '../../model/editors';

// HTML 프리뷰 — 같은 path 의 저장된 내용(doc.savedContent = 디스크 기준)을 sandbox iframe srcdoc 으로
// 렌더한다. 편집 버퍼는 반영하지 않는다 — 저장하거나 외부(다른 도구·git)에서 바뀌어 재로드될 때 다시
// 그린다. allow-same-origin 을 주지 않아 문서 스크립트가 앱 DOM·저장소에 닿지 못한다.
// ponytail: 상대 경로 리소스(css·img)는 해석되지 않는다 — 서빙 서버가 없다. 필요해지면 데몬 readFile 로
// 인라인 치환. dirty 버퍼가 있는 동안의 외부 변경은 에디터 규칙대로 재로드되지 않으므로 프리뷰도 안 바뀐다
// (저장 시 충돌 처리가 맡는다).
// 자동 갱신(viewerAutoReload.html)이 off 면 저장·외부 변경을 따라가지 않고 마지막 렌더를 유지한다 —
// 탭바 "Reload Preview"(previewReloadTick)가 즉시 다시 그리고, on 으로 켜면 동기화.
const props = defineProps<{ path: string }>();
// iframe 안의 클릭은 부모에 mousedown 이 오지 않아 그룹 활성화(EditorGroupView.focusGroup)가 빠진다 —
// 포커스가 iframe 으로 넘어가면 window 가 blur 되므로 그때 활성 요소를 보고 알린다
const emit = defineEmits<{ focus: [] }>();
const frame = ref<HTMLIFrameElement | null>(null);
function onWindowBlur() {
  if (frame.value !== null && document.activeElement === frame.value) emit('focus');
}
onMounted(() => window.addEventListener('blur', onWindowBlur));

// WHY: 첫 렌더는 동기로 채우고 iframe 은 html 이 있을 때만 붙인다(v-if) — srcdoc 빈 iframe 을 먼저
//      만들고 곧바로 바꾸면 초기 about:blank 로드와 경합해 srcdoc 항해가 무시되어 빈 화면이 남는다
const html = ref('');
// 수동 갱신은 내용이 같아도 iframe 을 다시 만든다 (srcdoc 불변이면 Vue 가 갱신하지 않는다)
const frameKey = ref(0);

watch(
  () => [
    editors.docs.get(props.path)?.savedContent ?? '',
    viewerAutoReload.html,
    previewReloadTick.get(props.path) ?? 0,
  ] as const,
  ([content, auto, tick], old) => {
    const manual = old !== undefined && tick !== old[2];
    if (manual) {
      html.value = content;
      frameKey.value++;
      return;
    }
    if (html.value === '') {
      html.value = content; // 첫 렌더 — off 여도 그린다
      return;
    }
    if (auto) html.value = content;
  },
  { immediate: true },
);
onBeforeUnmount(() => window.removeEventListener('blur', onWindowBlur));
</script>

<template>
  <iframe v-if="html !== ''" ref="frame" :key="frameKey" class="html-preview" :srcdoc="html" sandbox="allow-scripts" :title="path" />
</template>

<style scoped>
.html-preview {
  flex: 1;
  min-height: 0;
  border: 0;
  background: #fff;
}
</style>
