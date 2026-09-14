<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { editors, indentOf, overwriteConflict, revertConflict } from '../../model/editors';
import { EDITOR_OPTIONS, modelFor, monaco } from '../editor/monaco';

// 파일 탭 본문 (ticket mobile-shell) — Monaco 하나. 미니맵·자동완성 팝업·접기 없음, 자동 줄바꿈. vim 모드 없음 (normal 이
// readOnly 라 소프트 키보드가 뜨지 않는다 — decision/mobile.md). 문서·dirty·저장·충돌은 model/editors 그대로 — 탭은 이미
// openFile 이 열었고 문서를 읽었다(없으면 도착을 기다린다), modelFor 가 모델을 만든다. 파일 탭 사이 전환은 path 가 바뀌어
// 모델만 갈아끼운다 (편집기 인스턴스 유지). 저장 버튼은 EditorArea 헤더
const props = defineProps<{ path: string }>();
const host = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

const doc = computed(() => editors.docs.get(props.path));
const blocked = computed(() => {
  const d = doc.value;
  if (!d) return null;
  if (d.unopenable) return d.unopenable.kind === 'large' ? `File too large (${Math.round(d.unopenable.size / 1024)} KB)` : 'Binary file';
  if (d.image !== undefined) return 'Image';
  return null;
});
const conflict = computed(() => editors.saveConflict === props.path);

async function show(): Promise<void> {
  await nextTick(); // v-else 로 편집기 div 가 생긴 뒤
  if (doc.value === undefined || blocked.value !== null || !host.value) {
    editor?.dispose(); // 안내 화면이 편집기 div 를 없앴다 — 다음 파일 탭에서 새로 만든다
    editor = null;
    return;
  }
  const model = modelFor(props.path);
  model.updateOptions({ tabSize: indentOf(props.path) });
  if (editor) {
    editor.setModel(model);
    editor.updateOptions({ readOnly: doc.value.readOnly === true });
    return;
  }
  editor = monaco.editor.create(host.value, {
    ...EDITOR_OPTIONS,
    model,
    readOnly: doc.value.readOnly === true,
    fontSize: 13,
    minimap: { enabled: false },
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 6,
    lineNumbersMinChars: 3,
    wordWrap: 'on',
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    hover: { enabled: 'off' },
    contextmenu: false,
    scrollBeyondLastLine: false,
  });
}

onMounted(() => void show());
// 탭 전환(path) 또는 문서 도착·열 수 있게 됨(없음 → 있음, unopenable 변화)
watch(() => [props.path, doc.value === undefined, blocked.value], () => void show());
onBeforeUnmount(() => {
  editor?.dispose(); // 모델은 모듈 캐시(문서와 함께 산다)
});
</script>

<template>
  <div class="editor-pane">
    <div v-if="conflict" class="m-banner">
      <span class="msg">File changed on disk</span>
      <button @click="overwriteConflict()">Overwrite</button>
      <button @click="revertConflict()">Revert</button>
    </div>
    <div v-if="doc === undefined" class="m-empty">Loading…</div>
    <div v-else-if="blocked" class="m-empty">{{ blocked }}</div>
    <div v-else ref="host" class="editor" />
  </div>
</template>

<style scoped>
.editor-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.editor {
  flex: 1;
  min-height: 0;
  user-select: text;
}
</style>
