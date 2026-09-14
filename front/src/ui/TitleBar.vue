<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { openQuickInput, openContextMenu } from '../model/workbench';
import { openFolderTab } from '../model/editors';
import { createTerminal } from '../model/terminal';
import { endEditorDrag, startNewTabDrag } from './editor/tabDnd';
import { DETACH_DX, DETACH_DY, insertIndexAt } from './dndUtil';
import StripScroll from './widgets/StripScroll.vue';
import TerminalBadge from './editor/TerminalBadge.vue';
import type { DotSpec } from '../model/agent';
import {
  inApp,
  appWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  windowLabel,
  subWindow,
} from '../model/window';
import {
  sessions,
  sessionCtxOf,
  sessionsEnabled,
  activeSessionEmpty,
  activateSession,
  closeSession,
  addEmptySession,
  moveSession,
  renameSession,
  isRemoteEmpty,
  withHost,
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

// 같은 이름(루트 basename)의 세션이 한 창에 여럿이면, rename 된 적 없는 탭들의 라벨을 전체 경로로
// 바꿔 구분한다 (2026-09-07 사용자 결정). 세그먼트가 많으면 가운데를 줄인다 (/a/.../c/d). 중복이
// 풀리면 basename 으로 돌아온다 — 라벨은 저장값이 아니라 계산값. rename 된 탭은 중복이어도 그대로
/** 세션 탭의 상태 점 — 그 세션 컨텍스트의 터미널 요약 (빈 세션·미로드는 null) */
function sessionDot(id: string): DotSpec | null {
  return sessionCtxOf(id)?.terminals.agent.dotOfSession() ?? null;
}

const labels = computed(() => {
  const byName = new Map<string, SessionTab[]>();
  for (const t of sessions.list) byName.set(sessionLabel(t), [...(byName.get(sessionLabel(t)) ?? []), t]);
  const out = new Map<string, string>();
  for (const tabs of byName.values()) {
    if (tabs.length < 2) continue;
    // 빈 세션(root null)은 경로가 없다 — 같은 라벨의 빈 탭 여럿은 구분 없이 수용
    for (const t of tabs) if (t.root !== null && !t.renamed) out.set(t.id, withHost(abbrevRoot(t.root), t.root));
  }
  return out;
});

/** 전체 경로 라벨용 축약 — 세그먼트 4개 초과면 앞 1개·뒤 2개만 (/a/.../c/d). root 는 native 경로라
 *  구분자가 OS 마다 다르고, 원격은 ssh://host 접두를 뗀 경로 */
const ABBREV_MAX_SEGS = 4;
function abbrevRoot(root: string): string {
  const path = root.replace(/^ssh:\/\/[^/]+/, '');
  const sep = path.includes('\\') ? '\\' : '/';
  const segs = path.split(sep).filter((s) => s !== '');
  const lead = path.startsWith(sep) ? sep : '';
  if (segs.length <= ABBREV_MAX_SEGS) return lead + segs.join(sep);
  return lead + [segs[0], '...', segs[segs.length - 2], segs[segs.length - 1]].join(sep);
}

/** 탭 라벨 — 이름은 워크스페이스 정보가 오면 채워진다: 그 전엔 빈 세션만 Welcome, 로드 중인
 *  세션은 공백. 원격 빈 세션(경로 없는 ssh://host)은 이름과 무관하게 "Welcome [host]" */
function sessionLabel(tab: SessionTab): string {
  if (isRemoteEmpty(tab.root)) return withHost('Welcome', tab.root ?? '');
  return tab.name || (tab.root === null ? 'Welcome' : '…');
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
const dragging = computed(() => dragId.value !== null || foreign.value);

// 서브 창의 스트립은 메인 것을 비추는 전환 전용 — 세션을 받지도(드롭) 내보내지도(드래그) 않는다
function isForeign(e: DragEvent): boolean {
  return dragId.value === null && multiWindow() && !subWindow && (e.dataTransfer?.types.includes(DND_SESSION) ?? false);
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
  dropIndex.value = insertIndexAt(e, i);
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

// 스트립이 넘치면 활성 탭이 보이도록 스크롤 (ticket tab-strip-overflow) — 렌더 뒤에
const strip = ref<InstanceType<typeof StripScroll> | null>(null);
watch(() => sessions.activeId, () => void nextTick(() => strip.value?.reveal('.session-tab.active')), { immediate: true });

/** 타이틀바 루트 — 세션 탭 분리 판정의 기준 영역 */
const titlebarEl = ref<HTMLElement | null>(null);

// 출처 창의 dragend — 아무 드롭 존도 받지 않았고(dropEffect none) 포인터가 타이틀바(헤더) 밖이면
// 새 창으로 분리 (ticket session-tab-detach-header: 창 밖까지 갈 필요 없이 에디터 영역 위에
// 놓아도 분리 — 창 밖은 헤더 밖에 포함된다). 다른 창의 스트립이 받았으면 dropEffect 가
// move 라 여기 오지 않고 그쪽이 이동을 요청해 온다.
// WHY: HTML5 DnD 는 "밖에 놓았다"는 이벤트가 없다 — dragend 좌표로 판정한다. Esc 취소도
//      dragend 좌표가 마지막 포인터 위치라 헤더 밖이면 분리된다 (드래그 중 키 이벤트는 페이지에
//      오지 않아 구분 불가) — 헤더 안으로 되돌려 놓으면 취소.
function pointerOutsideHeader(e: DragEvent): boolean {
  const r = titlebarEl.value?.getBoundingClientRect();
  if (!r) return false;
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

function onTabDragEnd(e: DragEvent): void {
  const id = dragId.value;
  if (id !== null && multiWindow() && e.dataTransfer?.dropEffect === 'none' && pointerOutsideHeader(e)) {
    detachSession(id, e.screenX - DETACH_DX, e.screenY - DETACH_DY);
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
  if (!multiWindow() || subWindow) return; // 웹은 브라우저 기본 메뉴 그대로, 서브 창은 이동 없음
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

/** 타이틀바 새 탭 아이콘 드래그 — setData 는 Firefox 의 드래그 시작 요건, 식별은 tabDnd 모듈 상태 */
function onNewTabDragStart(e: DragEvent, kind: 'new-folder' | 'new-terminal'): void {
  e.dataTransfer?.setData('text/plain', kind);
  // 드롭 존이 dropEffect 를 move 로 세우므로 허용 효과도 move — 어긋나면 브라우저가 drop 을 내지 않는다
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  startNewTabDrag(kind);
}
</script>

<template>
  <!-- data-tauri-drag-region 은 이벤트 target 에만 적용된다 — 드래그할 빈 영역마다 직접 붙인다 -->
  <div ref="titlebarEl" class="titlebar" data-tauri-drag-region>
    <!-- 좌측정렬 워크스페이스 세션 탭 (decision/workspace-session-tabs.md, Windows Terminal 참조)
         — 탭 밖 여백은 드래그 영역. 웹에서도 그린다 (mock 만 제외) -->
    <div class="titlebar-tabs" data-tauri-drag-region>
      <!-- 앱 아이콘 — 기능 없는 장식, 창 끌기 영역 (서브 창도 같은 자리). favicon 에서 파란 배경만 뺀
           변형(잔상·정사면체) — 타이틀바 위에 배경 사각형이 있으면 버튼처럼 보인다 (2026-09-08 사용자 선택) -->
      <img class="app-icon" src="/strip-icon.svg" alt="" draggable="false" data-tauri-drag-region />
      <div
        v-if="sessionsEnabled() && sessions.list.length"
        class="session-tabs"
        @dragover="onStripDragOver"
        @dragleave="onStripDragLeave($event)"
        @drop="onStripDrop"
      >
        <!-- 탭 목록만 스크롤 영역 — +·v 는 밖에 고정 (넘쳐도 항상 보인다) -->
        <StripScroll ref="strip" class="session-strip">
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
            :draggable="renamingId !== tab.id && !subWindow"
            @dragstart="onTabDragStart($event, tab)"
            @dragend="onTabDragEnd($event)"
            @dragover="onTabDragOver($event, i)"
            @click="activateSession(tab.id)"
            @contextmenu="onTabContextMenu($event, tab)"
            @dblclick="subWindow || startRename(tab)"
            @mousedown.middle.prevent="subWindow || closeSession(tab.id)"
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
              <!-- 이름은 워크스페이스 정보가 오면 채워진다 — 그 전엔 빈 세션(시작 페이지 탭)만 Welcome, 로드 중인 세션은 공백 -->
              <span class="session-name">{{ labels.get(tab.id) ?? sessionLabel(tab) }}</span>
              <!-- 세션의 터미널 상태 요약 점 (ticket agent-hooks-status) — 노랑/초록 반반, 닫기 요청만 있으면 빨강 -->
              <TerminalBadge :dot="sessionDot(tab.id)" />
            </template>
            <!-- 로딩 스피너 — 초기 로드(ctx.init) 중, X 바로 왼쪽. 예비 파이프 접속은 상태바 단계가
                 안 보이므로 로드 완료의 유일한 시각 신호다 -->
            <span v-if="loading.has(tab.id)" class="session-loading codicon codicon-loading codicon-modifier-spin" />
            <!-- 서브 창은 전환만 — 닫기·+·이름·이동은 메인 창에서 (2026-09-08 사용자 결정) -->
            <span
              v-if="!subWindow"
              class="session-close codicon codicon-close"
              @click.stop="closeSession(tab.id)"
            />
          </div>
        </StripScroll>
        <!-- 탭 끝의 + = 빈 세션 탭 (시작 페이지에서 폴더 열기로 잇는다),
             옆의 v = 열기 방식 드롭다운 (Windows Terminal 구성) -->
        <span
          v-if="!subWindow"
          class="session-add codicon codicon-add"
          title="New Session"
          @click="addEmptySession()"
        />
        <span
          v-if="!subWindow"
          class="session-add session-add-menu codicon codicon-chevron-down"
          title="Open Options"
          @click="openAddMenu($event)"
        />
      </div>
    </div>
    <div class="titlebar-right" data-tauri-drag-region>
      <!-- 활성 그룹에 새 폴더 탭(워크스페이스 루트)·새 터미널 — 전역 동작이라 탭바가 아니라 여기
           (탭이 없는 그룹에서도 보인다). 빈 세션은 백엔드가 없어 숨긴다 -->
      <template v-if="!activeSessionEmpty()">
        <!-- 끌어서 놓는 자리(탭 사이·그룹·가장자리 분할)에 만들 수도 있다 — 드롭은 탭바·그룹 본문 드롭 존 -->
        <span
          class="codicon codicon-folder global-action"
          title="Open Folder Tab"
          draggable="true"
          @click="openFolderTab('')"
          @dragstart="onNewTabDragStart($event, 'new-folder')"
          @dragend="endEditorDrag()"
        />
        <span
          class="codicon codicon-terminal global-action"
          title="New Terminal (Ctrl+Shift+`)"
          draggable="true"
          @click="createTerminal()"
          @dragstart="onNewTabDragStart($event, 'new-terminal')"
          @dragend="endEditorDrag()"
        />
      </template>
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
.app-icon {
  width: 18px;
  height: 18px;
  margin: 0 8px 0 10px;
  flex-shrink: 0;
  -webkit-user-drag: none;
  user-select: none;
}
.session-tabs {
  display: flex;
  align-items: stretch;
  height: 100%;
  min-width: 0;
  max-width: 100%;
}
/* 탭 목록 스크롤 영역 — 공간이 남으면 내용 폭, 모자라면 줄어들며 스크롤. 페이드는 타이틀바 배경색 */
.session-strip {
  flex: 0 1 auto;
  --strip-bg: var(--vscode-titleBar-activeBackground);
}
/* C 시안 (VS Code 에디터 탭 문법) 실험 적용 — 전체 높이 사각 탭, 활성 = 에디터
   배경 + 상단 2px 액센트 라인, 탭 경계는 1px border */
.session-tab {
  position: relative;
  flex-shrink: 0;
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
/* 탭 드래그 삽입선 — 탭 경계선 위(left/right -1px)의 세로 직선. inset box-shadow 는
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
.global-action {
  font-size: 16px;
  padding: 4px;
  border-radius: 5px;
  cursor: pointer;
}
.global-action:hover {
  background: var(--vscode-toolbar-hoverBackground);
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
