<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { workbench, toggleSideBar, togglePanel, openQuickInput, openContextMenu } from '../model/workbench';
import {
  inApp,
  appWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  windowLabel,
} from '../model/window';
import {
  sessions,
  sessionsEnabled,
  activateSession,
  closeSession,
  addEmptySession,
  moveSession,
  renameSession,
  isRemoteEmpty,
  remoteHost,
  multiWindow,
  detachSession,
  detachSessionNearby,
  requestSessionMove,
  moveSessionToWindow,
  listWindows,
  DND_SESSION,
  type SessionTab,
  loading,
} from '../model/sessions';
import { pointerOutside } from './dndUtil';

// 같은 이름(루트 basename)의 세션이 여럿이면 부모 디렉토리 힌트로 구분한다 (에디터 탭과 같은 규칙)
const descriptions = computed(() => {
  const byName = new Map<string, SessionTab[]>();
  for (const t of sessions.list) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  const out = new Map<string, string>();
  for (const tabs of byName.values()) {
    if (tabs.length < 2) continue;
    // 빈 세션(root null)은 경로 힌트가 없다 — 같은 라벨의 빈 탭 여럿은 구분 없이 수용
    for (const t of tabs) if (t.root !== null) out.set(t.id, parentHint(t.root));
  }
  return out;
});

/** 탭 라벨 — 이름은 워크스페이스 정보가 오면 채워진다: 그 전엔 빈 세션만 Welcome, 로드 중인
 *  세션은 공백. 원격 빈 세션(경로 없는 ssh://host)은 이름과 무관하게 "Welcome [host]" */
function sessionLabel(tab: SessionTab): string {
  if (isRemoteEmpty(tab.root)) return `Welcome [${remoteHost(tab.root ?? '')}]`;
  return tab.name || (tab.root === null ? 'Welcome' : '…');
}

/** 루트의 부모 디렉토리명 — root 는 native 경로라 구분자가 OS 마다 다르다 */
function parentHint(root: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const segs = root.split(sep).filter((s) => s !== '');
  return segs.length >= 2 ? segs[segs.length - 2] : sep;
}

/** 드롭다운의 'Open Folder...' — 경로 입력 퀵인풋 (앱·웹 공통. OS 다이얼로그는
 *  퀵인풋에서 Ctrl+O 한 번 더). + 자체는 빈 탭을 만든다 — 폴더 열기는 시작 페이지 또는 이 드롭다운에서 */
function openFolderEntry(): void {
  openQuickInput('folder');
}

/** + 옆 드롭다운(Windows Terminal 의 v) — 열기 방식이 늘면 여기로 */
function openAddMenu(e: MouseEvent): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 4, [{ label: 'Open Folder...', run: openFolderEntry }]);
}

// 세션 탭 드래그 순서 이동 — 세션 탭끼리만 오가는 로컬 상태 (에디터 탭 DnD 와 무관).
// dropIndex 는 표시 목록 기준 삽입 인덱스 — 삽입선 표시와 드롭 위치에 쓴다.
// foreign = 다른 창에서 끌고 온 세션 탭 (dragover 중엔 dataTransfer 타입만 읽을 수 있다 —
// 데이터는 drop 에서). 삽입선은 둘 다 같은 규칙으로 그린다
const dragId = ref<string | null>(null);
const dropIndex = ref<number | null>(null);
const foreign = ref(false);
/** 새 창의 타이틀바 탭(35px)이 포인터 아래 오도록 창을 올리는 오프셋 */
const TAB_GRAB_Y = 17;
const dragging = computed(() => dragId.value !== null || foreign.value);

function isForeign(e: DragEvent): boolean {
  return dragId.value === null && multiWindow() && (e.dataTransfer?.types.includes(DND_SESSION) ?? false);
}

function onTabDragStart(e: DragEvent, tab: SessionTab): void {
  // setData 는 Firefox 의 드래그 시작 요건 — 실제 식별은 dragId 로 한다
  e.dataTransfer?.setData('text/plain', tab.id);
  // 다른 창의 탭 스트립이 출처를 알 수 있게 — 창 label + 세션 id
  if (multiWindow()) e.dataTransfer?.setData(DND_SESSION, JSON.stringify({ window: windowLabel, id: tab.id }));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  dragId.value = tab.id;
}

