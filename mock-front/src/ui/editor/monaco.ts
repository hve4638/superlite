/**
 * Monaco 셋업 — 워커/테마/모델 캐시. MonacoHost 인스턴스(그룹별)가 공유한다.
 */
import * as monaco from 'monaco-editor';
// WHY: monaco 0.56 은 exports map 이 'monaco-editor/*' → 'esm/vs/*.js' 라서
//      구버전 경로(esm/vs/...)로는 vite 가 resolve 하지 못한다.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import { editors, languageOf, setApplyExternalEdit, setDisposeModels, updateContent } from '../../model/editors';
import { backend } from '../../model/host';
import { scm } from '../../model/scm';
import { EDITOR_FONT_SIZE, MONO_FONT_FAMILY } from '../../theme/fonts';

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => {
    switch (label) {
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      default:
        return new editorWorker();
    }
  },
};

// WHY: colors 는 tokens.json(Dark Modern)의 실측값. CSS 변수는 monaco 테마에 못 쓰므로
//      hex 로 풀어 쓴다 — tokens.css 와 이중화되지만 원본은 동일 spec 이다.
monaco.editor.defineTheme('superlight-dark', {
  base: 'vs-dark',
  inherit: true,
  colors: {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#cccccc',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editorCursor.foreground': '#aeafad',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#3a3d41',
    'editor.lineHighlightBorder': '#282828',
    'editorWhitespace.foreground': '#e3e4e229',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorWidget.background': '#202020',
    'editorWidget.foreground': '#cccccc',
    'editorWidget.border': '#cccccc33',
    'editorHoverWidget.background': '#202020',
    'editorHoverWidget.border': '#cccccc33',
    'editorSuggestWidget.background': '#202020',
    'editorSuggestWidget.border': '#cccccc33',
    'editorSuggestWidget.selectedBackground': '#04395e',
    'editorGutter.background': '#1f1f1f',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#bfbfbf66',
    'minimap.selectionHighlight': '#264f78',
    'minimapSlider.background': '#79797933',
    'minimapSlider.hoverBackground': '#64646459',
    'minimapSlider.activeBackground': '#bfbfbf33',
    'diffEditor.insertedTextBackground': '#9ccc2c33',
    'diffEditor.removedTextBackground': '#ff000033',
    'diffEditor.insertedLineBackground': '#9bb95533',
    'diffEditor.removedLineBackground': '#ff000033',
    'widget.shadow': '#0000005c',
  },
  rules: [
    // Dark+ 팔레트
    { token: 'comment', foreground: '6A9955' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'keyword.control', foreground: 'C586C0' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'type.identifier', foreground: '4EC9B0' },
    { token: 'identifier', foreground: '9CDCFE' },
    { token: 'delimiter', foreground: 'D4D4D4' },
    { token: 'tag', foreground: '569CD6' },
    { token: 'attribute.name', foreground: '9CDCFE' },
    { token: 'regexp', foreground: 'D16969' },
    // markdown 인라인 코드 — 레퍼런스에서 string 색으로 렌더된다
    { token: 'variable.md', foreground: 'CE9178' },
  ],
});

/** 공유 옵션 — 폰트 기본값은 theme/fonts.ts 단일 소스, 라인 하이라이트 border(#282828) */
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'superlight-dark',
  fontSize: EDITOR_FONT_SIZE,
  fontFamily: MONO_FONT_FAMILY,
  lineNumbers: 'on',
  // WHY: spec 의 margin 66px = glyph 19 + 번호 21 + decorations 26. VS Code 는
  //      glyphMargin(브레이크포인트 영역)을 켜고 lineNumbersMinChars 3 을 쓴다.
  glyphMargin: true,
  lineNumbersMinChars: 3,
  minimap: { enabled: true, side: 'right' },
  automaticLayout: true,
  renderLineHighlight: 'line',
};

/** path → 편집용 공유 모델. 그룹/diff 가 같은 파일이면 같은 모델을 쓴다. */
const models = new Map<string, monaco.editor.ITextModel>();
// WHY: HMR 복구로 getModel() 에서 회수한 모델은 change 리스너가 죽은 모듈 것이라
//      다시 붙여야 한다 — 이중 부착을 막기 위해 부착 여부를 모델 단위로 기록한다.
const changeListenerAttached = new WeakSet<monaco.editor.ITextModel>();

