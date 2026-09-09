import { openQuickInput, showViewlet, toggleSideBar } from './workbench';
import { openFolderDialog } from './host';
import { closeTab, editors, reopenClosedEditor, saveActive, splitGroup, toggleGroupLock, activeGroup, activeTab, openHex, toggleHtmlPreview, isHtml, toggleWordWrap, stepEditorZoom, setEditorZoom } from './editors';
import { createTerminal } from './terminal';
import { refreshScm } from './scm';
import { activeSessionEmpty, cycleSession, sessionsEnabled } from './sessions';
import { inApp, reloadWindow, zoomWindow } from './window';
import { showAbout } from './version';
import { toggleVimMode, vimAvailable } from './nvim';

export interface Command {
  id: string;
  /** palette 표시명. "View: Toggle Terminal" 처럼 카테고리 접두 포함 */
  title: string;
  /** 표시용 키바인딩 라벨 (예: "Ctrl+Shift+P") */
  keybinding?: string;
  /** 터미널 포커스 중에도 워크벤치가 가로챈다 (VS Code commandsToSkipShell). 없으면 셸행 */
  skipShell?: boolean;
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
const CODE_KEYS: Record<string, string> = { Backquote: '`', Backslash: '\\', Equal: '=', Minus: '-', Digit0: '0' };

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

/** 터미널 포커스 중에도 워크벤치가 가로채는 chord 인지 — skipShell 표식 커맨드만.
 *  WHY: 나머지(Ctrl+W 단어 삭제, Ctrl+B tmux 접두, Ctrl+S 등)는 셸이 받아야 한다.
 *      Ctrl+B 는 VS Code 기본과 달리 셸로 보낸다 (사용자 지시, terminal-usability) */
export function isShellSkippingChord(e: KeyboardEvent): boolean {
  return byChord.get(chordOf(e))?.skipShell === true;
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
    skipShell: true,
    run: () => openQuickInput('commands'),
  }, 'ctrl+shift+p', 'f1');

  register({
    id: 'workbench.action.quickOpen',
    title: 'Go to File...',
    keybinding: 'Ctrl+P',
    skipShell: true,
    run: () => openQuickInput('files'),
  }, 'ctrl+p');

  register({
    id: 'workbench.view.explorer',
    title: 'View: Show Explorer',
    keybinding: 'Ctrl+Shift+E',
    skipShell: true,
    run: () => showViewlet('explorer'),
  }, 'ctrl+shift+e');

  register({
    id: 'workbench.action.findInFiles',
    title: 'Search: Find in Files',
    keybinding: 'Ctrl+Shift+F',
    skipShell: true,
    run: () => showViewlet('search'),
  }, 'ctrl+shift+f');

  register({
    id: 'workbench.view.scm',
    title: 'View: Show Source Control',
    keybinding: 'Ctrl+Shift+G',
    skipShell: true,
    run: () => showViewlet('scm'),
  }, 'ctrl+shift+g');

  register({
    id: 'workbench.action.toggleSidebarVisibility',
    title: 'View: Toggle Primary Side Bar Visibility',
    keybinding: 'Ctrl+B',
    run: toggleSideBar,
  }, 'ctrl+b');

  // 터미널은 편집기 탭 — 하단 패널이 없으므로 Ctrl+J(패널 토글)·Ctrl+Shift+`(구 새 터미널)는 없다.
  // Ctrl+` 는 누를 때마다 새 터미널 탭 (사용자 지시 2026-09-07)
  register({
    id: 'workbench.action.terminal.new',
    title: 'Terminal: Create New Terminal',
    keybinding: 'Ctrl+`',
    skipShell: true,
    run: () => {
      if (activeSessionEmpty()) return; // 빈 세션 — 백엔드 연결이 없어 터미널이 없다
      createTerminal();
    },
  }, 'ctrl+`');

  register({
    id: 'workbench.action.files.save',
    title: 'File: Save',
    keybinding: 'Ctrl+S',
    // WHY: 저장은 워킹트리를 바꾸므로 git 상태(SCM 뷰·explorer 데코·배지)를 재조회해야 한다
    run: () => void saveActive().then(refreshScm),
  }, 'ctrl+s');

  // 빈 그룹 생성 — 탭 복제가 아니다. Ctrl+\ 키바인딩은 사용자 결정으로 없앴다 (editor-group-empty-lock, 2026-09-08)
  register({
    id: 'workbench.action.splitEditor',
    title: 'View: Split Editor',
    run: () => splitGroup(),
  });

  register({
    id: 'workbench.action.reloadWindow',
    title: 'Developer: Reload Window',
    run: reloadWindow,
  });

  register({
    id: 'workbench.action.toggleEditorGroupLock',
    title: 'View: Toggle Editor Group Lock',
    run: () => toggleGroupLock(activeGroup().id),
  });

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

  // '폴더 열기' — Ctrl+O 는 모든 환경에서 경로 입력 퀵인풋을 연다 ("Open folder by path",
  // VS Code 원격과 같은 방식 — 확정은 host.openFolder). 앱은 퀵인풋이 열린 상태에서 Ctrl+O 를
  // 한 번 더 누르면 OS 다이얼로그로 넘어간다 (QuickInput, web-folder-open.md). mock 은 세션
  // 개념이 없어 미등록.
  if (sessionsEnabled()) {
    register({
      id: 'workbench.action.files.openFolder',
      title: 'File: Open Folder...',
      keybinding: 'Ctrl+O',
      run: () => openQuickInput('folder'),
    }, 'ctrl+o');
  }
  if (inApp) {
    register({
      id: 'workbench.action.files.openFolderDialog',
      title: 'File: Open Folder (OS Dialog)...',
      // host.openFolderDialog — 활성 빈 탭이면 그 자리를 교체하는 replace 판단 포함
      run: openFolderDialog,
    });
  }

  // 키 배정(사용자 확정): Ctrl+Tab = 워크스페이스 안 에디터 탭 넘기기, Ctrl+Shift+Tab =
  // 세션 탭 순환. 브라우저에서는 둘 다 예약키라 앱 전용이고 (Ctrl+PageUp/Down 이 겸용 대안),
  // Ctrl+Alt+Tab 은 Windows OS 태스크 전환기가 가로채 기각 (실기 확인).
  if (sessionsEnabled()) {
    register({
      id: 'workbench.action.nextSessionTab',
      title: 'View: Switch to Next Session Tab',
      keybinding: 'Ctrl+Shift+Tab',
      skipShell: true,
      run: () => cycleSession(1),
    }, 'ctrl+shift+tab');
  }

  register({
    id: 'workbench.action.nextEditor',
    title: 'View: Open Next Editor',
    keybinding: 'Ctrl+Tab',
    skipShell: true,
    run: () => cycleTab(1),
  }, 'ctrl+tab', 'ctrl+pagedown');

  register({
    id: 'workbench.action.previousEditor',
    title: 'View: Open Previous Editor',
    keybinding: 'Ctrl+PageUp',
    skipShell: true,
    run: () => cycleTab(-1),
  }, 'ctrl+pageup');

  // 활성 탭의 경로를 hex 뷰어로 — 이진 안내 탭의 링크와 같은 진입 (텍스트 파일도 hex 로 볼 수 있다)
  register({
    id: 'hexEditor.openFile',
    title: 'Hex Editor: Open Active File in Hex Editor',
    run: () => {
      const t = activeTab();
      if (t && t.kind !== 'preview') openHex(t.path);
    },
  });

  register({
    id: 'editor.action.toggleWordWrap',
    title: 'View: Toggle Word Wrap',
    keybinding: 'Alt+Z',
    run: toggleWordWrap,
  }, 'alt+z');

  // VS Code markdown 프리뷰의 키를 HTML 에 — 활성 탭을 제자리에서 편집기 ↔ 프리뷰 전환. .html 이 아니면 no-op
  register({
    id: 'html.togglePreview',
    title: 'HTML: Toggle Preview',
    keybinding: 'Ctrl+Shift+V',
    run: () => {
      const t = activeTab();
      if (t && (t.kind === 'preview' || isHtml(t.path))) toggleHtmlPreview(activeGroup().id, t.id);
    },
  }, 'ctrl+shift+v');

  // 키 배정(사용자 확정, VS Code 기본과 다름): 편집기 글꼴 줌이 1차 기능이라 Ctrl+= / Ctrl+- / Ctrl+0,
  // UI 포함 전역(웹뷰) 줌은 Shift 를 얹어 Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0. 숫자패드 +/- 도 같은 규칙.
  // 전역 줌은 앱 전용 — 웹은 같은 키가 브라우저 줌이라 등록하지 않는다. 배율은 앱 전체 공통이고
  // native 가 레벨을 소유·저장한다 (app/src/main set_zoom)
  if (inApp) {
    register({
      id: 'workbench.action.zoomIn',
      title: 'View: Zoom In',
      keybinding: 'Ctrl+Shift+=',
      skipShell: true, // 앱 전역 줌은 터미널 포커스 중에도
      run: () => zoomWindow('in'),
    }, 'ctrl+shift+=', 'ctrl+shift++');
    register({
      id: 'workbench.action.zoomOut',
      title: 'View: Zoom Out',
      keybinding: 'Ctrl+Shift+-',
      skipShell: true, // 앱 전역 줌은 터미널 포커스 중에도
      run: () => zoomWindow('out'),
    }, 'ctrl+shift+-');
    register({
      id: 'workbench.action.zoomReset',
      title: 'View: Reset Zoom',
      keybinding: 'Ctrl+Shift+0',
      skipShell: true, // 앱 전역 줌은 터미널 포커스 중에도
      run: () => zoomWindow('reset'),
    }, 'ctrl+shift+0');
  }

  // 편집기 전용 줌 — 상태바 배율 항목과 같은 값. 모든 환경 (웹에서는 브라우저 줌 키를 가로챈다 — Ctrl+휠·
  // Ctrl+Shift+= 는 브라우저에 남는다)
  register({
    id: 'editor.action.fontZoomIn',
    title: 'View: Editor Font Zoom In',
    keybinding: 'Ctrl+=',
    run: () => stepEditorZoom(1),
  }, 'ctrl+=', 'ctrl++');
  register({
    id: 'editor.action.fontZoomOut',
    title: 'View: Editor Font Zoom Out',
    keybinding: 'Ctrl+-',
    run: () => stepEditorZoom(-1),
  }, 'ctrl+-');
  register({
    id: 'editor.action.fontZoomReset',
    title: 'View: Editor Font Zoom Reset',
    keybinding: 'Ctrl+0',
    run: () => setEditorZoom(100),
  }, 'ctrl+0');

  // 편집기 vim 모드 (임베드 nvim) — 상태바 항목 클릭과 같은 토글. mock 은 relay 가 없어 미등록
  if (vimAvailable()) {
    register({
      id: 'vim.toggle',
      title: 'View: Toggle Vim Mode',
      run: toggleVimMode,
    });
  }

  register({
    id: 'workbench.action.showAboutDialog',
    title: 'Help: About',
    run: () => showAbout(),
  });
}

function cycleTab(dir: 1 | -1): void {
  const g = activeGroup();
  if (g.tabs.length < 2 || !g.activeTabId) return;
  const idx = g.tabs.findIndex((t) => t.id === g.activeTabId);
  const next = g.tabs[(idx + dir + g.tabs.length) % g.tabs.length];
  g.activeTabId = next.id;
  editors.activeGroupId = g.id;
}
