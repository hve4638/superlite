/**
 * Monaco 셋업 — 워커/테마/모델 캐시. MonacoHost 인스턴스(그룹별)가 공유한다.
 */
import * as monaco from 'monaco-editor';
// WHY: monaco 0.56 은 exports map 이 'monaco-editor/*' → 'esm/vs/*.js' 라서
//      구버전 경로(esm/vs/...)로는 vite 가 resolve 하지 못한다.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import { FontMeasurements } from 'monaco-editor/editor/browser/config/fontMeasurements';
import { FontInfo, SERIALIZED_FONT_INFO_VERSION } from 'monaco-editor/editor/common/config/fontInfo';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import { language as markdownLanguage } from 'monaco-editor/languages/definitions/markdown/markdown';
import { editors, setApplyExternalEdit, setDisposeModels, updateContent } from '../../model/editors';
import { languageOf } from '../../model/languages';
import { registerCustomLanguages } from './languages';
import { backend } from '../../model/host';
import { repoOf, relPath } from '../../model/scm';
import { setBeforeSessionSwitch } from '../../model/sessions';
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
//      액센트 계열만은 theme/accent.css 의 --sl-accent-* 를 읽어 채널(dev 보라)을 따라간다.
/** CSS 변수를 실제 색으로 풀어 hex 로 — color-mix() 같은 값도 프로브 요소가 계산해 준다 */
function cssColorHex(variable: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${variable})`;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  // rgb(r, g, b) 또는 color-mix 결과인 color(srgb r g b) — 후자는 0..1 실수
  const m = /^(rgba?|color)\((?:srgb )?([\d.]+),? ([\d.]+),? ([\d.]+)/.exec(rgb);
  if (!m) return rgb;
  const scale = m[1] === 'color' ? 255 : 1;
  return '#' + m.slice(2, 5).map((c) => Math.round(Number(c) * scale).toString(16).padStart(2, '0')).join('');
}
const accentSoft = cssColorHex('--sl-accent-soft');
const accentSelection = cssColorHex('--sl-accent-selection');

monaco.editor.defineTheme('superlite-dark', {
  base: 'vs-dark',
  inherit: true,
  colors: {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#cccccc',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editorCursor.foreground': '#aeafad',
    'editor.selectionBackground': accentSelection,
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
    'editorSuggestWidget.selectedBackground': accentSoft,
    'editorGutter.background': '#1f1f1f',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#bfbfbf66',
    'minimap.selectionHighlight': accentSelection,
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
    // markdown 제목 — VS Code(markup.heading)처럼 굵게, 색은 keyword 상속. 토큰은 아래 토크나이저 교체가 만든다
    { token: 'keyword.heading', fontStyle: 'bold' },
  ],
});

// md 제목(#~######)을 굵게 (사용자 결정 2026-09-10, ticket terminal-font-color). 내장 monarch 는 제목 줄과 목록
// 기호·표 구분선을 같은 keyword 토큰으로 내보내 테마 규칙만으로는 제목만 굵게 할 수 없다 — ATX 제목 규칙의
// 토큰만 keyword.heading 으로 바꿔 다시 등록한다. 첫 markdown 모델이 토큰화되기 전에 등록하므로 내장 lazy
// 팩토리보다 이쪽이 쓰인다 (TokenizationRegistry.getOrCreate 는 등록된 provider 를 우선)
{
  const lang = markdownLanguage;
  const root = (lang.tokenizer.root as unknown[]).map((r) =>
    Array.isArray(r) && r[0] instanceof RegExp && r[0].source.includes('(#+)')
      ? [r[0], ['white', 'keyword.heading', 'keyword.heading', 'keyword.heading']]
      : r,
  );
  monaco.languages.setMonarchTokensProvider('markdown', {
    ...lang,
    tokenizer: { ...lang.tokenizer, root: root as monaco.languages.IMonarchLanguageRule[] },
  });
}

// 내장이 아닌 언어(tmux·ssh_config …) — 첫 모델 전에 등록 (languages/index)
registerCustomLanguages();

/** 공유 옵션 — 폰트 기본값은 theme/fonts.ts 단일 소스, 라인 하이라이트 border(#282828) */
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'superlite-dark',
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

// 폰트 실측 결과의 localStorage 영속화 — VS Code 의 editorFontInfo(storage) 동일 수법.
// 재실행부터는 복원값이 캐시에 있어 첫 에디터 생성이 글리프 실측을 건너뛴다. 복원값은
// monaco 가 untrusted 로 취급해 5초 뒤 백그라운드 재실측한다 (그 사이 OS 폰트가 바뀌었을
// 수 있다 — VS Code 동일). serializeFontInfo/restoreFontInfo 는 monaco 배포판에서 빠져
// 내부 캐시 메서드로 재구성한다 — 시그니처가 바뀌어도 try/catch 로 무해하게 실측 경로가 된다.
const FONT_CACHE_KEY = 'superlite.editorFontInfo';
try {
  const raw = localStorage.getItem(FONT_CACHE_KEY);
  if (raw) {
    for (const saved of JSON.parse(raw)) {
      if (saved?.version !== SERIALIZED_FONT_INFO_VERSION) continue;
      const fi = new FontInfo(saved, false);
      FontMeasurements._writeToCache(window, fi, fi);
    }
  }
} catch { /* 손상·스키마 불일치 — 실측 경로로 */ }

// 신뢰(실측) 값만 저장 — 복원 직후의 untrusted 만 있는 캐시로 저장분을 덮어 지우면 안 된다
function saveFontCache(): void {
  try {
    const trusted = FontMeasurements._ensureCache(window).getValues().filter((v) => v.isTrusted);
    if (trusted.length > 0) localStorage.setItem(FONT_CACHE_KEY, JSON.stringify(trusted));
  } catch { /* 내부 시그니처 변경 등 — 저장만 포기 */ }
}
// 5초 재실측 이후의 최신값을 담기 위해 종료 시점에도 저장한다 (pagehide — 모바일 포함 최후 신호)
window.addEventListener('pagehide', saveFontCache);

// 첫 에디터 생성의 고정 비용(폰트 글리프 측정·뷰 싱글턴 초기화)을 부팅 유휴 시간으로
// 옮긴다 — 콜드 오픈 실측(4x 스로틀)에서 파일 내용과 무관한 이 비용이 ~75% 를 차지했다.
// 더미를 한 프레임 렌더 후 버려도 monaco 의 폰트 측정 캐시는 전역에 남는다.
const idle: (cb: () => void) => void =
  'requestIdleCallback' in window ? (cb) => requestIdleCallback(cb) : (cb) => setTimeout(cb, 0);
idle(() => {
  if (monaco.editor.getEditors().length > 0) {
    saveFontCache(); // 이미 실제 에디터가 떴다 — 데울 것은 없고, 그 실측값은 저장한다
    return;
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px;height:600px;overflow:hidden';
  document.body.appendChild(host);
  // URI 미지정 — 자동 inmemory URI 라 파일 모델 캐시·HMR 재실행과 충돌하지 않는다
  const model = monaco.editor.createModel('prewarm\n', 'plaintext');
  const ed = monaco.editor.create(host, { ...EDITOR_OPTIONS, model });
  requestAnimationFrame(() => {
    ed.dispose();
    model.dispose();
    host.remove();
    saveFontCache(); // 프리웜 실측 직후가 첫 저장 기회다 (복원 부팅에서는 untrusted 뿐이라 no-op)
  });
});

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

// 에디터에 물린 채 dispose 하지 않는다 — monaco 내부의 분리 처리에 기대지 않고 명시적으로 뗀다
function detachAndDispose(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  for (const ed of monaco.editor.getEditors()) {
    if (ed.getModel() === model) ed.setModel(null);
  }
  for (const de of monaco.editor.getDiffEditors()) {
    const m = de.getModel();
    if (m && (m.original === model || m.modified === model)) de.setModel(null);
  }
  model.dispose();
}

// rename/delete 반영 — path(하위 포함)의 모델을 캐시와 monaco 레지스트리에서 제거한다.
// 남기면 재생성·재열기 때 옛 내용의 좀비 모델이 잡힌다. 새 모델은 doc 스냅샷에서 만들어진다.
setDisposeModels((path) => {
  for (const [p, model] of [...models]) {
    if (p !== path && !p.startsWith(`${path}/`)) continue;
    models.delete(p);
    detachAndDispose(model);
  }
});

// 세션(탭) 전환 — 모델 캐시를 통째로 버린다. 모델은 path 키·전역 URI 라 세션 간에
// 같은 경로가 충돌한다. 새 세션의 모델은 그 세션의 doc 스냅샷에서 다시 만들어진다
// (내용·dirty 는 model 계층이 보존 — monaco undo 이력만 전환마다 잃는다. ponytail).
setBeforeSessionSwitch(() => {
  for (const [p, model] of [...models]) {
    models.delete(p);
    detachAndDispose(model);
  }
  for (const [p, { model }] of [...originals]) {
    originals.delete(p);
    detachAndDispose(model);
  }
});

/** diff original(HEAD 시점) 모델 — 소속 저장소의 HEAD 해시가 바뀌면 무효화되는 버전 키 캐시.
 *  이전 버전 모델은 살아 있는 diff 에디터에 물려 있을 수 있어 dispose 하지 않는다
 *  (커밋 횟수만큼의 소규모 누수 — mock 규모에서 무시 가능). */
const originals = new Map<string, { version: string; model: monaco.editor.ITextModel }>();

export async function originalModelFor(path: string): Promise<monaco.editor.ITextModel> {
  // 중첩 저장소면 가장 깊은 저장소가 파일의 주인이다 — 그 저장소 기준 상대 경로로 HEAD 내용을 읽는다
  const repo = repoOf(path);
  const version = repo?.head ?? '';
  const cached = originals.get(path);
  // '' (비 git·일시 조회 실패)는 내용을 식별하지 못한다 — 캐시·URI 재사용 불가, 매번 다시 읽는다
  if (cached && version !== '' && cached.version === version) return cached.model;

  const uri = monaco.Uri.parse(`git-original://v${version}/${path}`);
  let model = version === '' ? undefined : (monaco.editor.getModel(uri) ?? undefined);
  if (!model) {
    const content = repo ? await backend.gitOriginalContent(repo.path, relPath(repo, path)) : '';
    // WHY: 왕복 중 HEAD 가 움직였으면 이 내용이 어느 해시의 것인지 불명 — (hash,path)=내용
    //      불변식을 지키기 위해 새 head 로 다시 시도한다
    if ((repoOf(path)?.head ?? '') !== version) return originalModelFor(path);
    model = monaco.editor.getModel(uri) ?? undefined; // WHY: await 중 동시 호출이 먼저 만들었을 수 있다
    if (model) {
      if (version === '') model.setValue(content); // '' URI 는 과거 '' 시점의 내용일 수 있다
    } else {
      model = monaco.editor.createModel(content, languageOf(path), uri);
    }
  }
  originals.set(path, { version, model });
  return model;
}

export { monaco };