export function modelFor(path: string): monaco.editor.ITextModel {
  let model = models.get(path);
  if (!model) {
    const uri = monaco.Uri.file('/' + path);
    // WHY: HMR 로 이 모듈이 리셋돼도 monaco 쪽 모델 레지스트리는 남는다 — 재생성하면 throw
    model = monaco.editor.getModel(uri) ?? undefined;
    if (!model) {
      const doc = editors.docs.get(path);
      model = monaco.editor.createModel(doc?.content ?? '', languageOf(path), uri);
    }
    models.set(path, model);
  }
  if (!changeListenerAttached.has(model)) {
    changeListenerAttached.add(model);
    const m = model;
    m.onDidChangeContent(() => updateContent(path, m.getValue()));
  }
  return model;
}

// 외부(디스크) 변경을 열린 모델에 반영 — 공통 프리픽스/서픽스를 제외한 단일 최소 편집으로
// 적용해, 변경 지점 밖의 커서·선택·접기를 보존한다 (VS Code 의 조용한 재로드 근사).
setApplyExternalEdit((path, content) => {
  const model = models.get(path) ?? monaco.editor.getModel(monaco.Uri.file('/' + path));
  if (!model || model.isDisposed()) return;
  const old = model.getValue();
  if (old === content) return;
  let s = 0;
  while (s < old.length && s < content.length && old[s] === content[s]) s++;
  let eOld = old.length;
  let eNew = content.length;
  while (eOld > s && eNew > s && old[eOld - 1] === content[eNew - 1]) {
    eOld--;
    eNew--;
  }
  // 경계가 서로게이트 쌍을 가르면 쌍 단위로 물러난다 — 잘린 코드포인트가 모델에 들어가면
  // 이후 저장이 손상된 내용을 디스크에 쓴다
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
  if (s > 0 && isHigh(old.charCodeAt(s - 1))) s--;
  if (eOld < old.length && eNew < content.length && isHigh(old.charCodeAt(eOld - 1))) {
    eOld++;
    eNew++;
  }
  const start = model.getPositionAt(s);
  const end = model.getPositionAt(eOld);
  // pushEditOperations — 편집이 undo 스택 위에 쌓여 이전 상태로의 undo 가 일관된다
  model.pushEditOperations(
    null,
    [{
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: content.slice(s, eNew),
    }],
    () => null,
  );
});

// rename/delete 반영 — path(하위 포함)의 모델을 캐시와 monaco 레지스트리에서 제거한다.
// 남기면 재생성·재열기 때 옛 내용의 좀비 모델이 잡힌다. 새 모델은 doc 스냅샷에서 만들어진다.
setDisposeModels((path) => {
  for (const [p, model] of [...models]) {
    if (p !== path && !p.startsWith(`${path}/`)) continue;
    models.delete(p);
    if (model.isDisposed()) continue;
    // 에디터에 물린 채 dispose 하지 않는다 — monaco 내부의 분리 처리에 기대지 않고 명시적으로 뗀다
    for (const ed of monaco.editor.getEditors()) {
      if (ed.getModel() === model) ed.setModel(null);
    }
    for (const de of monaco.editor.getDiffEditors()) {
      const m = de.getModel();
      if (m && (m.original === model || m.modified === model)) de.setModel(null);
    }
    model.dispose();
  }
});

/** diff original(HEAD 시점) 모델 — HEAD 해시(scm.head)가 바뀌면 무효화되는 버전 키 캐시.
 *  이전 버전 모델은 살아 있는 diff 에디터에 물려 있을 수 있어 dispose 하지 않는다
 *  (커밋 횟수만큼의 소규모 누수 — mock 규모에서 무시 가능). */
const originals = new Map<string, { version: string; model: monaco.editor.ITextModel }>();

export async function originalModelFor(path: string): Promise<monaco.editor.ITextModel> {
  const cached = originals.get(path);
  if (cached && cached.version === scm.head) return cached.model;

  const version = scm.head;
  const uri = monaco.Uri.parse(`git-original://v${version}/${path}`);
  let model = monaco.editor.getModel(uri) ?? undefined;
  if (!model) {
    const content = await backend.gitOriginalContent(path);
    model = monaco.editor.getModel(uri) ?? undefined; // WHY: await 중 동시 호출이 먼저 만들었을 수 있다
    if (!model) {
      model = monaco.editor.createModel(content, languageOf(path), uri);
    }
  }
  originals.set(path, { version, model });
  return model;
}

export { monaco };
