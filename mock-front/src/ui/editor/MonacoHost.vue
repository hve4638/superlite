<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorGroup } from '../../model/editors';
import { editors, indentOf } from '../../model/editors';
import { openQuickInput } from '../../model/workbench';
import { EDITOR_OPTIONS, modelFor, monaco, originalModelFor } from './monaco';

const props = defineProps<{ group: EditorGroup }>();

const codeHost = ref<HTMLElement | null>(null);
const diffHost = ref<HTMLElement | null>(null);

const active = computed(() => props.group.tabs.find((t) => t.id === props.group.activeTabId) ?? null);
const mode = computed(() => active.value?.kind ?? 'file');

let codeEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

function ensureCodeEditor(): monaco.editor.IStandaloneCodeEditor {
  if (!codeEditor) {
    codeEditor = monaco.editor.create(codeHost.value!, { ...EDITOR_OPTIONS, model: null });
    codeEditor.onDidChangeCursorPosition((e) => {
      if (editors.activeGroupId === props.group.id) {
        editors.cursor = { line: e.position.lineNumber, col: e.position.column };
      }
    });
    // WHY: monaco 는 F1 을 자체 커맨드 팔레트에 바인딩한다 — 워크벤치 팔레트로 대체
    codeEditor.addCommand(monaco.KeyCode.F1, () => openQuickInput('commands'));
  }
  return codeEditor;
}

function ensureDiffEditor(): monaco.editor.IStandaloneDiffEditor {
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(diffHost.value!, { ...EDITOR_OPTIONS, automaticLayout: true });
    const modified = diffEditor.getModifiedEditor();
    modified.onDidChangeCursorPosition((e) => {
      if (editors.activeGroupId === props.group.id) {
        editors.cursor = { line: e.position.lineNumber, col: e.position.column };
      }
    });
    modified.addCommand(monaco.KeyCode.F1, () => openQuickInput('commands'));
  }
  return diffEditor;
}

/** pendingReveal(검색 결과 클릭 등)을 이 그룹의 활성 파일이 소유하면 소비한다 */
function consumeReveal(ed: monaco.editor.IStandaloneCodeEditor, path: string) {
  const req = editors.pendingReveal;
  if (!req || req.path !== path || editors.activeGroupId !== props.group.id) return;
  ed.revealLineInCenter(req.line);
  ed.setPosition({ lineNumber: req.line, column: 1 });
  editors.pendingReveal = null;
}

async function sync() {
  const tab = active.value;
  if (!tab) return;
  if (tab.kind === 'file') {
    const ed = ensureCodeEditor();
    const model = modelFor(tab.path);
    model.updateOptions({ tabSize: indentOf(tab.path) });
    if (ed.getModel() !== model) ed.setModel(model);
    consumeReveal(ed, tab.path);
    if (editors.activeGroupId === props.group.id) {
      const pos = ed.getPosition();
      if (pos) editors.cursor = { line: pos.lineNumber, col: pos.column };
      // WHY: 파일을 연 직후 바로 타이핑할 수 있어야 한다 (VS Code 는 오픈 시 에디터에 포커스)
      ed.focus();
    }
  } else {
    const ed = ensureDiffEditor();
    const modified = modelFor(tab.path);
    const original = await originalModelFor(tab.path);
    if (active.value?.id !== tab.id) return; // WHY: await 사이에 탭이 바뀌었을 수 있다
    const cur = ed.getModel();
    if (!cur || cur.modified !== modified || cur.original !== original) {
      ed.setModel({ original, modified });
    }
    if (editors.activeGroupId === props.group.id) ed.getModifiedEditor().focus();
  }
}

onMounted(() => {
  void sync();
  watch(() => props.group.activeTabId, () => void sync(), { flush: 'post' });
  watch(
    () => editors.pendingReveal,
    (req) => {
      if (!req || !codeEditor) return;
      const tab = active.value;
      if (!tab || tab.kind !== 'file') return;
      consumeReveal(codeEditor, tab.path);
    },
    { flush: 'post' },
  );
});

onBeforeUnmount(() => {
  // WHY: 모델은 모듈 캐시(다른 그룹과 공유)라 남기고, 에디터 인스턴스만 정리한다
  codeEditor?.dispose();
  diffEditor?.dispose();
});
</script>

<template>
  <div class="monaco-host">
    <div v-show="mode === 'file'" ref="codeHost" class="editor-mount" />
    <div v-show="mode === 'diff'" ref="diffHost" class="editor-mount" />
  </div>
</template>

<style scoped>
.monaco-host {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--vscode-editor-background);
}
.editor-mount {
  position: absolute;
  inset: 0;
}
</style>
