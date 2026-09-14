<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { editors, previewReloadTick, viewerAutoReload } from '../../model/editors';
import { sessions } from '../../model/sessions';
import { forgetPreviewScroll, previewScrollOf, setPreviewScroll } from './previewScroll';

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

// WHY: 첫 렌더는 동기로 채우고 iframe 은 html 이 있을 때만 붙인다(v-if) — srcdoc 빈 iframe 을 먼저
//      만들고 곧바로 바꾸면 초기 about:blank 로드와 경합해 srcdoc 항해가 무시되어 빈 화면이 남는다
const html = ref('');
// 수동 갱신은 내용이 같아도 iframe 을 다시 만든다 (srcdoc 불변이면 Vue 가 갱신하지 않는다)
const frameKey = ref(0);

// 스크롤 보존 (ticket tab-switch-view-reload) — 세션 전환 재마운트·수동/자동 갱신은 문서를 새로 로드하므로, 문서 끝에
// 주입한 스크립트가 스크롤마다 위치를 부모에 알리고 load 뒤 부모가 보낸 위치로 되돌린다. 위치를 srcdoc 에 굽지 않는
// 이유: srcdoc 이 바뀌면 그 자체로 재로드된다. 새 프레임은 복원이 끝날 때까지 숨긴다 (맨 위가 보였다 튀지 않게,
// 흰 번쩍임 대신 편집기 배경) — 같은 프레임의 srcdoc 교체(자동 갱신)는 옛 문서가 남아 있으므로 숨기지 않는다.
// ponytail: 로드 뒤에 늦게 길어지는 문서(지연 이미지 등)는 덜 복원된다. 문서의 CSP 가 인라인 스크립트를 막으면 보존 없음
const SCROLL_SCRIPT = `<script>(function(){
addEventListener('scroll',function(){parent.postMessage({superlitePreviewScroll:[scrollX,scrollY]},'*')},{passive:true});
addEventListener('message',function(e){var p=e.data&&e.data.superlitePreviewRestore;if(p)scrollTo(p[0],p[1])});
})()</` + `script>`;
const srcdoc = computed(() => html.value + SCROLL_SCRIPT);
const session = sessions.activeId;
const shown = ref(false);

function onLoad() {
  const pos = previewScrollOf(session, props.path);
  if (pos) frame.value?.contentWindow?.postMessage({ superlitePreviewRestore: pos }, '*');
  // 메시지는 다음 태스크에 처리된다 — 한 프레임 뒤에 보인다
  requestAnimationFrame(() => { shown.value = true; });
}
function onMessage(e: MessageEvent) {
  if (frame.value === null || e.source !== frame.value.contentWindow) return;
  const pos = (e.data as { superlitePreviewScroll?: [number, number] } | null)?.superlitePreviewScroll;
  if (Array.isArray(pos)) setPreviewScroll(session, props.path, pos);
}

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
      shown.value = false;
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
onMounted(() => {
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('message', onMessage);
});
onBeforeUnmount(() => {
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('message', onMessage);
  // 세션 전환 재마운트면 활성 세션이 이미 바뀌어 있다 — 위치를 남긴다. 같은 세션에서 사라졌는데 탭도 없으면(닫기·
  // Show Source) 잊는다. 그룹 간 이동은 탭이 남아 있으므로 유지
  if (sessions.activeId !== session) return;
  const id = `preview:${props.path}`;
  const alive = editors.groups.some((g) => g.tabs.some((t) => t.id === id || t.cards?.tabs.some((c) => c.id === id)));
  if (!alive) forgetPreviewScroll(session, props.path);
});
</script>

<template>
  <div class="html-preview">
    <iframe
      v-if="html !== ''"
      ref="frame"
      :key="frameKey"
      class="frame"
      :class="{ shown }"
      :srcdoc="srcdoc"
      sandbox="allow-scripts"
      :title="path"
      @load="onLoad"
    />
  </div>
</template>

<style scoped>
.html-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
}
.frame {
  flex: 1;
  min-height: 0;
  border: 0;
  background: #fff;
  visibility: hidden;
}
.frame.shown {
  visibility: visible;
}
</style>
