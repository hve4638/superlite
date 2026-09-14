import { reactive, watch } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';
import { activeCtx, ctx, viewOf } from './ctx';
import { subWindow } from './window';

export type ViewletId = 'explorer' | 'search' | 'scm' | 'remote' | 'terminals';
/** 퀵인풋 모드 — 파일 퀵오픈 / 커맨드 팔레트 / 폴더 경로 입력 */
export type QuickInputMode = 'files' | 'commands' | 'folder';

/** 창 이동 핸드오프의 레이아웃 몫 — 부위 크기·표시 여부만 (오버레이는 나르지 않는다) */
export interface WorkbenchSnapshot {
  sideBarVisible: boolean;
  /** 고정(pin) — 참이면 사이드바가 편집기와 가로 자리를 나눠 쓰고, 거짓(기본)이면 편집기 위에 떠 있다 (ticket floating-sidebar) */
  sideBarPinned: boolean;
  sideBarWidth: number;
  activeViewlet: ViewletId;
}

export interface ContextMenuItem {
  label?: string;
  keybinding?: string;
  /** 메뉴가 열린 동안 이 키(소문자 한 글자)를 누르면 실행 — 라벨의 "(H)" 같은 니모닉 */
  key?: string;
  separator?: boolean;
  enabled?: boolean;
  /** 체크 표시 — true 면 체크 아이콘, false 면 같은 폭의 빈 자리(같은 메뉴 안 정렬), undefined 면 자리 없음 */
  checked?: boolean;
  run?: () => void;
}

/**
 * 세션별 워크벤치 셸(레이아웃) 모듈. 부위별 크기·표시 여부와 전역 오버레이(퀵인풋,
 * 컨텍스트 메뉴). 콘텐츠(에디터/트리/검색 등)는 각자의 모델이 가진다.
 * 세션마다 인스턴스 — 탭이 각자의 사이드바·패널 배치를 기억한다 (VS Code 창 단위와 동일 감각).
 */
export function createWorkbench(backend: ThinBackend) {
  const workbench = reactive({
    workspaceName: '',
    /** 루트 절대 경로 — OS 드롭 경로 상대화용 (와이어 계약의 path 는 전부 이 기준 상대) */
    rootPath: '',

    sideBarVisible: true,
    sideBarPinned: false,
    sideBarWidth: 300,
    activeViewlet: 'explorer' as ViewletId,

    quickInput: {
      open: false,
      mode: 'files' as QuickInputMode,
    },

    contextMenu: {
      open: false,
      x: 0,
      y: 0,
      items: [] as ContextMenuItem[],
    },
  });

  async function initWorkbench(): Promise<void> {
    const info = await backend.workspace();
    workbench.workspaceName = info.name;
    workbench.rootPath = info.rootPath;
  }

  function toggleSideBar(): void {
    workbench.sideBarVisible = !workbench.sideBarVisible;
  }

  function toggleSideBarPinned(): void {
    workbench.sideBarPinned = !workbench.sideBarPinned;
  }

  /**
   * 뷰렛 표시. toggle=true(activity bar 클릭)면 이미 활성인 뷰렛은 사이드바를 접는다.
   * WHY: 키보드(Ctrl+Shift+F 등)는 VS Code 에서 접기가 아니라 뷰 포커스다 — toggle 은 클릭 전용.
   */
  function showViewlet(id: ViewletId, toggle = false): void {
    if (toggle && workbench.sideBarVisible && workbench.activeViewlet === id) {
      workbench.sideBarVisible = false;
      return;
    }
    workbench.activeViewlet = id;
    workbench.sideBarVisible = true;
  }

  function openQuickInput(mode: QuickInputMode): void {
    workbench.quickInput.open = true;
    workbench.quickInput.mode = mode;
  }

  function closeQuickInput(): void {
    workbench.quickInput.open = false;
  }

  function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    workbench.contextMenu.open = true;
    workbench.contextMenu.x = x;
    workbench.contextMenu.y = y;
    workbench.contextMenu.items = items;
  }

  function closeContextMenu(): void {
    workbench.contextMenu.open = false;
  }

  function snapshot(): WorkbenchSnapshot {
    const { sideBarVisible, sideBarPinned, sideBarWidth, activeViewlet } = workbench;
    return { sideBarVisible, sideBarPinned, sideBarWidth, activeViewlet };
  }

  function restore(s: WorkbenchSnapshot): void {
    Object.assign(workbench, s);
  }

  return {
    workbench, initWorkbench, toggleSideBar, toggleSideBarPinned, showViewlet,
    openQuickInput, closeQuickInput, openContextMenu, closeContextMenu, snapshot, restore,
  };
}

