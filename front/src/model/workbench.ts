import { reactive } from '@vue/reactivity';
import { backend } from './host';

export type ViewletId = 'explorer' | 'search' | 'scm';

export interface ContextMenuItem {
  label?: string;
  keybinding?: string;
  separator?: boolean;
  enabled?: boolean;
  run?: () => void;
}

/**
 * 워크벤치 셸(레이아웃) 상태. 부위별 크기·표시 여부와 전역 오버레이(퀵인풋, 컨텍스트 메뉴).
 * 콘텐츠(에디터/트리/검색 등)는 각자의 모델이 가진다.
 */
export const workbench = reactive({
  workspaceName: '',
  /** 루트 절대 경로 — OS 드롭 경로 상대화용 (와이어 계약의 path 는 전부 이 기준 상대) */
  rootPath: '',

  sideBarVisible: true,
  sideBarWidth: 300,
  activeViewlet: 'explorer' as ViewletId,

  panelVisible: false,
  panelHeight: 0,

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

export async function initWorkbench(): Promise<void> {
  const info = await backend.workspace();
  workbench.workspaceName = info.name;
  workbench.rootPath = info.rootPath;
}

export function toggleSideBar(): void {
  workbench.sideBarVisible = !workbench.sideBarVisible;
}

/**
 * 뷰렛 표시. toggle=true(activity bar 클릭)면 이미 활성인 뷰렛은 사이드바를 접는다.
 * WHY: 키보드(Ctrl+Shift+F 등)는 VS Code 에서 접기가 아니라 뷰 포커스다 — toggle 은 클릭 전용.
 */
export function showViewlet(id: ViewletId, toggle = false): void {
  if (toggle && workbench.sideBarVisible && workbench.activeViewlet === id) {
    workbench.sideBarVisible = false;
    return;
  }
  workbench.activeViewlet = id;
  workbench.sideBarVisible = true;
}

export function togglePanel(): void {
  if (!workbench.panelVisible && workbench.panelHeight === 0) {
    // WHY: 레퍼런스(1280x800)에서 최초 패널 높이는 가용 높이(타이틀바·상태바 제외)의 36% ≈ 267px.
    //      px 고정값 대신 이 비율을 쓰면 다른 뷰포트에서도 레퍼런스와 같은 위치에 열린다.
    workbench.panelHeight = Math.round((window.innerHeight - 35 - 22) * 0.36);
  }
  workbench.panelVisible = !workbench.panelVisible;
}

export function openQuickInput(mode: 'files' | 'commands' | 'folder'): void {
  workbench.quickInput.open = true;
  workbench.quickInput.mode = mode;
}

export function closeQuickInput(): void {
  workbench.quickInput.open = false;
}

export function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  workbench.contextMenu.open = true;
  workbench.contextMenu.x = x;
  workbench.contextMenu.y = y;
  workbench.contextMenu.items = items;
}

export function closeContextMenu(): void {
  workbench.contextMenu.open = false;
}
