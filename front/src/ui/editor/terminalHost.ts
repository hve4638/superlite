import { watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import type { ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { pushImeDiag, setTerminalSerializer, setTerminalZoom, stepTerminalZoom, terminalView } from '../../model/terminal';
import type { TerminalInstance } from '../../model/terminal';
import { allSessionCtxs, allTerminals } from '../../model/sessions';
import { isShellSkippingChord } from '../../model/commands';
import { imeProbe, openUrl } from '../../model/window';
import { registerPathLinks } from './terminalPathLinks';
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from '../../theme/fonts';

// xterm 바인딩 — 터미널 인스턴스 id(페이지 전역 유일) 키의 모듈 맵. TerminalView 가 마운트될 때
// 붙이고, 언마운트(탭 전환·세션 전환 remount)에도 xterm 은 살아 있어 다음 마운트에 재부착한다.

interface Binding {
  /** term.open 대상. 뷰가 사라져도 살아남아 remount 때 host 에 다시 붙인다. */
  el: HTMLDivElement;
  term: Terminal | null;
  fit: FitAddon | null;
  /** 버퍼 직렬화 — 탭을 다른 창으로 옮길 때 스크롤백을 함께 나른다 */
  serialize: SerializeAddon | null;
  /** xterm 이 열리기 전에 도착한 세션 출력 (mock 프롬프트 등) — 처리 완료(done) 콜백 동반 */
  pending: [string, (() => void) | undefined][];
}

/** 좌표가 NaN 인 xterm 마우스 보고 — `\e[<0;NaN;NaNm`(SGR)·`\e[0;NaN;NaNM`(urxvt). 숫자·NaN·세미콜론만으로 된 본문 뒤 m/M */
const NAN_MOUSE_REPORT = /^\x1b\[<?[\d;]*NaN[\d;NaN]*[mM]$/;

const bindings = new Map<number, Binding>();

// 창 포커스 복귀 때 IME 재연결 (ticket term-ime-toggle-stuck). WHY: Alt+Tab 복귀·앱 시작 직후 간헐적으로 터미널에서
//      한/영 키가 먹지 않는다 (2026-09-13 사용자 보고, vim 모드 아님·물리 키·로컬). 영문은 쳐지므로 포커스는 WebView2
//      안인데 작업 표시줄 IME 표시도 안 바뀐다 — 키가 IME 에 닿지 않는 상태로, Chromium 이 포커스된 textarea 를
//      입력 불가로 보고 IME 컨텍스트를 끊어 둔 형태(crbug 341846848 계열 — 포커스를 다시 옮기면 회복, Windows Terminal
//      #18691 도 같은 증상군)로 본다. 활성 요소가 xterm textarea 면 blur→focus 로 입력 상태 전이(NONE→TEXTAREA)를
//      강제해 IME 를 다시 붙인다 (Electron #25078 의 blur/focus 워크어라운드와 같다). 확정 진단은 아래 한/영 keydown 의
//      ime_probe — 재발하면 그 기록으로 가른다
window.addEventListener('focus', () => {
  const ae = document.activeElement;
  if (ae instanceof HTMLTextAreaElement && ae.classList.contains('xterm-helper-textarea')) {
    ae.blur();
    ae.focus();
  }
});

// 지금 호버 중인 링크 (페이지에 하나) — Ctrl 을 누르고 떼는 동안 밑줄을 따라 켜고 끈다 (open 참조).
// 밑줄은 Ctrl 을 누른 동안만, 커서 모양은 바꾸지 않는다 (사용자 결정 2026-09-12, terminal-path-links — URL 링크도 같다)
let hoveredLink: ILink | null = null;
const onCtrlChange = (e: KeyboardEvent): void => {
  if (hoveredLink && (e.key === 'Control' || e.key === 'Meta')) hoveredLink.decorations!.underline = e.type === 'keydown';
};
window.addEventListener('keydown', onCtrlChange, true);
window.addEventListener('keyup', onCtrlChange, true);

// 창 이동 핸드오프의 버퍼 몫 — model 이 xterm 을 모르므로 여기서 등록한다.
// 아직 열리지 않은(탭을 한 번도 안 본) 터미널은 pending 청크를 이어 붙여 넘긴다
setTerminalSerializer((id) => {
  const b = bindings.get(id);
  if (!b) return null;
  if (b.term && b.serialize) return b.serialize.serialize();
  return b.pending.map(([chunk]) => chunk).join('');
});

// WHY: MockPty 는 생성 직후 microtask 로 프롬프트를 내보내므로 컴포넌트 mount 를 기다리면
//      첫 출력이 유실된다. flush:'sync' 모듈 워처로 세션 생성 즉시 onData 를 배선해 버퍼링한다.
//      대상은 전 세션 합집합(allTerminals) — 세션 탭 전환은 활성 목록만 바꿀 뿐이고, 배경
//      세션의 xterm 버퍼도 계속 받아야 재활성화 때 스크롤백이 그대로 산다. 바인딩은 소유
//      세션에서 터미널이 실제로 사라졌을 때만 버린다 (id 는 페이지 전역 유일).
watch(
  () => allTerminals().map((t) => t.id),
  () => {
    const all = allTerminals();
    for (const inst of all) {
      if (bindings.has(inst.id)) continue;
      const b: Binding = { el: document.createElement('div'), term: null, fit: null, serialize: null, pending: [] };
      b.el.className = 'term-attach';
      // done — 렌더러 배압 신호. xterm 이 청크 처리를 마치면 호출해 WsBackend 가 ack 한다.
      // 열리기 전(pending)의 done 은 호출을 미뤄 ack 를 묶어둔다 — 배경 세션의 폭주 출력은
      // 데몬 flow control(미ack 고수위)이 막는다
      inst.session.onData((chunk, done) => {
        // 바닥 신호 (ticket agent-hooks-status): 출력 = 활동. 벨은 열린 xterm 이면 onBell(정확), 아직 안 열렸으면
        // 청크에서 OSC 종결자가 아닌 BEL 을 찾는다 (한 번도 안 본 탭에도 벨 배지가 붙게)
        agentOf(inst)?.noteOutput(inst);
        if (b.term) b.term.write(chunk, done);
        else {
          if (hasBareBell(chunk)) agentOf(inst)?.noteBell(inst);
          b.pending.push([chunk, done]);
        }
      });
      bindings.set(inst.id, b);
    }
    for (const [id, b] of bindings) {
      if (all.some((t) => t.id === id)) continue;
      b.term?.dispose();
      b.el.remove();
      bindings.delete(id);
    }
  },
  { flush: 'sync', immediate: true },
);

/** OSC(`ESC ]…BEL`) 종결자가 아닌 BEL — 열리지 않은 터미널의 벨 판정용 (청크 경계에 걸친 OSC 는 오탐 가능, 드물다) */
const PENDING_BELL = /(?:^|[^\x1b\]][^\x1b]*?)\x07/;
function hasBareBell(chunk: string): boolean {
  return PENDING_BELL.test(chunk.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
}

/** 인스턴스를 소유한 세션의 에이전트 상태 모듈 — 바닥 신호(활동·벨·입력)를 그 세션에 알린다 */
function agentOf(inst: TerminalInstance) {
  return allSessionCtxs().find((c) => c.terminals.terminals.list.some((t) => t.id === inst.id))?.terminals.agent ?? null;
}

function copyText(text: string, refocus?: () => void): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      execCopy(text);
      refocus?.();
    });
  } else {
    // WHY: 비보안 컨텍스트 폴백 — 숨은 textarea + execCommand('copy')
    execCopy(text);
    refocus?.();
  }
}

function execCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  // WHY: select() 가 포커스를 뺏는다 — 호출자가 refocus 콜백으로 터미널에 되돌린다
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

// Windows Terminal 기본 배색 "Campbell" — VS Code 토큰이 아니라 WT 를 닮는 것이 목표
// (사용자 방향 2026-09-07). 배경 #0C0C0C 는 TerminalView 의 CSS 배경과 같은 값
export const TERMINAL_BACKGROUND = '#0C0C0C';
const CAMPBELL = {
  background: TERMINAL_BACKGROUND,
  foreground: '#CCCCCC',
  cursor: '#FFFFFF',
  selectionBackground: 'rgba(255, 255, 255, 0.3)',
  selectionInactiveBackground: 'rgba(255, 255, 255, 0.15)',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  magenta: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightMagenta: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2',
};

// 동봉 Cascadia(base.css @font-face)는 비동기로 온다 — xterm 은 open 때 셀 크기를 재고 다시 재지 않아, 시스템 Cascadia 가
// 없는 기기(리눅스·웹·Windows 10)에서 첫 터미널이 폴백 글꼴 폭으로 잰 칸(8px)에 9.4px 글리프를 그려 글자가 겹치고 열 수가
// 틀린다 (ime-composition-window 워커 실측). 모듈 로드 때 미리 받아 두고, 터미널을 연 뒤 로드가 끝나면 다시 잰다
// (ticket terminal-font-color). 시스템 Cascadia 가 있으면 동봉본은 쓰이지 않지만 로드 자체는 무해하다
const bundledFont: Promise<unknown> = document.fonts?.load(`${TERMINAL_FONT_SIZE}px 'Cascadia Mono Bundled'`).catch(() => undefined) ?? Promise.resolve();

