import { reactive, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TerminalInstance } from '../../model/terminal';
import { allSessionCtxs, allTerminals } from '../../model/sessions';
import { nav } from './nav';
import { TERMINAL_FONT_FAMILY, TERMINAL_LINE_HEIGHT } from '../../theme/fonts';

/**
 * 모바일 xterm 바인딩 (ticket mobile-shell) — 데스크톱 ui/editor/terminalHost 와 같은 구조(인스턴스 id 키의 모듈 맵,
 * 세션 출력은 뷰 마운트 전부터 버퍼링)이되 키보드 chord·링크·IME 진단·창 이동 직렬화는 없고, 대신 폰에 필요한 것을 둔다:
 * 소프트 키보드에는 없는 키(Esc·Tab·화살표)와 sticky 수정키(Ctrl·Shift·Alt — 한 번 누르면 다음 입력 하나에 붙는다),
 * 터치 제스처를 xterm 이 이해하는 wheel·mouse 이벤트로 바꾸는 진입점(wheel·click), 핀치 확대용 글꼴 크기.
 * terminalHost 와 함께 실리면 세션 출력을 두 번 소비하므로 모바일 셸은 그 모듈을 import 하지 않는다.
 */

interface Binding {
  el: HTMLDivElement;
  term: Terminal | null;
  fit: FitAddon | null;
  pending: [string, (() => void) | undefined][];
}
const bindings = new Map<number, Binding>();

// Windows Terminal "Campbell" — 데스크톱 terminalHost 의 팔레트와 같은 값 (그 모듈은 import 할 수 없어 복사)
export const TERMINAL_BACKGROUND = '#0C0C0C';
const CAMPBELL = {
  background: TERMINAL_BACKGROUND, foreground: '#CCCCCC', cursor: '#FFFFFF',
  selectionBackground: 'rgba(255, 255, 255, 0.3)', selectionInactiveBackground: 'rgba(255, 255, 255, 0.15)',
  black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
  brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
};

// ---- 글꼴 크기 (핀치) — 폰은 데스크톱 16px 로는 40열도 안 나와 기본 12px. 기기 로컬 저장
const FONT_KEY = 'superlite.mobile.terminalFont';
const FONT_MIN = 7;
const FONT_MAX = 28;
function loadFont(): number {
  const n = Number(localStorage.getItem(FONT_KEY));
  return n >= FONT_MIN && n <= FONT_MAX ? n : 12;
}
export const termFont = reactive({ size: loadFont() });
export function setTermFont(px: number): void {
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
  if (size === termFont.size) return;
  termFont.size = size;
  localStorage.setItem(FONT_KEY, String(size));
  for (const [id, b] of bindings) {
    if (!b.term) continue;
    b.term.options.fontSize = size;
    fitTerminal(id);
  }
}

// ---- sticky 수정키 — 키바 버튼이 켜고, 다음 입력(소프트 키보드 글자 또는 키바 키) 하나에 붙은 뒤 꺼진다
export type Mod = 'ctrl' | 'shift' | 'alt';
export const mods = reactive({ ctrl: false, shift: false, alt: false });
export function toggleMod(m: Mod): void {
  mods[m] = !mods[m];
}
function clearMods(): void {
  mods.ctrl = mods.shift = mods.alt = false;
}
/** xterm 의 CSI 수정키 파라미터 — 1 + Shift 1 + Alt 2 + Ctrl 4 */
function modParam(): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}
function ctrlOf(c: string): string {
  const code = c.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40); // @ A-Z [ \ ] ^ _
  if (c === ' ') return '\0';
  if (c === '?') return '\x7f';
  return c;
}
/** 소프트 키보드 입력에 sticky 수정키를 입힌다 — 글자 하나에만 Shift(대문자)·Ctrl(제어 문자), Alt 는 ESC 접두.
 *  Ctrl+Enter 는 데스크톱 terminalHost 와 같은 Windows Terminal 규칙으로 LF(\n) — Enter 는 \r 로 오고 ctrlOf 는 제어 문자 범위
 *  밖이라 그대로 두면 Ctrl 이 무시된다 (사용자 지적 2026-09-15). 하드웨어 키보드의 실제 수정키 조합은 xterm 이 이미 시퀀스로
 *  만들어 오므로 여기 닿지 않는다 (길이 1 이 아니다) */
function applySticky(d: string): string {
  if (!mods.ctrl && !mods.shift && !mods.alt) return d;
  let out = d;
  if (d.length === 1) {
    if (mods.shift) out = out.toUpperCase();
    if (mods.ctrl) out = d === '\r' ? '\n' : ctrlOf(out);
  }
  if (mods.alt) out = `\x1b${out}`;
  clearMods();
  return out;
}

/** 인스턴스를 소유한 세션의 에이전트 상태 모듈 — 입력·출력·벨 바닥 신호를 그 세션에 알린다 */
function agentOf(inst: TerminalInstance) {
  return allSessionCtxs().find((c) => c.terminals.terminals.list.some((t) => t.id === inst.id))?.terminals.agent ?? null;
}

function write(inst: TerminalInstance, data: string): void {
  agentOf(inst)?.noteInput(inst, data);
  inst.session.write(data);
}

