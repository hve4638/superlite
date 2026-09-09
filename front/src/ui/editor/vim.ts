/**
 * Monaco ↔ 임베드 Neovim 어댑터 (ticket editor-vim-mode). model/nvim.ts 의 클라이언트 위에서
 * 편집기 하나를 vim 모드로 만든다 — attachVim(editor) 가 반환하는 핸들을 dispose 하면 원상복구.
 *
 * 역할 분담 (vscode-neovim 과 같은 구도):
 * - normal/visual/명령줄: 키를 nvim 에 보내고(nvim_input), nvim 이 바꾼 버퍼(nvim_buf_lines_event)·
 *   커서·선택을 Monaco 에 반영한다. 편집기는 readOnly — IME·붙여넣기가 Monaco 로 새지 않는다.
 * - insert/replace: Monaco 가 타이핑을 처리하고(자동완성·IME 그대로) 변경분만 nvim 버퍼에 반영한다
 *   (sl_set_lines — 한 insert 는 undo 한 단위). Esc 는 Monaco 커서를 nvim 에 맞춘 뒤 보낸다.
 * - 되울림 차단: nvim 발 줄 이벤트는 모델과 같으면 건너뛰고(우리가 보낸 변경의 반영), Monaco 발
 *   변경은 nvim 적용 중(applying) 이면 보내지 않는다. 모드 소유권이 아니라 내용 비교라 외부
 *   재로드(applyExternalEdit) 도 자연히 nvim 에 흘러간다.
 * - 버퍼는 path 당 하나 (nvim 프로세스 수명 동안), 포커스된 편집기의 버퍼가 nvim 현재 버퍼.
 * - 워크벤치 chord(Ctrl+P·Ctrl+W 등)는 nvim 에 보내지 않는다 — 창 keydown 이 처리한다.
 * - :w :q :wq :x (+!) 는 명령줄 Enter 에서 가로채 우리 저장·닫기 경로로 — 가로채는 곳은 이 모듈이 아니라
 *   model/nvim 의 cmdlineKey·runEx 이고 여기는 키를 넘기기만 한다 (nvim 은 acwrite 버퍼라
 *   디스크를 안 쓰고, :q 는 마지막 창이라 nvim 자체가 끝난다).
 *
 * 남긴 엣지: diff 편집기(modified 쪽)는 대상 밖. `.` 반복은 insert 로 친 내용을 되풀이하지
 * 못한다(버퍼 반영이지 키 입력이 아니다). H/M/L·zz 는 nvim 의 격자 기준(Monaco 뷰포트와 다름).
 * 검색 하이라이트 없음. :e·:bn 으로 버퍼를 바꾸면 다음 포커스에서 되돌아온다.
 */
import { watch } from 'vue';
import { KeyCode, Range, Selection, SelectionDirection, Uri, editor as monacoEditor, type IDisposable } from 'monaco-editor';
import { cmdlineKey, nvim, runEx, toNvimKey, vimMode, type NvimClient } from '../../model/nvim';
import { isWorkbenchChord } from '../../model/commands';

type CodeEditor = monacoEditor.IStandaloneCodeEditor;
type TextModel = monacoEditor.ITextModel;

/** path → bufnr (생성 중이면 Promise) — nvim 프로세스 수명 동안, 클라이언트가 바뀌면 비운다 */
let bufOf = new Map<string, Promise<number>>();
let pathOfBuf = new Map<number, string>();
/** bufnr → nvim 버퍼 줄 수 (줄 이벤트마다 갱신) — 되울림 판정에 쓴다 */
let nvimLines = new Map<number, number>();
/** 클라이언트 단위 구독 — 줄 이벤트·클립보드·ZZ. 클라이언트가 바뀌면 다시 건다 */
let boundClient: NvimClient | null = null;
/** nvim 발 편집을 모델에 넣는 중 — 그 변경 이벤트를 nvim 에 되보내지 않는다 */
let applying = false;
/** 포커스된(=nvim 현재 버퍼인) 편집기 */
let current: CodeEditor | null = null;

const isInsertLike = (mode: string) => mode.startsWith('i') || mode.startsWith('R');