const ZOOM_KEYS: Record<string, 1 | -1 | 0> = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 };
function terminalFontSize(): number {
  return Math.round((TERMINAL_FONT_SIZE * terminalView.zoom) / 100);
}
// 줌 변경 → 열려 있는 모든 xterm 에 적용. 보이는 것만 fit (숨은 것은 다음 마운트의 fit 이 잡는다)
watch(
  () => terminalView.zoom,
  () => {
    for (const [id, b] of bindings) {
      if (!b.term) continue;
      b.term.options.fontSize = terminalFontSize();
      fitTerminal(id);
    }
  },
);

function open(inst: TerminalInstance, b: Binding): void {
  const term = new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: terminalFontSize(),
    lineHeight: TERMINAL_LINE_HEIGHT,
    cursorBlink: true,
    cursorStyle: 'bar', // Windows Terminal 기본
    // WHY: xterm 기본(true)은 Alt+클릭을 "커서를 클릭 셀로" 로 보고 방향키 시퀀스를 수백 개 셸에
    //      보낸다 (Alt+Shift+클릭도 아래 Shift 제거 재전송을 거쳐 같은 경로). WT 는 Alt+클릭에 아무
    //      동작이 없고 Alt+드래그만 블록 선택이라 그 규칙을 따른다 (ticket alt-shift-click-odd)
    altClickMovesCursor: false,
    theme: CAMPBELL,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  const core = (
    term as unknown as {
      _core: {
        _syncTextArea?: () => void;
        _charSizeService: { measure(): void };
        _compositionHelper?: { keydown(e: KeyboardEvent): boolean };
      };
    }
  )._core;
  term.attachCustomKeyEventHandler((e) => {
    // WHY: xterm 은 포커스 중 모든 키를 삼킨다 — skipShell 표식 키바인딩(Ctrl+P, Ctrl+` 등)만
    //      xterm 처리를 건너뛰어 전역 디스패처로 버블시킨다 (VS Code commandsToSkipShell 동작).
    //      그 밖의 워크벤치 chord(Ctrl+W·Ctrl+B·Ctrl+S…)는 xterm 이 셸로 보내고 전파를 끊는다
    if (isShellSkippingChord(e)) return false;
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
    // Ctrl+Enter: Windows Terminal 규칙대로 LF(\n) — Enter 의 CR 과 구분된다. xterm.js 는 둘 다 \r 이라
    // 셸 안 프로그램(Claude Code 등)이 Ctrl 을 잃는다. 제어 문자라 tmux 몇 겹이든 설정 없이 통과한다
    // (확장 키 프로토콜(CSI u)은 tmux 마다 extended-keys 설정이 필요해 채택하지 않았다, 2026-09-10)
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      // WHY: IME 조합 중 Enter 는 keydown(keyCode 229, 조합 문자) → compositionend → keydown(13) 순서로 두 번 온다
      //      (Windows 한글 IME, 2026-09-12 보고 '\n\n글'). 229 는 xterm 의 조합 처리에 맡겨 무시시키고, 뒤따르는
      //      진짜 Enter 에서 xterm 이 일반 Enter 에 하듯 지연 전송 대기 중인 조합을 먼저 흘려보낸 뒤 LF 를 넣는다
      if (e.keyCode === 229) return true;
      core._compositionHelper?.keydown(e);
      term.input('\n');
      e.preventDefault();
      return false;
    }
    // Ctrl+= / Ctrl+- / Ctrl+0 (숫자패드 포함): 터미널 줌 — 편집기 줌과 별개의 값. 전파를 끊어
    // 워크벤치의 편집기 줌 chord 로 흘러가지 않게 한다 (Shift 얹은 앱 전역 줌은 위 skipShell 경로)
    const zoom = !e.shiftKey ? ZOOM_KEYS[e.code] : undefined;
    if (zoom !== undefined) {
      if (zoom === 0) setTerminalZoom(100);
      else stepTerminalZoom(zoom);
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    // Ctrl+C: 선택이 있으면 복사 + 선택 해제(인터럽트 아님), 없으면 셸로 (VS Code 동작)
    if (!e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      copyText(term.getSelection(), () => term.focus());
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Ctrl+Shift+C: 항상 복사
    if (e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      copyText(term.getSelection(), () => term.focus());
      e.preventDefault();
      return false;
    }
    // Ctrl+V / Ctrl+Shift+V: 붙여넣기.
    // WHY: preventDefault 없이 false 만 돌려줘야 한다 — xterm 처리(^V 전송 + cancel)를
    //      건너뛰면 브라우저 네이티브 paste 이벤트가 xterm 의 textarea paste 리스너에
    //      도달한다. 이 경로는 권한 프롬프트가 없어 보안/비보안 컨텍스트 모두에서 동작한다.
    //      (readText 는 권한 거부 시 조용히 실패하므로 쓰지 않는다).
    //      전파는 끊는다 — Ctrl+Shift+V 가 워크벤치 chord(html.togglePreview)로 흘러가
    //      preventDefault 되면 paste 가 오지 않는다
    if (e.code === 'KeyV') {
      e.stopPropagation();
      return false;
    }
    return true;
  });
  // URL 링크 (ticket terminal-links): Ctrl(맥 Cmd)을 누른 동안만 밑줄, 커서 모양 불변, 열기는 Ctrl+클릭일 때만 —
  // 툴팁은 없다 (사용자 결정 2026-09-11, 밑줄·커서는 2026-09-12 terminal-path-links 에서 개정). addon 은 Ctrl 을
  // 판정하지 않고(어떤 클릭이든 activate, 호버마다 밑줄+포인터) 장식을 바꿀 길도 없어, 제공자 등록을 가로채
  // 링크마다 underline 을 Ctrl 상태에 묶는다. Ctrl 없는 클릭은 handler 가 무시해 종전 터미널 클릭(마우스 모드
  // 보고·선택)만 남는다
  const linkTerm = Object.create(term) as Terminal;
  linkTerm.registerLinkProvider = (provider) =>
    term.registerLinkProvider({
      provideLinks: (y, cb) =>
        provider.provideLinks(y, (links) =>
          cb(
            links?.map((link) => {
              // WHY: xterm 은 넘겨받은 이 객체의 decorations 를 setter 로 바꿔치기한다 — 원본 link 가 아니라
              //      감싼 객체(l)에 써야 렌더에 닿는다
              const l: ILink = {
                ...link,
                decorations: { underline: false, pointerCursor: false },
                hover: (e) => {
                  hoveredLink = l;
                  // WHY: 마이크로태스크로 미룬다 — xterm 6 은 새 링크의 hover 를 부른 *뒤에* decorations 를
                  //      getter/setter 객체로 바꿔치기하므로 여기서 바로 쓰면 유실된다 (Ctrl 을 먼저 누른 채
                  //      링크에 올리면 장식이 안 뜨던 원인, 2026-09-12 terminal-path-links 스모크 실측)
                  const ctrl = e.ctrlKey || e.metaKey;
                  queueMicrotask(() => {
                    if (hoveredLink === l) l.decorations!.underline = ctrl;
                  });
                },
                leave: () => {
                  if (hoveredLink === l) hoveredLink = null;
                },
                // WHY: activate 를 다음 매크로태스크로 미룬다 — xterm 은 mouseup 처리 중에 activate 를 부르고 이어서
                //      마우스 보고(SGR \e[<b;x;ym) 좌표를 element 의 computed padding 으로 계산한다. activate 가 탭을
                //      동기로 열어 터미널 뷰가 숨으면(v-show) padding 이 빈 문자열 → parseInt NaN 이 되어 셸에
                //      `NaN;NaNm` 쓰레기가 들어간다 (2026-09-12 경로 링크 스모크 "bash: NaN: command not found",
                //      같은 날 URL 내부 탭에서 'aN;NaNm' 사용자 보고 — ticket term-url-link-nan-garbage). 여기 한 곳에
                //      두어 URL·경로·앞으로 생길 링크 종류가 같은 함정을 밟지 않게 한다
                activate: (e, text) => {
                  setTimeout(() => link.activate(e, text), 0);
                },
              };
              return l;
            }),
          ),
        ),
    });
  new WebLinksAddon((e, uri) => {
    if (e.ctrlKey || e.metaKey) openUrl(uri);
  }).activate(linkTerm);
  // 경로 링크 (ticket terminal-path-links) — 같은 래퍼를 타므로 조작이 URL 링크와 같다. URL 제공자가 먼저
  // 등록돼 같은 자리에 둘 다 걸리면 xterm 은 먼저 등록된 쪽을 쓴다
  registerPathLinks(linkTerm, term, inst);
  term.open(b.el);
  // 렌더러는 WebGL (VS Code 기본과 같다). 기본 DOM 렌더러는 글자마다 letter-spacing 으로 칸을 맞추고 브라우저 텍스트
  // AA(Windows 는 서브픽셀)를 타서 Windows Terminal(셀 격자 + 회색 AA 글리프 아틀라스)과 글꼴이 다르게 보인다 — WebGL 은
  // WT 와 같은 방식이다. 컨텍스트를 잃으면(GPU 재설정·컨텍스트 상한) addon 을 버려 DOM 렌더러로 돌아간다 (ticket terminal-font-color)
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* WebGL 불가 — DOM 렌더러 */
  }
  // WHY: IME 조합창 위치 (ticket ime-composition-window). xterm 6.0.0 은 숨은 textarea 를 커서 이동 때만
  //      커서 칸으로 옮기고 조합 중엔 잠근다 — 부분 렌더·리사이즈·포커스 복귀 뒤 첫 조합이면 textarea 가
  //      옛 자리(초기 CSS 는 창 왼쪽 밖·top 0)라 WebView2 가 IME 창을 창 왼쪽 위에 앉힌다. upstream 수정
  //      (xtermjs/xterm.js#5759, 7.0 예정)과 같이 조합 시작 직전과 포커스 때 커서 위치로 되민다. capture 라
  //      xterm 의 compositionstart 리스너(isComposing=true, 그 뒤엔 sync 가 무동작)보다 먼저 돈다.
  //      xterm 을 7.x 로 올리면 지운다.
  //      조합 시작은 키 입력과 같이 맨 아래로 스크롤한다 (xterm scrollOnUserInput 은 keydown 에만 적용) — 뷰포트가
  //      한두 줄 위로 밀린 채면 커서가 뷰포트 밖이라 xterm 이 조합 상자·textarea 위치를 갱신하지 않아, 조합
  //      글자가 입력줄과 다른 행에 그려진다 (2026-09-10 Windows 실기: tmux 안 claude 에서 한두 줄 위)
  const syncTextArea = (): void => core._syncTextArea?.();
  // 동봉 글꼴 로드 뒤 셀 크기 재측정 (위 bundledFont) — xterm 은 fontFamily/fontSize 가 바뀔 때만 재는데 같은 값 대입은
  // 무동작이라 측정 서비스를 직접 부른다. 크기가 달라졌으면 xterm 이 렌더러 치수·아틀라스를 갱신하고 fit 이 열 수를 고친다
  void bundledFont.then(() => {
    if (b.term !== term) return;
    core._charSizeService.measure();
    fitTerminal(inst.id);
  });
  // 임시 진단 (ticket term-ime-toggle-stuck) — 아래 한/영 keydown 때 textarea 위치·활성 요소·버퍼 상태·포커스와 출력
  //      이후 경과를 model.imeDiag 에 한 줄 남긴다. 원인 확정 뒤 지운다
  let focusAt = -1;
  let writeAt = -1;
  const openAt = performance.now();
  term.onWriteParsed(() => (writeAt = performance.now()));
  const since = (t: number): number => (t < 0 ? -1 : Math.round(performance.now() - t));
  const r = (el: Element | null | undefined): string => {
    if (!el) return 'none';
    const q = el.getBoundingClientRect();
    return `${Math.round(q.left)},${Math.round(q.top)} ${Math.round(q.width)}x${Math.round(q.height)}`;
  };
  const diag = (tag: string): void => {
    const buf = term.buffer.active;
    const ae = document.activeElement;
    const aeDesc = ae === term.textarea ? 'ta' : ae ? `${ae.tagName}.${ae.className}` : 'null';
    pushImeDiag(
      `${new Date().toISOString().slice(11, 23)} t${inst.id} ${tag} ae=${aeDesc} focus=${since(focusAt)}ms write=${since(writeAt)}ms open=${since(openAt)}ms` +
        ` ta=[${r(term.textarea)}] cv=[${r(b.el.querySelector('.composition-view'))}] el=[${r(b.el)}] win=${window.innerWidth}x${window.innerHeight}` +
        ` dpr=${window.devicePixelRatio} zoom=${terminalView.zoom} buf=${buf.type} x=${buf.cursorX} y=${buf.cursorY} base=${buf.baseY} vp=${buf.viewportY}` +
        ` rows=${term.rows} cols=${term.cols} docFocus=${document.hasFocus()} taVal=${JSON.stringify(term.textarea?.value ?? '')}`,
    );
  };
  term.textarea?.addEventListener('focus', () => (focusAt = performance.now()), true);
  term.textarea?.addEventListener(
    'compositionstart',
    () => {
      term.scrollToBottom();
      syncTextArea();
    },
    true,
  );
  term.textarea?.addEventListener('focus', syncTextArea, true);
  // 임시 진단 (ticket term-ime-toggle-stuck) — 한/영 키 keydown 때 위 diag 한 줄 + native 의 전경 창·포커스 HWND·IME
  //      열림 상태(ime_probe). 키가 IME 에 닿았다면 keydown 이 올 때는 이미 열림 상태가 바뀌어 있다 (IME 가 먼저 먹는다).
  //      원인 확정 뒤 위 진단과 함께 지운다
  term.textarea?.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'HangulMode' && e.code !== 'Lang1' && e.keyCode !== 21) return;
      diag('hangul');
      void imeProbe().then((p) => p !== null && pushImeDiag(`  native ${p}`));
    },
    true,
  );
  // 드래그 선택은 Windows Terminal 규칙 (사용자 방향 2026-09-07):
  //  - 마우스 모드가 아닐 때 Shift+클릭은 확장 선택이 아니다 — xterm 의 "직전 앵커부터 일괄 선택"
  //    을 끄는 옵션이 없어, capture 단계에서 Shift 를 뗀 이벤트로 바꿔 넘긴다 (보통 클릭·드래그).
  //  - 마우스 모드(tmux·vim)에서는 손대지 않는다 — 그냥 드래그는 앱이 받고, Shift+드래그는 xterm
  //    의 강제 선택(shouldForceSelection)이 앱을 건너뛰어 터미널이 새 선택을 시작한다
  b.el.addEventListener(
    'mousedown',
    (e) => {
      if (!e.shiftKey || e.button !== 0 || term.modes.mouseTrackingMode !== 'none') return;
      e.stopPropagation();
      e.preventDefault();
      const init: MouseEventInit = {
        bubbles: true, cancelable: true, detail: e.detail, screenX: e.screenX, screenY: e.screenY,
        clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons,
        ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: false, relatedTarget: e.relatedTarget,
      };
      e.target?.dispatchEvent(new MouseEvent('mousedown', init));
    },
    true,
  );
  // 마우스 모드에서 잡은 선택은 유지된다 (WT 동일) — 1003(모든 이동 보고) 모드에서는 버튼을 뗀 뒤의
  // 이동도 앱으로 보고되고 xterm 이 그 보고를 사용자 입력으로 보아 선택을 지운다. 선택이 있는 동안
  // 버튼 없는 이동은 xterm 에 닿기 전에 끊는다. 클릭(mousedown)은 그대로 보고돼 선택을 지운다 —
  // 이것도 WT 와 같다. 드래그 중(buttons≠0)은 건드리지 않는다 (선택 확장은 document 리스너)
  b.el.addEventListener(
    'mousemove',
    (e) => {
      if (e.buttons === 0 && term.modes.mouseTrackingMode !== 'none' && term.hasSelection()) e.stopPropagation();
    },
    true,
  );
  // 다른 창에서 넘어온 스크롤백 — 이후 출력보다 먼저 그린다 (한 번만)
  if (inst.restoreBuffer) {
    term.write(inst.restoreBuffer);
    delete inst.restoreBuffer;
  }
  for (const [chunk, done] of b.pending) term.write(chunk, done);
  b.pending.length = 0;
  // WHY: 좌표가 NaN 인 마우스 보고(SGR/urxvt `\e[<0;NaN;NaNm`)는 버린다 — 위 activate 지연이 알려진 경로를 막지만,
  //      뷰가 숨겨진 채 xterm 이 보고를 만드는 다른 경로가 생겨도 셸에 쓰레기가 들어가지 않게 한다. 형태를 마우스 보고에
  //      한정해 붙여넣기(\e[200~…) 본문의 "NaN" 은 건드리지 않는다
  term.onData((d) => {
    if (NAN_MOUSE_REPORT.test(d)) return;
    agentOf(inst)?.noteInput(inst, d);
    inst.session.write(d);
  });
  term.onBell(() => agentOf(inst)?.noteBell(inst));
  term.onResize(({ cols, rows }) => inst.session.resize(cols, rows));
  b.term = term;
  b.fit = fit;
  b.serialize = serialize;
}

/** 인스턴스의 xterm 을 host 에 붙인다 (처음이면 연다). 인스턴스가 없으면 무동작 */
export function attachTerminal(id: number, host: HTMLElement): void {
  const b = bindings.get(id);
  const inst = allTerminals().find((t) => t.id === id);
  if (!b || !inst) return;
  if (b.el.parentElement !== host) host.appendChild(b.el);
  if (!b.term) open(inst, b);
}

export function fitTerminal(id: number): void {
  const b = bindings.get(id);
  // WHY: 보이지 않는(display:none·언마운트) 터미널은 크기가 0 이라 fit 이 깨진다 — 보일 때만
  if (!b?.fit || b.el.clientHeight === 0) return;
  try {
    b.fit.fit();
  } catch {
    /* 레이아웃 전환 중 측정 실패는 무시 */
  }
}

export function focusTerminal(id: number): void {
  bindings.get(id)?.term?.focus();
}
