import { reactive } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';

export type ViewletId = 'explorer' | 'search' | 'scm' | 'remote' | 'terminals';

/** 창 이동 핸드오프의 레이아웃 몫 — 부위 크기·표시 여부만 (오버레이는 나르지 않는다) */
export interface WorkbenchSnapshot {
  sideBarVisible: boolean;
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
    sideBarWidth: 300,
    activeViewlet: 'explorer' as ViewletId,

    quickInput: {
      open: false,
      mode: 'files' as 'files' | 'commands' | 'folder',
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

  function openQuickInput(mode: 'files' | 'commands' | 'folder'): void {
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
    const { sideBarVisible, sideBarWidth, activeViewlet } = workbench;
    return { sideBarVisible, sideBarWidth, activeViewlet };
  }

  function restore(s: WorkbenchSnapshot): void {
    Object.assign(workbench, s);
  }

  return {
    workbench, initWorkbench, toggleSideBar, showViewlet,
    openQuickInput, closeQuickInput, openContextMenu, closeContextMenu, snapshot, restore,
  };
}

// ---- 활성 세션 전달 shim

export const workbench = viewOf(() => ctx().workbench.workbench);
export const toggleSideBar = (): void => ctx().workbench.toggleSideBar();
export const showViewlet = (id: ViewletId, toggle = false): void =>
  ctx().workbench.showViewlet(id, toggle);
export const openQuickInput = (mode: 'files' | 'commands' | 'folder'): void =>
  ctx().workbench.openQuickInput(mode);
export const closeQuickInput = (): void => ctx().workbench.closeQuickInput();
export const openContextMenu = (x: number, y: number, items: ContextMenuItem[]): void =>
  ctx().workbench.openContextMenu(x, y, items);
export const closeContextMenu = (): void => ctx().workbench.closeContextMenu();