// 세션 출력은 뷰 마운트 전부터 받는다 (attach 직후 화면 재생이 마운트보다 먼저 온다). 대상은 전 세션 합집합
watch(
  () => allTerminals().map((t) => t.id),
  () => {
    const all = allTerminals();
    for (const inst of all) {
      if (bindings.has(inst.id)) continue;
      const b: Binding = { el: document.createElement('div'), term: null, fit: null, pending: [] };
      b.el.className = 'term-attach';
      inst.session.onData((chunk, done) => {
        agentOf(inst)?.noteOutput(inst);
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

function open(inst: TerminalInstance, b: Binding): void {
  const term = new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: termFont.size,
    lineHeight: TERMINAL_LINE_HEIGHT,
    cursorBlink: true,
    cursorStyle: 'bar',
    altClickMovesCursor: false,
    theme: CAMPBELL,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(b.el);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* WebGL 불가 — DOM 렌더러 */
  }
  if (inst.restoreBuffer) {
    term.write(inst.restoreBuffer);
    delete inst.restoreBuffer;
  }
  for (const [chunk, done] of b.pending) term.write(chunk, done);
  b.pending.length = 0;
  term.onData((d) => write(inst, applySticky(d)));
  term.onBell(() => agentOf(inst)?.noteBell(inst));
  term.onResize(({ cols, rows }) => inst.session.resize(cols, rows));
  b.term = term;
  b.fit = fit;
  armKeyboardGuard(inst.id);
}

/** 인스턴스의 xterm 을 host 에 붙인다 (처음이면 연다) */
export function attachTerminal(id: number, host: HTMLElement): void {
  const b = bindings.get(id);
  const inst = allTerminals().find((t) => t.id === id);
  if (!b || !inst) return;
  if (b.el.parentElement !== host) host.appendChild(b.el);
  if (!b.term) open(inst, b);
}

export function fitTerminal(id: number): void {
  const b = bindings.get(id);
  if (!b?.fit || b.el.clientHeight === 0) return;
  try {
    b.fit.fit();
  } catch {
    /* 레이아웃 전환 중 측정 실패는 무시 */
  }
}

/** 키보드 가드 (사용자 요청 2026-09-15: 스크롤 뒤 손을 떼면 키보드가 올라온다 — 탭에서만 올라와야 한다). xterm 의 숨은 textarea 에
 *  inputmode=none 을 두면 어떤 경로로 포커스가 가도 소프트 키보드가 뜨지 않는다. 명시적 탭(focusTerminal)만 text 로 바꾸고
 *  포커스한다 — 이미 포커스된 채면 blur 뒤 다시 (같은 요소 focus() 는 무동작이라 키보드가 안 뜬다). 키보드가 내려가면(App 의
 *  판정 nav.keyboard) 다시 none 으로 무장해 다음 잡음 포커스가 키보드를 못 올린다 */
function textareaOf(id: number): HTMLTextAreaElement | null {
  return bindings.get(id)?.term?.textarea ?? null;
}
function armKeyboardGuard(id: number): void {
  const ta = textareaOf(id);
  if (ta) ta.inputMode = 'none';
}
export function focusTerminal(id: number): void {
  const b = bindings.get(id);
  const ta = b?.term?.textarea;
  if (!b?.term || !ta) return;
  if (document.activeElement === ta) ta.blur();
  ta.inputMode = 'text';
  b.term.focus();
}
watch(
  () => nav.keyboard,
  (up) => {
    if (!up) for (const id of bindings.keys()) armKeyboardGuard(id);
  },
);

// ---- 키바 키 — 소프트 키보드에 없는 키를 시퀀스로. 화살표는 sticky 수정키를 CSI 파라미터로 싣는다
export type BarKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';
const ARROW: Record<'up' | 'down' | 'left' | 'right', string> = { up: 'A', down: 'B', left: 'D', right: 'C' };
export function pressKey(id: number, key: BarKey): void {
  const inst = allTerminals().find((t) => t.id === id);
  if (!inst) return;
  let seq: string;
  if (key === 'esc') seq = '\x1b';
  else if (key === 'tab') seq = mods.shift ? '\x1b[Z' : '\t';
  else {
    const m = modParam();
    const app = bindings.get(id)?.term?.modes.applicationCursorKeysMode ?? false;
    seq = m === 1 ? `\x1b${app ? 'O' : '['}${ARROW[key]}` : `\x1b[1;${m}${ARROW[key]}`;
  }
  clearMods();
  write(inst, seq);
}

// ---- 터치 → xterm 이벤트. xterm 은 자기 wheel 리스너에서 마우스 모드(tmux·TUI)면 휠 보고를, 아니면 뷰포트 스크롤을
//      하므로 합성 WheelEvent 하나로 두 경우를 다 맡긴다. 클릭도 같은 이유로 합성 mousedown/up — 마우스 모드면 보고,
//      아니면 커서 칸 선택 시작(무해)
function screenOf(id: number): Element | null {
  const el = bindings.get(id)?.term?.element ?? null;
  return el?.querySelector('.xterm-screen') ?? el;
}
export function wheel(id: number, deltaY: number, clientX: number, clientY: number): void {
  screenOf(id)?.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 0, clientX, clientY, bubbles: true, cancelable: true }));
}
export function click(id: number, clientX: number, clientY: number, button = 0): void {
  const el = screenOf(id);
  if (!el) return;
  const init: MouseEventInit = { clientX, clientY, button, buttons: button === 2 ? 2 : 1, bubbles: true, cancelable: true };
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
}
/** 마우스 모드 판정 — tmux·TUI 가 마우스 보고를 요청했는가 (헤더 표시용) */
export function mouseTracking(id: number): boolean {
  return (bindings.get(id)?.term?.modes.mouseTrackingMode ?? 'none') !== 'none';
}
