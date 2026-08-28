import { openQuickInput, showViewlet, toggleSideBar, togglePanel, workbench } from './workbench';
import { closeTab, editors, reopenClosedEditor, saveActive, splitActiveEditor, activeGroup } from './editors';
import { createTerminal } from './terminal';
import { refreshScm } from './scm';

export interface Command {
  id: string;
  /** palette 표시명. "View: Toggle Terminal" 처럼 카테고리 접두 포함 */
  title: string;
  /** 표시용 키바인딩 라벨 (예: "Ctrl+Shift+P") */
  keybinding?: string;
  run: () => void;
}

export const commandList: Command[] = [];
const byChord = new Map<string, Command>();

/** "ctrl+shift+p" 형태의 정규화된 chord → 등록 */
function register(cmd: Command, ...chords: string[]): void {
  commandList.push(cmd);
  for (const chord of chords) byChord.set(chord, cmd);
}

// WHY: e.key 는 Shift 적용 후 문자를 준다 — Ctrl+Shift+` 가 'ctrl+shift+~' 가 되어
//      등록 chord 와 어긋난다. 구두점 키는 물리 키(e.code)로 정규화한다.
const CODE_KEYS: Record<string, string> = { Backquote: '`', Backslash: '\\' };

function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  if (e.metaKey) parts.push('meta');
  const key = CODE_KEYS[e.code] ?? e.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(key)) parts.push(key);
  return parts.join('+');
}

/** 이 키 이벤트가 워크벤치 키바인딩에 해당하는가 (xterm 등이 삼키지 않도록 판별용) */
export function isWorkbenchChord(e: KeyboardEvent): boolean {
  return byChord.has(chordOf(e));
}

export function installKeybindings(target: Window): void {
  target.addEventListener('keydown', (e) => {
    const cmd = byChord.get(chordOf(e));
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    cmd.run();
  });
}

export function setupCommands(): void {
  register({
    id: 'workbench.action.showCommands',
    title: 'Show All Commands',
    keybinding: 'Ctrl+Shift+P',
    run: () => openQuickInput('commands'),
  }, 'ctrl+shift+p', 'f1');

  register({
    id: 'workbench.action.quickOpen',
    title: 'Go to File...',
    keybinding: 'Ctrl+P',
    run: () => openQuickInput('files'),
  }, 'ctrl+p');

  register({
    id: 'workbench.view.explorer',
    title: 'View: Show Explorer',
    keybinding: 'Ctrl+Shift+E',
    run: () => showViewlet('explorer'),
  }, 'ctrl+shift+e');

  register({
    id: 'workbench.action.findInFiles',
    title: 'Search: Find in Files',
    keybinding: 'Ctrl+Shift+F',
    run: () => showViewlet('search'),
  }, 'ctrl+shift+f');

  register({
    id: 'workbench.view.scm',
    title: 'View: Show Source Control',
    keybinding: 'Ctrl+Shift+G',
    run: () => showViewlet('scm'),
  }, 'ctrl+shift+g');

  register({
    id: 'workbench.action.toggleSidebarVisibility',
    title: 'View: Toggle Primary Side Bar Visibility',
    keybinding: 'Ctrl+B',
    run: toggleSideBar,
  }, 'ctrl+b');

  register({
    id: 'workbench.action.togglePanel',
    title: 'View: Toggle Panel Visibility',
    keybinding: 'Ctrl+J',
    run: togglePanel,
  }, 'ctrl+j');

  register({
    id: 'workbench.action.terminal.toggleTerminal',
    title: 'Terminal: Toggle Terminal',
    keybinding: 'Ctrl+`',
    run: togglePanel,
  }, 'ctrl+`');

  register({
    id: 'workbench.action.terminal.new',
    title: 'Terminal: Create New Terminal',
    keybinding: 'Ctrl+Shift+`',
    run: () => {
      createTerminal();
      if (!workbench.panelVisible) togglePanel();
    },
  }, 'ctrl+shift+`');

  register({
    id: 'workbench.action.files.save',
    title: 'File: Save',
    keybinding: 'Ctrl+S',
    // WHY: 저장은 워킹트리를 바꾸므로 git 상태(SCM 뷰·explorer 데코·배지)를 재조회해야 한다
    run: () => void saveActive().then(refreshScm),
  }, 'ctrl+s');

  register({
    id: 'workbench.action.splitEditor',
    title: 'View: Split Editor',
    keybinding: 'Ctrl+\\',
    run: () => void splitActiveEditor(),
  }, 'ctrl+\\');

  // WHY: 브라우저 탭에서는 Ctrl+W 를 페이지가 가로챌 수 없다 (VS Code web 도 동일한 제약).
  //      palette 라벨은 VS Code 와 맞추고, 실 사용은 탭의 × 버튼이 담당한다.
  register({
    id: 'workbench.action.closeActiveEditor',
    title: 'View: Close Editor',
    keybinding: 'Ctrl+W',
    run: () => {
      const g = activeGroup();
      if (g.activeTabId) closeTab(g.id, g.activeTabId);
    },
  }, 'ctrl+w');

  // WHY: Ctrl+Shift+T 도 브라우저 예약 키 — 탭에서는 palette 로만 닿고, 예약이 없는
  //      환경(Tauri 등)에서 chord 가 산다. Ctrl+W 와 같은 사정.
  register({
    id: 'workbench.action.reopenClosedEditor',
    title: 'View: Reopen Closed Editor',
    keybinding: 'Ctrl+Shift+T',
    run: () => void reopenClosedEditor(),
  }, 'ctrl+shift+t');

  register({
    id: 'workbench.action.nextEditor',
    title: 'View: Open Next Editor',
    keybinding: 'Ctrl+PageDown',
    run: () => cycleTab(1),
  }, 'ctrl+pagedown');

  register({
    id: 'workbench.action.previousEditor',
    title: 'View: Open Previous Editor',
    keybinding: 'Ctrl+PageUp',
    run: () => cycleTab(-1),
  }, 'ctrl+pageup');

}

function cycleTab(dir: 1 | -1): void {
  const g = activeGroup();
  if (g.tabs.length < 2 || !g.activeTabId) return;
  const idx = g.tabs.findIndex((t) => t.id === g.activeTabId);
  const next = g.tabs[(idx + dir + g.tabs.length) % g.tabs.length];
  g.activeTabId = next.id;
  editors.activeGroupId = g.id;
}
