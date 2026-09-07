<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorGroup } from '../../model/editors';
import { editorView, editors, indentOf } from '../../model/editors';
import { scm } from '../../model/scm';
import { openQuickInput } from '../../model/workbench';
import { EDITOR_OPTIONS, modelFor, monaco, originalModelFor } from './monaco';
import { EDITOR_FONT_SIZE } from '../../theme/fonts';

const props = defineProps<{ group: EditorGroup }>();

const codeHost = ref<HTMLElement | null>(null);
const diffHost = ref<HTMLElement | null>(null);

const active = computed(() => props.group.tabs.find((t) => t.id === props.group.activeTabId) ?? null);
// 삭제 파일 탭(diff.deleted)은 diff 편집기가 아니라 코드 편집기에 HEAD 모델을 읽기 전용으로 올린다
const mode = computed(() => (active.value?.kind === 'diff' && !active.value.deleted ? 'diff' : 'file'));

let codeEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;

// 전 에디터 공통 뷰 옵션 — 자동 줄바꿈(Alt+Z)과 편집기 줌(상태바 배율 — 기본 14px 에 퍼센트 적용,
// lineHeight 는 미지정이라 monaco 가 글꼴에 맞춰 다시 계산한다)
const wrapOpt = () => ({
  wordWrap: editorView.wordWrap ? 'on' : 'off',
  fontSize: Math.round((EDITOR_FONT_SIZE * editorView.zoom) / 100),
} as const);
// 변경을 이 그룹의 편집기 둘에 반영 — 생성 시점 값은 각 ensure 가 넣는다
watch(() => [editorView.wordWrap, editorView.zoom], () => {
  codeEditor?.updateOptions(wrapOpt());
  diffEditor?.updateOptions(wrapOpt());
});

function ensureCodeEditor(): monaco.editor.IStandaloneCodeEditor {
  if (!codeEditor) {
    codeEditor = monaco.editor.create(codeHost.value!, { ...EDITOR_OPTIONS, ...wrapOpt(), model: null });
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
    diffEditor = monaco.editor.createDiffEditor(diffHost.value!, { ...EDITOR_OPTIONS, ...wrapOpt(), automaticLayout: true });
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

/** 포커스를 다음 tick 으로 — WHY: 이 sync 는 post 워처인데 부모(EditorGroupView)의 v-show="!overlay"
 *  반영이 그 뒤에 온다. 터미널·hex·프리뷰 탭에서 파일 탭으로 옮길 때 호스트가 아직 display:none 이라
 *  focus() 가 무시된다. 요청(pendingFocus)은 호출측이 이미 소비했다 */
function focusLater(ed: monaco.editor.ICodeEditor) {
  void nextTick(() => ed.focus());
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
  // 열 수 없는 문서(크기 초과·이진)·이미지 문서는 모델을 만들지 않는다 — 안내 화면·이미지
  // 뷰어(EditorGroupView)가 편집기를 가리고 있고, diff 쪽은 이진의 gitOriginalContent 요청
  // 자체를 피해야 한다
  // hex·preview·terminal 탭도 모델 없음 — 전용 뷰가 편집기를 가린다
  if (tab.kind === 'hex' || tab.kind === 'preview' || tab.kind === 'terminal') return;
  const doc = editors.docs.get(tab.path);
  if (doc?.unopenable !== undefined || doc?.image !== undefined) return;
  // 아직 안 읽힌 파일 탭 — 모델을 만들면 '' 로 굳는다. docs 워처가 도착 시 다시 sync 한다
  if (tab.kind === 'file' && doc === undefined) return;
  if (tab.kind === 'diff' && tab.deleted) {
    const ed = ensureCodeEditor();
    const model = await originalModelFor(tab.path);
    if (active.value?.id !== tab.id) return; // WHY: await 사이에 탭이 바뀌었을 수 있다
    ed.updateOptions({ readOnly: true });
    if (ed.getModel() !== model) ed.setModel(model);
    if (editors.activeGroupId === props.group.id && editors.pendingFocus) {
      editors.pendingFocus = false;
      focusLater(ed);
    }
    return;
  }
  if (tab.kind === 'file') {
    const ed = ensureCodeEditor();
    const model = modelFor(tab.path);
    model.updateOptions({ tabSize: indentOf(tab.path) });
    ed.updateOptions({ readOnly: false }); // 삭제 파일 탭에서 돌아오는 경우
    if (ed.getModel() !== model) ed.setModel(model);
    consumeReveal(ed, tab.path);
    if (editors.activeGroupId === props.group.id) {
      const pos = ed.getPosition();
      if (pos) editors.cursor = { line: pos.lineNumber, col: pos.column };
      // WHY: 포커스는 요청된 경우만 — 트리 단일 클릭(preview)은 포커스가 트리에 남아야
      //      Delete 가 파일 삭제로 이어진다 (VS Code 동일). scm.head 갱신 sync 도 포커스를 안 뺏는다
      if (editors.pendingFocus) {
        editors.pendingFocus = false;
        focusLater(ed);
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
      focusLater(ed.getModifiedEditor());
    }
  }
}

onMounted(() => {
  void sync();
  watch(() => props.group.activeTabId, () => void sync(), { flush: 'post' });
  // HEAD 가 움직이면(앱 밖 커밋 포함) 열려 있는 diff 탭의 original 도 갈아끼운다 —
  // 탭 재활성화를 기다리지 않는다. 파일 탭이면 sync 는 모델 동일성 검사로 no-op
  watch(() => scm.head, () => void sync(), { flush: 'post' });
  // 열린 채 외부 변경으로 열 수 있게 된 파일(이진→텍스트 등) — 탭 전환 없이 모델을 세워야 한다.
  // 문서 도착(탭이 읽기보다 먼저 뜬다)도 같은 경로 — 없음 → 있음 전이가 sync 를 부른다
  watch(
    () => {
      const doc = active.value ? editors.docs.get(active.value.path) : undefined;
      return doc === undefined ? null : !!doc.unopenable;
    },
    () => void sync(),
    { flush: 'post' },
  );
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
