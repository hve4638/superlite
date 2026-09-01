<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { workbench, toggleSideBar, togglePanel, openQuickInput, openContextMenu } from '../model/workbench';
import {
  inApp,
  appWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
} from '../model/window';
import {
  sessions,
  sessionsEnabled,
  activateSession,
  closeSession,
  addSession,
  moveSession,
  renameSession,
  type SessionTab,
} from '../model/sessions';

// 같은 이름(루트 basename)의 세션이 여럿이면 부모 디렉토리 힌트로 구분한다 (에디터 탭과 같은 규칙)
const descriptions = computed(() => {
  const byName = new Map<string, SessionTab[]>();
  for (const t of sessions.list) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  const out = new Map<string, string>();
  for (const tabs of byName.values()) {
    if (tabs.length < 2) continue;
    for (const t of tabs) out.set(t.id, parentHint(t.root));
  }
  return out;
});

/** 루트의 부모 디렉토리명 — root 는 native 경로라 구분자가 OS 마다 다르다 */
function parentHint(root: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const segs = root.split(sep).filter((s) => s !== '');
  return segs.length >= 2 ? segs[segs.length - 2] : sep;
}

/** 기본 열기 — + 버튼과 드롭다운의 'Open Folder...' 가 공유한다 */
function openDefault(): void {
  addSession(() => openQuickInput('folder'));
}

/** + 옆 드롭다운(Windows Terminal 의 v) — 지금은 기본 열기 하나만, 열기 방식이 늘면 여기로 */
function openAddMenu(e: MouseEvent): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 4, [{ label: 'Open Folder...', run: openDefault }]);
}

// 세션 탭 드래그 순서 이동 — 세션 탭끼리만 오가는 로컬 상태 (에디터 탭 DnD 와 무관).
// dropIndex 는 표시 목록 기준 삽입 인덱스 — 삽입선 표시와 드롭 위치에 쓴다
const dragId = ref<string | null>(null);
const dropIndex = ref<number | null>(null);

function onTabDragStart(e: DragEvent, tab: SessionTab): void {
  // setData 는 Firefox 의 드래그 시작 요건 — 실제 식별은 dragId 로 한다
  e.dataTransfer?.setData('text/plain', tab.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  dragId.value = tab.id;
}

// 탭 위 드래그 — 좌/우 절반 기준으로 삽입 지점 결정 (에디터 탭과 같은 규칙)
function onTabDragOver(e: DragEvent, i: number): void {
  if (!dragId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropIndex.value = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
}

// 탭 사이 틈 — 탭 위에서 정한 삽입 지점을 유지한 채 드롭만 허용한다
function onStripDragOver(e: DragEvent): void {
  if (!dragId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}

function onStripDrop(e: DragEvent): void {
  if (!dragId.value) return;
  e.preventDefault();
  if (dropIndex.value !== null) moveSession(dragId.value, dropIndex.value);
  endTabDrag();
}

function endTabDrag(): void {
  dragId.value = null;
  dropIndex.value = null;
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
        @dragleave="dropIndex = null"
        @drop="onStripDrop"
      >
        <div
          v-for="(tab, i) in sessions.list"
          :key="tab.id"
          class="session-tab"
          :class="{
            active: tab.id === sessions.activeId,
            'drop-before': dragId !== null && dropIndex === i,
            'drop-after': dragId !== null && dropIndex === i + 1 && i === sessions.list.length - 1,
          }"
          :title="tab.root"
          :draggable="renamingId !== tab.id"
          @dragstart="onTabDragStart($event, tab)"
          @dragend="endTabDrag()"
          @dragover="onTabDragOver($event, i)"
          @click="activateSession(tab.id)"
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
            <span class="session-name">{{ tab.name }}</span>
            <span v-if="descriptions.get(tab.id)" class="session-description">{{
              descriptions.get(tab.id)
            }}</span>
          </template>
          <span
            class="session-close codicon codicon-close"
            @click.stop="closeSession(tab.id)"
          />
        </div>
        <!-- 탭 끝의 + = 기본 열기, 옆의 v = 열기 방식 드롭다운 (Windows Terminal 구성) -->
        <span
          class="session-add codicon codicon-add"
          title="Open Folder as New Session"
          @click="openDefault()"
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
.session-close {
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
.session-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.session-add {
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
.window-control {
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