function pathOfModel(model: TextModel): string {
  return model.uri.path.replace(/^\//, '');
}

function modelOfPath(path: string): TextModel | null {
  const m = monacoEditor.getModel(Uri.file('/' + path));
  return m && !m.isDisposed() ? m : null;
}

// ---- 바이트 ↔ 문자 열 (nvim 은 UTF-8 바이트 열, Monaco 는 UTF-16 코드 유닛 열) ----
const utf8 = new TextEncoder();
function byteToChar(line: string, byte: number): number {
  let b = 0;
  let i = 0;
  while (i < line.length && b < byte) {
    const cp = line.codePointAt(i)!;
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp >= 0x10000 ? 2 : 1;
  }
  return i;
}
function charToByte(line: string, ch: number): number {
  return utf8.encode(line.slice(0, ch)).length;
}

// ---- 클라이언트 바인딩 ----
function bind(client: NvimClient): void {
  if (boundClient === client) return;
  boundClient = client;
  bufOf = new Map();
  pathOfBuf = new Map();
  nvimLines = new Map();
  client.onNotification('nvim_buf_lines_event', (args) => {
    const [buf, , first, last, lines] = args as [number, number, number, number, string[], boolean];
    const path = pathOfBuf.get(buf);
    const model = path !== undefined ? modelOfPath(path) : null;
    const total = (nvimLines.get(buf) ?? 0) - (last === -1 ? nvimLines.get(buf) ?? 0 : last - first) + lines.length;
    nvimLines.set(buf, total);
    if (model) applyLines(model, first, last, lines, total);
  });
  client.onNotification('sl_ex', (args) => void runEx(String(args[0])));
  client.onNotification('sl_clip_set', (args) => {
    const [lines, regtype] = args as [string[], string];
    // 줄 단위(V)는 nvim 이 끝에 빈 원소를 붙여 보낸다 — 그대로 join 하면 개행이 끝에 온다
    const text = lines.join('\n') + (regtype.startsWith('V') && lines[lines.length - 1] !== '' ? '\n' : '');
    // yank 는 키 입력 직후의 rpcnotify 라 사용자 활성화 안 — execCommand 폴백이 비보안 컨텍스트에서도 된다
    writeClipboard(text);
  });
  client.onRequest('sl_clip_get', async () => {
    // 읽기에는 execCommand 폴백이 없다 — 비보안 컨텍스트(http://LAN)에서는 빈 문자열 (Ctrl+V 는 paste 이벤트로 받는다)
    const text = (await navigator.clipboard?.readText().catch(() => '')) ?? '';
    const lines = text.split('\n');
    const linewise = lines.length > 1 && lines[lines.length - 1] === '';
    if (linewise) lines.pop();
    return [lines, linewise ? 'V' : 'v'];
  });
}

/** nvim 줄 이벤트 → 모델. [first, last) 줄(0 기반, last 배타)을 lines 로 교체.
 *  되울림(우리가 보낸 Monaco 변경의 반영) 판정: [first, last) 는 변경 전 좌표라 모델과 직접 비교할 수 없다 —
 *  변경 후 nvim 줄 수(total)가 모델 줄 수와 같고 그 자리의 줄들이 이미 lines 와 같으면 건너뛴다
 *  (종전엔 옛 범위와 비교해 Enter 같은 여러 줄 변경이 한 번 더 적용됐다) */
function applyLines(model: TextModel, first: number, last: number, lines: string[], total: number): void {
  const lc = model.getLineCount();
  if (lc === total && lines.every((l, i) => first + i < lc && model.getLineContent(first + i + 1) === l)) return;
  let range: Range;
  let text: string;
  if (last === -1) {
    range = model.getFullModelRange();
    text = lines.join('\n');
  } else if (last < lc) {
    range = new Range(first + 1, 1, last + 1, 1);
    text = lines.length ? lines.join('\n') + '\n' : '';
  } else if (first === 0) {
    range = model.getFullModelRange();
    text = lines.join('\n');
  } else {
    // 끝까지 교체 — 앞 줄의 끝(개행 포함)부터
    range = new Range(first, model.getLineMaxColumn(first), lc, model.getLineMaxColumn(lc));
    text = lines.length ? '\n' + lines.join('\n') : '';
  }
  applying = true;
  try {
    model.pushEditOperations(null, [{ range, text }], () => null);
  } finally {
    applying = false;
  }
}

/** 모델의 nvim 버퍼 — 없으면 만든다 (내용 복제 + acwrite + 줄 이벤트 구독) */
function ensureBuf(client: NvimClient, model: TextModel): Promise<number> {
  const path = pathOfModel(model);
  let p = bufOf.get(path);
  if (!p) {
    const initial = model.getLinesContent();
    p = (client.request('nvim_exec_lua', 'return _G.sl_open(...)', [path, initial]) as Promise<number>).then(async (buf) => {
      pathOfBuf.set(buf, path);
      nvimLines.set(buf, initial.length);
      // RPC 로 구독해야 nvim_buf_lines_event 가 이 채널로 온다 (Lua 호출은 콜백 방식)
      await client.request('nvim_buf_attach', buf, false, {});
      return buf;
    });
    bufOf.set(path, p);
    p.catch(() => bufOf.delete(path));
    const sub = model.onWillDispose(() => {
      sub.dispose();
      bufOf.delete(path);
      void p!.then((buf) => {
        pathOfBuf.delete(buf);
        if (nvim() === client) void client.request('nvim_buf_delete', buf, { force: true }).catch(() => {});
      });
    });
  }
  return p;
}

// ---- 편집기 키 (VSCodeVim 의 useCtrlKeys 예외와 같은 자세) ----
// 순수 vim 이 아니라 편집기다 — 클립보드·undo 처럼 vim 밖과 닿는 Ctrl 키는 편집기 의미로 (사용자 지시 2026-09-07).
// 값이 문자열이면 nvim 에 그 키를 대신 보내고, null 이면 nvim 에 보내지 않고 Monaco 가 처리한다 (복사·검색 위젯).
// 잃는 vim 키: Ctrl+V 블록 visual(→ Ctrl+Q, vim 기본 별칭)·Ctrl+A 증가·Ctrl+Y 한 줄 스크롤·Ctrl+F 페이지(→ Ctrl+D 로)·Ctrl+C(insert 에서만 =Esc, 그 외는 편집기 복사). itir editor role 의 목록과 같이 유지한다.
function editorKey(key: string): string | null | undefined {
  switch (key) {
    case '<C-z>': return 'u';
    case '<C-y>':
    case '<C-Z>': return '<C-r>'; // Ctrl+Shift+Z
    case '<C-a>': return '<Esc>ggVG';
    case '<C-x>': return 'cut'; // 선택 텍스트를 클립보드에(writeClipboard) + nvim 삭제 — attachVim 이 처리
    case '<C-c>': return 'copy'; // 선택 텍스트를 클립보드에 — Monaco 복사 액션은 상태에 따라 갱신을 건너뛰어 직접 쓴다
    case '<C-v>': // 브라우저 paste 이벤트로 받는다 (attachVim 의 paste 리스너) — navigator.clipboard 는
    //            http://<LAN IP> 같은 비보안 컨텍스트에 없어 nvim 클립보드 provider 로는 못 받는다
    case '<C-f>': // Monaco 검색 위젯 — 위젯이 옮긴 커서는 cursor 워처가 nvim 에 넘긴다
      return null;
    default:
      return undefined;
  }
}

/** 클립보드 쓰기 — 일회성 copy 리스너 + execCommand: 키 입력(사용자 제스처) 안에서 비보안 오리진
 *  (http://<LAN IP>) 에서도 된다. 실패하면 navigator.clipboard 로 (보안 컨텍스트) */
function writeClipboard(text: string): void {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, true);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
  if (!ok) void navigator.clipboard?.writeText(text).catch(() => {});
}