// 탭 위 드래그 — 좌/우 절반 기준으로 삽입 지점 결정 (에디터 탭과 같은 규칙)
function onTabDragOver(e: DragEvent, i: number): void {
  if (isForeign(e)) foreign.value = true;
  if (!dragging.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropIndex.value = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
}

// 탭 사이 틈 — 탭 위에서 정한 삽입 지점을 유지한 채 드롭만 허용한다 (다른 창 탭은 끝에)
function onStripDragOver(e: DragEvent): void {
  if (isForeign(e)) {
    foreign.value = true;
    dropIndex.value ??= sessions.list.length;
  }
  if (!dragging.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}

function onStripDrop(e: DragEvent): void {
  if (!dragging.value) return;
  e.preventDefault();
  if (dragId.value !== null) {
    if (dropIndex.value !== null) moveSession(dragId.value, dropIndex.value);
  } else {
    // 다른 창의 세션 탭 병합 — 상태는 출처 창에 있으니 이동을 요청한다 (핸드오프는 출처가 만든다)
    const raw = e.dataTransfer?.getData(DND_SESSION);
    if (raw) {
      const data = JSON.parse(raw) as { window: string; id: string };
      if (data.window !== windowLabel) requestSessionMove(data.window, data.id, dropIndex.value ?? sessions.list.length);
    }
  }
  endTabDrag();
}

// 출처 창의 dragend — 아무 드롭 존도 받지 않았고(dropEffect none) 포인터가 이 창 밖이면
// 창 밖 드롭 = 새 창으로 분리. 다른 창의 스트립이 받았으면 그쪽이 이동을 요청해 온다
function onTabDragEnd(e: DragEvent): void {
  const id = dragId.value;
  if (id !== null && multiWindow() && e.dataTransfer?.dropEffect === 'none' && pointerOutside(e)) {
    // 새 창의 탭이 포인터 아래 오도록 살짝 왼쪽 위로
    detachSession(id, e.screenX - 100, e.screenY - TAB_GRAB_Y);
  }
  endTabDrag();
}

function endTabDrag(): void {
  dragId.value = null;
  dropIndex.value = null;
  foreign.value = false;
}

// 대상 창에는 dragend 가 오지 않는다 — 다른 창의 탭이 스트립을 벗어나면 여기서 foreign 을
// 풀어야 이후 무관한 드래그를 삼키지 않는다. 자식 요소 사이 이동은 leave 가 아니다
function onStripDragLeave(e: DragEvent): void {
  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
  dropIndex.value = null;
  foreign.value = false;
}

/** 세션 탭 우클릭 — 창 이동 메뉴 (앱 전용). 창 간 DnD 가 안 되는 환경의 대체 경로이기도 하다 */
function onTabContextMenu(e: MouseEvent, tab: SessionTab): void {
  if (!multiWindow()) return; // 웹은 브라우저 기본 메뉴 그대로
  e.preventDefault();
  void listWindows().then((wins) => {
    const others = wins.filter((w) => w.label !== windowLabel);
    openContextMenu(e.clientX, e.clientY, [
      { label: 'Move to New Window', run: () => detachSessionNearby(tab.id) },
      ...(others.length ? [{ separator: true }] : []),
      ...others.map((w) => ({ label: `Move to Window "${w.title}"`, run: () => moveSessionToWindow(tab.id, w.label) })),
    ]);
  });
}

// 탭 더블클릭 rename — 인라인 input 으로 교체, Enter/blur 확정·Esc 취소
const renamingId = ref<string | null>(null);
const renameValue = ref('');

function startRename(tab: SessionTab): void {
  renamingId.value = tab.id;
  renameValue.value = tab.name;
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.session-rename');
    el?.focus();
    el?.select();
  });
}

function commitRename(): void {
  if (renamingId.value === null) return;
  renameSession(renamingId.value, renameValue.value);
  renamingId.value = null;
}
</script>