// ---- 활성 세션 전달 shim

export const workbench = viewOf(() => ctx().workbench.workbench);

/** 서브 창의 사이드바(+액티비티바) 표시 — 창 단위 상태. 세션의 sideBarVisible 은 건드리지 않아
 *  세션 스냅샷(핸드오프)에 실리지 않는다 — 서브 창에서 잠시 펼친 것이 메인 창의 세션에 번지지
 *  않는다 (ticket window-secondary-no-sidebar). 기본 접힘 — VS Code auxiliary window 처럼 편집기 위주 */
export const subShell = reactive({ sideBarVisible: false, sideBarPinned: false });

// 서브 창의 세션은 트리·SCM 을 미뤄 둔다(lazy) — 사이드바를 펼치는 순간(활성 세션이 바뀌어도) 그 세션의
// 트리·SCM 을 읽는다. 이미 읽은 세션은 무동작 (ticket window-detach-reload)
if (subWindow) {
  watch(
    () => [subShell.sideBarVisible, activeCtx.value] as const,
    ([shown, c]) => {
      if (shown && c) void c.loadWorkspace();
    },
  );
}

/** 이 창에서 사이드바를 그리는가 — 메인 창은 세션 상태, 서브 창은 창 단위 상태 */
export function sideBarShown(): boolean {
  return subWindow ? subShell.sideBarVisible : workbench.sideBarVisible;
}

/** 사이드바 고정 여부 — 메인 창은 세션 상태, 서브 창은 창 단위 상태. 거짓이면 플로팅 (ticket floating-sidebar) */
export function sideBarPinned(): boolean {
  return subWindow ? subShell.sideBarPinned : workbench.sideBarPinned;
}

export function toggleSideBarPinned(): void {
  if (subWindow) subShell.sideBarPinned = !subShell.sideBarPinned;
  else ctx().workbench.toggleSideBarPinned();
}

/** 플로팅 사이드바 접기 — 사이드바 밖(편집기 영역) 클릭 때. 고정 상태면 무동작 */
export function hideFloatingSideBar(): void {
  if (sideBarPinned()) return;
  if (subWindow) subShell.sideBarVisible = false;
  else ctx().workbench.workbench.sideBarVisible = false;
}

/** 액티비티바 — 메인 창은 늘 그린다 (사이드바를 접어도 남는다, VS Code 동일). 서브 창은 사이드바와 함께 */
export function activityBarShown(): boolean {
  return !subWindow || subShell.sideBarVisible;
}

export function toggleSideBar(): void {
  if (subWindow) subShell.sideBarVisible = !subShell.sideBarVisible;
  else ctx().workbench.toggleSideBar();
}

export function showViewlet(id: ViewletId, toggle = false): void {
  if (!subWindow) {
    ctx().workbench.showViewlet(id, toggle);
    return;
  }
  // 서브 창 — 뷰렛 선택은 세션 몫이되 펼침 여부는 창 몫 (같은 토글 규칙)
  const wb = ctx().workbench.workbench;
  if (toggle && subShell.sideBarVisible && wb.activeViewlet === id) {
    subShell.sideBarVisible = false;
    return;
  }
  wb.activeViewlet = id;
  subShell.sideBarVisible = true;
}
export const openQuickInput = (mode: QuickInputMode): void =>
  ctx().workbench.openQuickInput(mode);
export const closeQuickInput = (): void => ctx().workbench.closeQuickInput();
export const openContextMenu = (x: number, y: number, items: ContextMenuItem[]): void =>
  ctx().workbench.openContextMenu(x, y, items);
export const closeContextMenu = (): void => ctx().workbench.closeContextMenu();