/** 복사·잘라내기 대상 텍스트 — Monaco 선택이 곧 visual 선택. V-LINE 은 줄 단위(끝 개행), 블록은 줄마다,
 *  빈 선택(normal)은 현재 줄 (VS Code emptySelectionClipboard 와 같다) */
function selectionText(editor: CodeEditor): string {
  const model = editor.getModel();
  const sels = editor.getSelections() ?? [];
  if (!model || sels.length === 0) return '';
  if (sels.length > 1) return sels.map((s) => model.getValueInRange(s)).join('\n') + '\n';
  const sel = sels[0];
  if (sel.isEmpty()) return model.getLineContent(sel.positionLineNumber) + '\n';
  const text = model.getValueInRange(sel);
  return vimMode.mode === 'V' ? text + '\n' : text;
}

// ---- 편집기 부착 ----
function attachVim(editor: CodeEditor): IDisposable {
  const client = nvim();
  if (!client) return { dispose: () => {} };
  bind(client);
  const subs: IDisposable[] = [];
  const saved = { readOnly: editor.getRawOptions().readOnly ?? false, cursorStyle: editor.getRawOptions().cursorStyle ?? 'line' };
  let insertEdits = 0; // 이번 insert 동안 nvim 에 보낸 변경 수 — 둘째부터 undojoin
  let syncedMode = 'n';
  let settingCursor = false; // 우리가 nvim 상태를 Monaco 에 넣는 중 — 그 커서 변경은 되보내지 않는다
  let querying = false;
  let queryAgain = false;

  const applyMode = (mode: string) => {
    const insert = isInsertLike(mode);
    editor.updateOptions({
      readOnly: !insert,
      readOnlyMessage: { value: '' },
      cursorStyle: insert ? 'line' : mode.startsWith('R') ? 'underline' : 'block',
    });
    if (!insert) editor.trigger('vim', 'hideSuggestWidget', null);
    if (!insert) insertEdits = 0;
  };

  /** flush 뒤 nvim 상태 조회 → 커서·선택·모드 반영 (포커스 편집기만). 겹치면 한 번 더 */
  const syncState = async () => {
    if (current !== editor) return;
    if (querying) {
      queryAgain = true;
      return;
    }
    querying = true;
    try {
      const model = editor.getModel();
      const buf = model ? await bufOf.get(pathOfModel(model)) : undefined;
      const r = (await client.request('nvim_exec_lua', 'return _G.sl_state()', [])) as [string, number, number, number, number, number];
      const [mode, line, col, vline, vcol, curBuf] = r;
      if (editor.getModel() !== model || !model || curBuf !== buf) return;
      vimMode.mode = mode;
      const insert = isInsertLike(mode);
      if (mode !== syncedMode) applyMode(mode);
      // insert 중 커서는 Monaco 소유 — insert 진입 순간(a·A·o 뒤 위치)만 nvim 을 따른다
      if (!(insert && isInsertLike(syncedMode))) {
        settingCursor = true;
        const ln = Math.min(Math.max(line, 1), model.getLineCount());
        const text = model.getLineContent(ln);
        const ch = byteToChar(text, col) + 1;
        if (mode === 'v' || mode === 'V' || mode.startsWith('\x16')) {
          const vln = Math.min(Math.max(vline, 1), model.getLineCount());
          const vch = byteToChar(model.getLineContent(vln), vcol) + 1;
          editor.setSelections(visualSelections(model, mode, vln, vch, ln, ch));
        } else {
          const pos = { lineNumber: ln, column: ch };
          const cur = editor.getPosition();
          if (!cur || !cur.equals(pos) || editor.getSelections()!.length > 1 || !editor.getSelection()!.isEmpty()) editor.setPosition(pos);
        }
        editor.revealPosition({ lineNumber: ln, column: ch }, monacoEditor.ScrollType.Immediate);
        settingCursor = false;
      }
      syncedMode = mode;
    } catch {
      /* 클라이언트 종료 — status 워처가 뗀다 */
    } finally {
      querying = false;
      if (queryAgain) {
        queryAgain = false;
        void syncState();
      }
    }
  };

  /** 이 편집기의 버퍼를 nvim 현재 버퍼로 + Monaco 커서를 nvim 에 (포커스·클릭·모델 교체) */
  const focus = async () => {
    const model = editor.getModel();
    if (!model) return;
    current = editor;
    try {
      const buf = await ensureBuf(client, model);
      if (current !== editor || editor.getModel() !== model) return;
      const pos = editor.getPosition() ?? { lineNumber: 1, column: 1 };
      await client.request('nvim_exec_lua', '_G.sl_focus(...)', [buf, pos.lineNumber, charToByte(model.getLineContent(pos.lineNumber), pos.column - 1)]);
      resize();
      void syncState();
    } catch {
      /* 종료 중 */
    }
  };

  const resize = () => {
    const info = editor.getLayoutInfo();
    const font = editor.getOption(monacoEditor.EditorOption.fontInfo);
    const lh = editor.getOption(monacoEditor.EditorOption.lineHeight);
    const cols = Math.max(20, Math.floor(info.contentWidth / font.typicalHalfwidthCharacterWidth));
    const rows = Math.max(5, Math.floor(info.height / lh));
    client.notify('nvim_ui_try_resize', cols, rows);
  };

  /** Monaco 커서 → nvim (insert 를 떠나기 직전 — 타이핑·화살표로 움직인 위치) */
  const pushCursor = () => {
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return;
    client.notify('nvim_win_set_cursor', 0, [pos.lineNumber, charToByte(model.getLineContent(pos.lineNumber), pos.column - 1)]);
  };

  subs.push(editor.onDidFocusEditorText(() => void focus()));
  subs.push(editor.onDidChangeModel(() => {
    if (current === editor) void focus();
  }));
  subs.push(editor.onDidLayoutChange(() => {
    if (current === editor) resize();
  }));
  /** Monaco 커서·선택 → nvim (normal/visual 에서, 우리 동기·nvim 편집 적용 중 제외). 비어 있지 않은 선택은
   *  visual 로 넘긴다 — 마우스 드래그·검색 위젯의 일치 선택이 곧 vim 의 선택이 된다 (편집기다운 상호작용) */
  const pushSelection = () => {
    const model = editor.getModel();
    const sel = editor.getSelection();
    if (!model || !sel) return;
    const b = (ln: number, col: number) => charToByte(model.getLineContent(ln), col - 1);
    if (sel.isEmpty()) {
      client.notify('nvim_win_set_cursor', 0, [sel.positionLineNumber, b(sel.positionLineNumber, sel.positionColumn)]);
      return;
    }
    // 끝은 배타 → 포함 좌표로 한 글자 물러난다 (줄 첫 열이면 앞 줄 끝)
    let el = sel.endLineNumber;
    let ec = sel.endColumn - 1;
    if (ec < 1) {
      el = Math.max(1, el - 1);
      ec = model.getLineMaxColumn(el) - 1;
    }
    const anchorIsStart = sel.getDirection() === SelectionDirection.LTR;
    const [al, ac, cl, cc] = anchorIsStart
      ? [sel.startLineNumber, sel.startColumn, el, ec]
      : [el, ec, sel.startLineNumber, sel.startColumn];
    client.notify('nvim_exec_lua', '_G.sl_select(...)', [al, b(al, ac), cl, b(cl, Math.max(1, cc))]);
  };
  // 마우스는 드래그가 끝난 시점(mouseup)에 한 번 — 드래그 중 매번 nvim 과 주고받으면 선택이 흔들린다.
  // 그 밖(검색 위젯·검색 결과 이동·API)은 커서 변경 즉시
  subs.push(editor.onMouseUp(() => {
    if (current !== editor || isInsertLike(vimMode.mode)) return;
    pushSelection();
  }));
  subs.push(editor.onDidChangeCursorPosition((e) => {
    if (current !== editor || settingCursor || applying || e.source === 'mouse' || isInsertLike(vimMode.mode)) return;
    pushSelection();
  }));
  // Monaco 발 변경 → nvim 버퍼 (insert 타이핑·외부 재로드·붙여넣기). nvim 적용 중이면 되울림이라 제외
  subs.push(editor.onDidChangeModelContent((e) => {
    if (applying) return;
    const model = editor.getModel();
    if (!model) return;
    const p = bufOf.get(pathOfModel(model));
    if (!p) return;
    const insert = isInsertLike(vimMode.mode);
    const join = insert && insertEdits > 0;
    if (insert) insertEdits++;
    void p.then((buf) => {
      if (e.changes.length === 1) {
        const c = e.changes[0];
        const newCount = c.text.split('\n').length;
        const lines = model.getLinesContent().slice(c.range.startLineNumber - 1, c.range.startLineNumber - 1 + newCount);
        client.notify('nvim_exec_lua', '_G.sl_set_lines(...)', [buf, c.range.startLineNumber - 1, c.range.endLineNumber, lines, join]);
      } else {
        // 다중 커서 등 — 통째로
        client.notify('nvim_exec_lua', '_G.sl_set_lines(...)', [buf, 0, -1, model.getLinesContent(), join]);
      }
    });
  }));
  subs.push(editor.onKeyDown((e) => {
    if (current !== editor) return;
    const be = e.browserEvent;
    if (isWorkbenchChord(be)) return; // 창 keydown 핸들러 몫 (Ctrl+P·Ctrl+S·Ctrl+W …)
    const key = toNvimKey(be);
    if (!key) return;
    if (e.keyCode === KeyCode.F1) return; // monaco addCommand — 팔레트
    if (isInsertLike(vimMode.mode) && !vimMode.cmdline) {
      if (key === '<Esc>' || key === '<C-[>' || key === '<C-c>') {
        e.preventDefault();
        e.stopPropagation();
        pushCursor();
        client.input('<Esc>');
      }
      return; // 나머지는 Monaco 가 처리
    }
    const mapped = editorKey(key);
    if (mapped === null) return; // Monaco 몫
    e.preventDefault();
    e.stopPropagation();
    if (mapped === 'copy' || mapped === 'cut') {
      writeClipboard(selectionText(editor));
      if (mapped === 'cut') client.input(vimMode.mode === 'n' ? 'dd' : 'd');
      return;
    }
    if (mapped !== undefined) {
      client.input(mapped);
      return;
    }
    // 명령줄이 열린 뒤의 키는 보통 상태바 입력창(IME 대상)이 받지만, cmdline_show 가 오기 전에
    // 빠르게 친 키는 여기로 온다 — 같은 경로(:w 가로채기 포함)
    if (vimMode.cmdline) {
      cmdlineKey(be);
      return;
    }
    client.input(key);
  }));
  // normal/visual 의 붙여넣기 — paste 이벤트의 텍스트를 무명 레지스터에 넣고 p (visual 은 선택을 대체).
  // insert 는 Monaco 가 그대로 붙인다 (변경분이 버퍼에 흘러간다).
  // WHY: window 에 건다 — normal 모드 편집기는 readOnly 라 Monaco 텍스트영역이 포커스를 안 잡고,
  //      Ctrl+V 의 paste 이벤트가 editor.getDomNode() 를 거치지 않고 window 로 온다. current 로 활성
  //      편집기만 처리한다 (편집기마다 리스너가 붙지만 하나만 반응)
  const onPaste = (e: ClipboardEvent) => {
    if (current !== editor || isInsertLike(vimMode.mode) || vimMode.cmdline) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    e.stopPropagation();
    if (!text) return;
    // nvim_paste — GUI 붙여넣기 전용 API. 커서 위치에 삽입하고 linewise 도 알아서 처리한다
    // (setreg + p 보다 견고: 레지스터 상태·regtype 에 안 걸린다). phase -1 = 단일 붙여넣기
    client.notify('nvim_paste', text, true, -1);
  };
  window.addEventListener('paste', onPaste, true);
  subs.push({ dispose: () => window.removeEventListener('paste', onPaste, true) });
  subs.push({ dispose: client.onRedraw((name) => {
    if (name === 'flush') void syncState();
  }) });
  // 명령줄이 닫히면(Enter·Esc) 상태바 입력창에서 편집기로 포커스 복귀
  subs.push({ dispose: watch(() => vimMode.cmdline, (c, prev) => {
    if (!c && prev && current === editor && document.activeElement?.classList.contains('vim-cmdline-input')) editor.focus();
  }) });

  applyMode('n');
  if (editor.hasTextFocus()) void focus();

  return {
    dispose: () => {
      for (const s of subs) s.dispose();
      if (current === editor) current = null;
      editor.updateOptions({ readOnly: saved.readOnly, readOnlyMessage: undefined, cursorStyle: saved.cursorStyle });
    },
  };
}