<template>
  <!-- data-tauri-drag-region 은 이벤트 target 에만 적용된다 — 드래그할 빈 영역마다 직접 붙인다 -->
  <div class="titlebar" data-tauri-drag-region>
    <!-- 좌측정렬 워크스페이스 세션 탭 (decision/workspace-session-tabs.md, Windows Terminal 참조)
         — 탭 밖 여백은 드래그 영역. 웹에서도 그린다 (mock 만 제외) -->
    <div class="titlebar-tabs" data-tauri-drag-region>
      <div
        v-if="sessionsEnabled() && sessions.list.length"
        class="session-tabs"
        @dragover="onStripDragOver"
        @dragleave="onStripDragLeave($event)"
        @drop="onStripDrop"
      >
        <div
          v-for="(tab, i) in sessions.list"
          :key="tab.id"
          class="session-tab"
          :class="{
            active: tab.id === sessions.activeId,
            'drop-before': dragging && dropIndex === i,
            'drop-after': dragging && dropIndex === i + 1 && i === sessions.list.length - 1,
          }"
          :title="tab.root ?? undefined"
          :draggable="renamingId !== tab.id"
          @dragstart="onTabDragStart($event, tab)"
          @dragend="onTabDragEnd($event)"
          @dragover="onTabDragOver($event, i)"
          @click="activateSession(tab.id)"
          @contextmenu="onTabContextMenu($event, tab)"
          @dblclick="startRename(tab)"
          @mousedown.middle.prevent="closeSession(tab.id)"
        >
          <input
            v-if="renamingId === tab.id"
            v-model="renameValue"
            class="session-rename"
            @keydown.enter="commitRename()"
            @keydown.esc="renamingId = null"
            @blur="commitRename()"
            @click.stop
            @dblclick.stop
            @mousedown.stop
          />
          <template v-else>
            <!-- 빈 세션(이름 없음)의 표시 라벨 — 시작 페이지 탭임을 나타낸다 -->
            <!-- 이름은 워크스페이스 정보가 오면 채워진다 — 그 전엔 빈 세션만 Welcome, 로드 중인 세션은 공백 -->
            <span class="session-name">{{ sessionLabel(tab) }}</span>
            <span v-if="descriptions.get(tab.id)" class="session-description">{{
              descriptions.get(tab.id)
            }}</span>
          </template>
          <!-- 로딩 스피너 — 초기 로드(ctx.init) 중, X 바로 왼쪽. 예비 파이프 접속은 상태바 단계가
               안 보이므로 로드 완료의 유일한 시각 신호다 -->
          <span v-if="loading.has(tab.id)" class="session-loading codicon codicon-loading codicon-modifier-spin" />
          <span
            class="session-close codicon codicon-close"
            @click.stop="closeSession(tab.id)"
          />
        </div>
        <!-- 탭 끝의 + = 빈 세션 탭 (시작 페이지에서 폴더 열기로 잇는다),
             옆의 v = 열기 방식 드롭다운 (Windows Terminal 구성) -->
        <span
          class="session-add codicon codicon-add"
          title="New Session"
          @click="addEmptySession()"
        />
        <span
          class="session-add session-add-menu codicon codicon-chevron-down"
          title="Open Options"
          @click="openAddMenu($event)"
        />
      </div>
    </div>
    <div class="titlebar-right" data-tauri-drag-region>
      <span
        class="codicon codicon-layout-sidebar-left layout-icon"
        :class="{ off: !workbench.sideBarVisible }"
        @click="toggleSideBar()"
      />
      <span
        class="codicon codicon-layout-panel layout-icon"
        :class="{ off: !workbench.panelVisible }"
        @click="togglePanel()"
      />
    </div>
    <div v-if="inApp" class="window-controls">
      <div
        class="window-control codicon codicon-chrome-minimize"
        @click="minimizeWindow()"
      />
      <div
        class="window-control codicon"
        :class="appWindow.maximized ? 'codicon-chrome-restore' : 'codicon-chrome-maximize'"
        @click="toggleMaximizeWindow()"
      />
      <div
        class="window-control window-control-close codicon codicon-chrome-close"
        @click="closeWindow()"
      />
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
  display: flex;
  align-items: stretch;
  height: 35px;
  background: var(--vscode-titleBar-activeBackground);
  color: var(--vscode-titleBar-activeForeground);
  flex-shrink: 0;
}
.titlebar-tabs {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
}
/* C 시안 (VS Code 에디터 탭 문법) 실험 적용 — 전체 높이 사각 탭, 활성 = 에디터
   배경 + 상단 2px 액센트 라인, 탭 경계는 1px border */
