<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { DiffTab } from '../../model/editors';
import { EDITOR_OPTIONS, modelFor, monaco, originalModelFor } from '../editor/monaco';

// diff 탭 본문 (ticket mobile-shell) — 편집기 영역의 diff 탭(model/editors.openDiff 가 만든 데스크톱과 같은 탭). 폰 폭이라
// 나란히가 아니라 인라인, 읽기 전용. 삭제 파일은 HEAD 내용만 코드 편집기로. 편집은 파일 탭에서 (untracked·added 는 SCM 이
// 곧장 파일 탭으로 연다). 커밋 diff 는 모바일 진입점이 없다
const props = defineProps<{ tab: DiffTab }>();
const host = ref<HTMLElement | null>(null);
const failed = ref(false);
let diff: monaco.editor.IStandaloneDiffEditor | null = null;
let code: monaco.editor.IStandaloneCodeEditor | null = null;
const OPTS = {
  ...EDITOR_OPTIONS, readOnly: true, fontSize: 12, minimap: { enabled: false }, glyphMargin: false, folding: false,
  lineNumbersMinChars: 3, wordWrap: 'on' as const, hover: { enabled: 'off' as const }, contextmenu: false, scrollBeyondLastLine: false,
};

onMounted(async () => {
  if (!host.value) return;
  try {
    const original = await originalModelFor(props.tab.path);
    if (!host.value) return;
    if (props.tab.deleted) {
      code = monaco.editor.create(host.value, { ...OPTS, model: original });
      return;
    }
    diff = monaco.editor.createDiffEditor(host.value, { ...OPTS, renderSideBySide: false, automaticLayout: true });
    diff.setModel({ original, modified: modelFor(props.tab.path) });
  } catch {
    failed.value = true;
  }
});
onBeforeUnmount(() => {
  diff?.dispose();
  code?.dispose();
});
</script>

<template>
  <div v-if="failed" class="m-empty">Unable to open</div>
  <div v-else ref="host" class="editor" />
</template>

<style scoped>
.editor {
  flex: 1;
  min-height: 0;
  user-select: text;
}
</style>
