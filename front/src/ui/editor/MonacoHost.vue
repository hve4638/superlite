<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorGroup } from '../../model/editors';
import { editors, indentOf } from '../../model/editors';
import { scm } from '../../model/scm';
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
      // WHY: 포커스는 요청된 경우만 — 트리 단일 클릭(preview)은 포커스가 트리에 남아야
      //      Delete 가 파일 삭제로 이어진다 (VS Code 동일). scm.head 갱신 sync 도 포커스를 안 뺏는다
      if (editors.pendingFocus) {
        editors.pendingFocus = false;
        ed.focus();
      }
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
    if (editors.activeGroupId === props.group.id && editors.pendingFocus) {
      editors.pendingFocus = false;
      ed.getModifiedEditor().focus();
    }
  }
}

onMounted(() => {
  void sync();
  watch(() => props.group.activeTabId, () => void sync(), { flush: 'post' });
  // HEAD 가 움직이면(앱 밖 커밋 포함) 열려 있는 diff 탭의 original 도 갈아끼운다 —
  // 탭 재활성화를 기다리지 않는다. 파일 탭이면 sync 는 모델 동일성 검사로 no-op
  watch(() => scm.head, () => void sync(), { flush: 'post' });
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