.session-tabs {
  display: flex;
  align-items: stretch;
  height: 100%;
  gap: 0;
  max-width: 100%;
  overflow: hidden;
}
.session-tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px; /* 이름이 길어 auto 마진이 0 이 돼도 이름-x 사이 최소 간격 */
  min-width: 150px;
  padding: 0 4px 0 12px;
  border-right: 1px solid var(--vscode-tab-border);
  font-size: 12px;
  cursor: default; /* 탭 몸통은 pointer 로 바뀌지 않는다 — 버튼(x·+·v)만 pointer */
  white-space: nowrap;
  overflow: visible;
  color: var(--vscode-titleBar-inactiveForeground);
  background: transparent;
}
.session-tab:first-child {
  border-left: 1px solid var(--vscode-tab-border);
}
.session-tab:hover {
  background: rgba(255, 255, 255, 0.04);
}
/* 탭 드래그 삽입선 — 탭 사이 틈(gap 4px) 가운데의 세로 직선. inset box-shadow 는
   둥근 모서리를 따라가 반달처럼 보여서 쓰지 않는다 */
.session-tab.drop-before::after,
.session-tab.drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--vscode-focusBorder);
  pointer-events: none;
}
.session-tab.drop-before::after {
  left: -1px;
}
.session-tab.drop-after::after {
  right: -1px;
}
.session-tab.active {
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-titleBar-activeForeground);
  box-shadow: inset 0 2px 0 var(--vscode-tab-activeBorderTop);
}
.session-description {
  font-size: 10px;
  opacity: 0.7;
}
/* 후행 셀렉터 — codicon.css 의 (0,2,0) 규칙이 display 를 덮는다 (창 제어 버튼과 같은 사유) */
.session-tab .session-close {
  margin-left: auto; /* min-width 로 생긴 여백에서 닫기는 오른쪽 끝 (Windows Terminal 동일) */
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px; /* 가로로 넓은 히트 영역 — 탭 밖 + 버튼(28x22)과 같은 크기로 맞춘다 */
  height: 22px;
  font-size: 15px;
  border-radius: 4px;
  cursor: pointer;
  visibility: hidden;
}
.session-rename {
  flex: 1;
  min-width: 60px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 2px;
  background: var(--vscode-editor-background);
  color: var(--vscode-titleBar-activeForeground);
  font-size: 12px;
  outline: none;
}
.session-tab:hover .session-close,
.session-tab.active .session-close {
  visibility: visible;
}
/* 스피너가 있으면 스피너가 오른쪽 정렬 여백을 맡고 X 는 바로 그 옆 */
.session-tab .session-loading {
  margin-left: auto;
  display: flex;
  align-items: center;
  font-size: 14px;
}
.session-tab .session-loading + .session-close {
  margin-left: 0;
}
.session-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.titlebar-tabs .session-add {
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px; /* 가로로 넓은 히트 영역 (닫기 버튼과 같은 방침) */
  height: 22px;
  margin-left: 8px; /* 마지막 탭과의 간격 */
  font-size: 14px;
  border-radius: 4px;
  cursor: pointer;
}
.session-add:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.session-add-menu {
  margin-left: 2px;
  font-size: 12px;
}
.titlebar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  padding: 0 8px;
  flex-shrink: 0;
}
.layout-icon {
  font-size: 16px;
  padding: 4px;
  border-radius: 5px;
  cursor: pointer;
}
.layout-icon:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.layout-icon.off {
  opacity: 0.6;
}
.window-controls {
  display: flex;
  flex-shrink: 0;
}
/* WHY: 후행 셀렉터 — codicon.css 의 .codicon[class*='codicon-'] (0,2,0) 이 display 를
   inline-block 으로 덮어 글리프가 35px 상자의 위에 붙었다 (Windows 에서 -ㅁx 가 위로 치우침) */
.window-controls .window-control {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  font-size: 16px;
}
.window-control:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
/* VS Code 도 창 닫기 hover 색은 토큰 없이 고정값이다 (workbench 하드코드) */
.window-control-close:hover {
  background: rgba(232, 17, 35, 0.9);
  color: #ffffff;
}
</style>