/** visual 모드 선택 — nvim 은 커서 아래 글자를 포함(inclusive), Monaco 선택은 배타 끝 */
function visualSelections(model: TextModel, mode: string, vln: number, vch: number, ln: number, ch: number): Selection[] {
  if (mode === 'V') {
    return ln >= vln
      ? [new Selection(vln, 1, ln, model.getLineMaxColumn(ln))]
      : [new Selection(vln, model.getLineMaxColumn(vln), ln, 1)];
  }
  if (mode.startsWith('\x16')) {
    const [c1, c2] = vch <= ch ? [vch, ch] : [ch, vch];
    const [l1, l2] = vln <= ln ? [vln, ln] : [ln, vln];
    const sels: Selection[] = [];
    for (let l = l1; l <= l2; l++) sels.push(new Selection(l, c1, l, Math.min(c2 + 1, model.getLineMaxColumn(l))));
    return sels;
  }
  const forward = ln > vln || (ln === vln && ch >= vch);
  return forward
    ? [new Selection(vln, vch, ln, Math.min(ch + 1, model.getLineMaxColumn(ln)))]
    : [new Selection(vln, Math.min(vch + 1, model.getLineMaxColumn(vln)), ln, ch)];
}

/** MonacoHost 용 — vim 모드가 ready 인 동안 편집기를 붙였다 뗀다. 반환값은 해제 함수 */
export function bindVim(getEditor: () => CodeEditor | null): () => void {
  let handle: IDisposable | null = null;
  const stop = watch(
    () => vimMode.status,
    (s) => {
      handle?.dispose();
      handle = null;
      const ed = getEditor();
      if (s === 'ready' && ed) handle = attachVim(ed);
    },
    { immediate: true },
  );
  return () => {
    stop();
    handle?.dispose();
  };
}
