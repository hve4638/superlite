import { watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { setTerminalSerializer, setTerminalZoom, stepTerminalZoom, terminalView } from '../../model/terminal';
import type { TerminalInstance } from '../../model/terminal';
import { allTerminals } from '../../model/sessions';
import { isShellSkippingChord } from '../../model/commands';
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

const bindings = new Map<number, Binding>();

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
        if (b.term) b.term.write(chunk, done);
        else b.pending.push([chunk, done]);
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
    theme: CAMPBELL,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
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
  term.open(b.el);
  // WHY: IME 조합창 위치 (ticket ime-composition-window). xterm 6.0.0 은 숨은 textarea 를 커서 이동 때만
  //      커서 칸으로 옮기고 조합 중엔 잠근다 — 부분 렌더·리사이즈·포커스 복귀 뒤 첫 조합이면 textarea 가
  //      옛 자리(초기 CSS 는 창 왼쪽 밖·top 0)라 WebView2 가 IME 창을 창 왼쪽 위에 앉힌다. upstream 수정
  //      (xtermjs/xterm.js#5759, 7.0 예정)과 같이 조합 시작 직전과 포커스 때 커서 위치로 되민다. capture 라
  //      xterm 의 compositionstart 리스너(isComposing=true, 그 뒤엔 sync 가 무동작)보다 먼저 돈다.
  //      xterm 을 7.x 로 올리면 지운다.
  //      조합 시작은 키 입력과 같이 맨 아래로 스크롤한다 (xterm scrollOnUserInput 은 keydown 에만 적용) — 뷰포트가
  //      한두 줄 위로 밀린 채면 커서가 뷰포트 밖이라 xterm 이 조합 상자·textarea 위치를 갱신하지 않아, 조합
  //      글자가 입력줄과 다른 행에 그려진다 (2026-09-10 Windows 실기: tmux 안 claude 에서 한두 줄 위)
  const core = (term as unknown as { _core: { _syncTextArea?: () => void } })._core;
  const syncTextArea = (): void => core._syncTextArea?.();
  term.textarea?.addEventListener(
    'compositionstart',
    () => {
      term.scrollToBottom();
      syncTextArea();
    },
    true,
  );
  term.textarea?.addEventListener('focus', syncTextArea, true);
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
  term.onData((d) => inst.session.write(d));
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
