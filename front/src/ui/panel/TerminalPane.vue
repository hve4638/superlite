<script lang="ts">
import { watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminals, createTerminal, setActiveTerminal } from '../../model/terminal';
import type { TerminalInstance } from '../../model/terminal';
import { allTerminals } from '../../model/sessions';
import { isWorkbenchChord } from '../../model/commands';
import { MONO_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from '../../theme/fonts';

interface Binding {
  /** term.open 대상. 패널이 닫혀도 살아남아 remount 때 host 에 다시 붙인다. */
  el: HTMLDivElement;
  term: Terminal | null;
  fit: FitAddon | null;
  /** xterm 이 열리기 전에 도착한 세션 출력 (mock 프롬프트 등) — 처리 완료(done) 콜백 동반 */
  pending: [string, (() => void) | undefined][];
}

const bindings = new Map<number, Binding>();

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
      const b: Binding = { el: document.createElement('div'), term: null, fit: null, pending: [] };
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

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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

function terminalTheme() {
  return {
    background: cssVar('--vscode-panel-background'),
    foreground: cssVar('--vscode-terminal-foreground'),
    // WHY: tokens 에 terminalCursor-foreground 가 없어 foreground 로 대체 (Dark Modern 동일값)
    cursor: cssVar('--vscode-terminal-foreground'),
    selectionBackground: cssVar('--vscode-terminal-selectionBackground'),
    selectionInactiveBackground: cssVar('--vscode-terminal-inactiveSelectionBackground'),
    black: cssVar('--vscode-terminal-ansiBlack'),
    red: cssVar('--vscode-terminal-ansiRed'),
    green: cssVar('--vscode-terminal-ansiGreen'),
    yellow: cssVar('--vscode-terminal-ansiYellow'),
    blue: cssVar('--vscode-terminal-ansiBlue'),
    magenta: cssVar('--vscode-terminal-ansiMagenta'),
    cyan: cssVar('--vscode-terminal-ansiCyan'),
    white: cssVar('--vscode-terminal-ansiWhite'),
    brightBlack: cssVar('--vscode-terminal-ansiBrightBlack'),
    brightRed: cssVar('--vscode-terminal-ansiBrightRed'),
    brightGreen: cssVar('--vscode-terminal-ansiBrightGreen'),
    brightYellow: cssVar('--vscode-terminal-ansiBrightYellow'),
    brightBlue: cssVar('--vscode-terminal-ansiBrightBlue'),
    brightMagenta: cssVar('--vscode-terminal-ansiBrightMagenta'),
    brightCyan: cssVar('--vscode-terminal-ansiBrightCyan'),
    brightWhite: cssVar('--vscode-terminal-ansiBrightWhite'),
  };
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch as watchEffectful } from 'vue';

const bodyEl = ref<HTMLElement | null>(null);
const hostEls = new Map<number, HTMLElement>();

function setHost(id: number, el: unknown) {
  if (el) hostEls.set(id, el as HTMLElement);
  else hostEls.delete(id);
}

function ensureOpened(inst: TerminalInstance) {
  const b = bindings.get(inst.id);
  const host = hostEls.get(inst.id);
  if (!b || !host) return;
  if (b.el.parentElement !== host) host.appendChild(b.el);
  if (b.term) return;
  const term = new Terminal({
    fontFamily: MONO_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    cursorBlink: true,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    // WHY: xterm 은 포커스 중 모든 키를 삼킨다 — 워크벤치 키바인딩(Ctrl+P, Ctrl+J 등)은
    //      xterm 처리를 건너뛰어 전역 디스패처로 버블시킨다 (VS Code commandsToSkipShell 동작)
    if (isWorkbenchChord(e)) return false;
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
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
    //      (readText 는 권한 거부 시 조용히 실패하므로 쓰지 않는다)
    if (e.code === 'KeyV') return false;
    return true;
  });
  term.open(b.el);
  for (const [chunk, done] of b.pending) term.write(chunk, done);
  b.pending.length = 0;
  term.onData((d) => inst.session.write(d));
  term.onResize(({ cols, rows }) => inst.session.resize(cols, rows));
  b.term = term;
  b.fit = fit;
}

function fitActive() {
  const b = bindings.get(terminals.activeId);
  // WHY: v-show 로 숨겨진(display:none) 터미널은 크기가 0 이라 fit 이 깨진다 — 보일 때만
  if (!b?.fit || b.el.clientHeight === 0) return;
  try {
    b.fit.fit();
  } catch {
    /* 레이아웃 전환 중 측정 실패는 무시 */
  }
}

function syncAll() {
  for (const inst of terminals.list) ensureOpened(inst);
  fitActive();
}

watchEffectful(() => terminals.list.map((t) => t.id), syncAll, { flush: 'post' });
watchEffectful(
  () => terminals.activeId,
  () =>
    nextTick(() => {
      fitActive();
      // 새 터미널 생성·탭 전환 직후 바로 입력 가능해야 한다
      bindings.get(terminals.activeId)?.term?.focus();
    }),
);

let ro: ResizeObserver | null = null;

onMounted(() => {
  if (terminals.list.length === 0) createTerminal();
  nextTick(() => {
    syncAll();
    bindings.get(terminals.activeId)?.term?.focus();
  });
  ro = new ResizeObserver(fitActive);
  if (bodyEl.value) ro.observe(bodyEl.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  // WHY: xterm 인스턴스는 dispose 하지 않는다 — 패널을 다시 열면 스크롤백 그대로 복원
});
</script>

<template>
  <div class="terminal-pane">
    <div ref="bodyEl" class="terminal-body">
      <div
        v-for="t in terminals.list"
        v-show="t.id === terminals.activeId"
        :key="t.id"
        :ref="(el) => setHost(t.id, el)"
        class="term-host"
      />
    </div>
    <div v-if="terminals.list.length > 1" class="terminal-tabs">
      <div
        v-for="t in terminals.list"
        :key="t.id"
        class="tab-row"
        :class="{ active: t.id === terminals.activeId }"
        @click="setActiveTerminal(t.id)"
      >
        <span class="codicon codicon-terminal" />
        <span class="tab-title">{{ t.title }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-pane {
  display: flex;
  height: 100%;
  min-height: 0;
}
.terminal-body {
  flex: 1;
  min-width: 0;
  position: relative;
}
.term-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.term-host :deep(.term-attach) {
  position: relative;
  width: 100%;
  height: 100%;
}
/* WHY: 레퍼런스(terminal.css)와 동일 — 좌측 20px 거터, 패널 높이가 셀 배수가 아닐 때 하단 정렬 */
.term-host :deep(.xterm) {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding-left: 20px;
}
/* WHY: 스크롤 영역을 거터까지 넓혀 테마 배경으로 덮는다 — 안 그러면 거터에 기본 검정이 비친다 */
.term-host :deep(.xterm .xterm-scrollable-element) {
  margin-left: -20px;
  padding-left: 20px;
}
.term-host :deep(.xterm .xterm-viewport) {
  background: var(--vscode-panel-background);
}
.terminal-tabs {
  width: 180px;
  flex-shrink: 0;
  border-left: 1px solid var(--vscode-terminal-border);
  overflow-y: auto;
  padding-top: 2px;
}
.tab-row {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
  color: var(--vscode-foreground);
  white-space: nowrap;
}
.tab-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.tab-row.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
}
.tab-row .codicon {
  font-size: 16px;
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
