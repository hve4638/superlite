<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { EditorGroup, Tab } from '../../model/editors';
import { closeEmptyGroup, closeTab, editors, isHtml, moveTabToGroup, openFile, openFolderTab, pinTab, reloadPreview, toggleGroupLock, toggleHtmlPreview, setActiveTab } from '../../model/editors';
import { createTerminal, requestKillTerminal, terminals } from '../../model/terminal';
import { DND_EDITOR, detachEditorTab, multiWindow, requestTabsMove, sessionRoot, sessions } from '../../model/sessions';
import { windowLabel } from '../../model/window';
import { DETACH_DX, DETACH_DY, insertIndexAt, pointerOutside } from '../dndUtil';
import { editorDrag, endEditorDrag, isForeignDrag, readForeignDrop, startTabDrag } from './tabDnd';
import FileIcon from '../widgets/FileIcon.vue';
import ProgressBar from '../widgets/ProgressBar.vue';
import StripScroll from '../widgets/StripScroll.vue';

const props = defineProps<{ group: EditorGroup }>();

// 활성 탭이 HTML 편집기면 그룹 액션에 프리뷰 전환 아이콘, 프리뷰면 소스 복귀·수동 갱신 아이콘
const activeOf = () => props.group.tabs.find((t) => t.id === props.group.activeTabId);
const htmlActive = computed(() => {
  const t = activeOf();
  return t && t.kind === 'file' && isHtml(t.path) ? t.id : null;
});
const previewActive = computed(() => {
  const t = activeOf();
  return t && t.kind === 'preview' ? t : null;
});

// 탭이 넘치면 활성 탭이 보이도록 스크롤 (ticket tab-strip-overflow) — 렌더 뒤에
const strip = ref<InstanceType<typeof StripScroll> | null>(null);
watch(() => props.group.activeTabId, () => void nextTick(() => strip.value?.reveal('.tab.active')), { immediate: true });

function iconName(tab: Tab): string {
  // diff 탭 이름은 "x (Working Tree)" 라서 아이콘은 실제 파일명으로 찾는다
  return tab.path.slice(tab.path.lastIndexOf('/') + 1);
}

// 같은 이름의 탭이 그룹에 여럿이면 구분용 디렉토리 힌트를 붙인다 (VS Code 동일)
const descriptions = computed(() => {
  const byName = new Map<string, Tab[]>();
  for (const t of props.group.tabs) {
    byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  }
  const out = new Map<string, string>();
  for (const tabs of byName.values()) {
    if (tabs.length < 2) continue;
    for (const t of tabs) out.set(t.id, dirHint(t.path));
  }
  return out;
});

/** 경로의 디렉토리 부분을 짧게 — 루트 상대는 그대로, 절대 경로는 "D:\…\마지막폴더" 로 축약 */
function dirHint(path: string): string {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  if (dir === '') return '';
  const segs = dir.split('/');
  const winAbs = /^[a-zA-Z]:$/.test(segs[0]);
  if (!winAbs && segs[0] !== '') return dir;
  const sep = winAbs ? '\\' : '/';
  if (segs.length <= 2) return segs.join(sep);
  return `${segs[0]}${sep}…${sep}${segs[segs.length - 1]}`;
}

// 터미널 탭 (ticket term-list-reconnect): 닫기·휠 클릭·Ctrl+W 는 detach — tmux 세션은 백그라운드에
// 남는다. Ctrl+닫기·Ctrl+휠 클릭은 강제 종료 (확인 후 tmux 세션 kill). Ctrl 을 누른 동안 닫기 버튼이
// 붉게 바뀌어 둘을 구분한다. tmux 세션이 없는 탭(plain)은 Ctrl 이어도 그냥 닫는다
const ctrlHeld = ref(false);
const onKey = (e: KeyboardEvent) => { ctrlHeld.value = e.ctrlKey; };
const onBlur = () => { ctrlHeld.value = false; };
onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', onBlur);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKey, true);
  window.removeEventListener('blur', onBlur);
});
function killable(tab: Tab): boolean {
  return tab.kind === 'terminal' && terminals.list.some((t) => t.id === tab.term && t.tmux !== undefined);
}
function onClose(tab: Tab, e?: MouseEvent) {
  if (tab.kind === 'terminal' && e?.ctrlKey && killable(tab)) {
    requestKillTerminal(tab.term);
    return;
  }
  closeTab(props.group.id, tab.id);
}

function onDragStart(e: DragEvent, tab: Tab) {
  // setData 는 Firefox 의 드래그 시작 요건 — 실제 식별은 tabDrag 모듈 상태로 한다
  e.dataTransfer?.setData('text/plain', tab.id);
  // 다른 창의 탭바가 출처(창·세션·root)를 알 수 있게 — root 가 같은 세션에만 붙일 수 있다
  if (multiWindow()) {
    e.dataTransfer?.setData(
      DND_EDITOR,
      JSON.stringify({ window: windowLabel, session: sessions.activeId, root: sessionRoot(sessions.activeId), groupId: props.group.id, tabId: tab.id }),
    );
  }
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  startTabDrag(props.group.id, tab.id);
}

// 출처 창의 dragend — 아무 존도 받지 않았고 포인터가 창 밖이면 새 창으로 분리 (세션 탭과 같은 판정)
function onDragEnd(e: DragEvent) {
  if (editorDrag.kind === 'tab' && multiWindow() && e.dataTransfer?.dropEffect === 'none' && pointerOutside(e)) {
    detachEditorTab(editorDrag.groupId, editorDrag.tabId, e.screenX - DETACH_DX, e.screenY - DETACH_DY);
  }
  dropIndex.value = null;
  foreign.value = 'none';
  endEditorDrag();
}

// 탭 드래그의 삽입 지점 (탭 인덱스 기준) — 삽입선 표시와 드롭 위치에 쓴다.
// foreign = 다른 창에서 끌고 온 에디터 탭·탐색기 경로 (dragover 중엔 타입만 읽힌다 — 탭이면 삽입선)
const dropIndex = ref<number | null>(null);
const foreign = ref<'none' | 'tab' | 'file'>('none');
// 삽입선을 보이는 드래그 — 탭 이동과 타이틀바 새 탭 아이콘 (파일·폴더 드롭은 끝에 붙는다)
const tabDragging = computed(() => editorDrag.kind === 'tab' || editorDrag.kind === 'new-folder' || editorDrag.kind === 'new-terminal' || foreign.value === 'tab');

function markForeign(e: DragEvent): void {
  if (isForeignDrag(e)) foreign.value = e.dataTransfer?.types.includes(DND_EDITOR) ? 'tab' : 'file';
}

// 탭 위 드래그 — 좌/우 절반 기준으로 삽입 지점 결정 (VS Code 동일)
function onTabDragOver(e: DragEvent, i: number) {
  markForeign(e);
  if (editorDrag.kind === 'none' && foreign.value === 'none') return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  // 파일 드롭은 끝에 붙인다 — 삽입선 없이 드롭만 받는다
  if (!tabDragging.value) return;
  dropIndex.value = insertIndexAt(e, i);
}

// 탭 밖 빈 영역 — 끝에 삽입. 다른 그룹의 탭, 같은 그룹의 순서 변경, 탐색기 파일, 다른 창의 탭 모두 받는다
function onTabsDragOver(e: DragEvent) {
  markForeign(e);
  if (editorDrag.kind === 'none' && foreign.value === 'none') return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (tabDragging.value) dropIndex.value = props.group.tabs.length;
}

function onTabsDrop(e: DragEvent) {
  if (editorDrag.kind === 'none' && foreign.value === 'none') return;
  e.preventDefault();
  if (foreign.value !== 'none') {
    onForeignDrop(e);
  } else if (editorDrag.kind === 'tab') {
    moveTabToGroup(editorDrag.groupId, editorDrag.tabId, props.group.id, dropIndex.value ?? undefined);
  } else if (editorDrag.kind === 'folder') {
    openFolderTab(editorDrag.path, { groupId: props.group.id });
  } else if (editorDrag.kind === 'new-folder') {
    openFolderTab('', { groupId: props.group.id, index: dropIndex.value ?? undefined });
  } else if (editorDrag.kind === 'new-terminal') {
    createTerminal({ groupId: props.group.id, index: dropIndex.value ?? undefined });
  } else {
    void openFile(editorDrag.path, { groupId: props.group.id });
  }
  dropIndex.value = null;
  foreign.value = 'none';
  endEditorDrag();
}

// 자식 요소 사이 이동은 leave 가 아니다 — 삽입선·foreign 이 깜빡이지 않게
function onTabsDragLeave(e: DragEvent) {
  if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) return;
  dropIndex.value = null;
  foreign.value = 'none';
}

// 다른 창의 에디터 탭 병합·탐색기 경로 열기 — 같은 root 의 세션에만 (readForeignDrop 이 검사). 탭 상태는
// 출처 창에 있으니 이동을 요청한다 (출처가 탭을 떼어 핸드오프를 보내온다), 경로는 여기서 연다
function onForeignDrop(e: DragEvent) {
  const d = readForeignDrop(e);
  if (!d) return;
  if (d.kind === 'tab') {
    requestTabsMove(d.window, { fromSession: d.session, editorTab: { groupId: d.groupId, tabId: d.tabId } }, {
      toGroupId: props.group.id,
      toIndex: dropIndex.value ?? undefined,
    });
  } else if (d.kind === 'folder') {
    openFolderTab(d.path, { groupId: props.group.id });
  } else {
    void openFile(d.path, { groupId: props.group.id });
  }
}
</script>

<template>
  <div class="tabbar">
    <!-- 탭 목록만 스크롤 영역 — 그룹 액션은 밖에 고정. 빈 영역 드롭(끝에 삽입)은 스트립 루트가 받는다 -->
    <StripScroll ref="strip" class="tabs" @dragover="onTabsDragOver" @dragleave="onTabsDragLeave($event)" @drop="onTabsDrop">
      <div
        v-for="(tab, i) in group.tabs"
        :key="tab.id"
        class="tab"
        :class="{
          active: tab.id === group.activeTabId,
          dirty: tab.dirty,
          preview: tab.preview,
          orphaned: editors.orphaned.has(tab.path),
          'drop-before': tabDragging && dropIndex === i,
          'drop-after': tabDragging && dropIndex === i + 1 && i === group.tabs.length - 1,
        }"
        :title="tab.kind === 'terminal' ? tab.name : tab.path"
        draggable="true"
        @dragstart="onDragStart($event, tab)"
        @dragend="onDragEnd($event)"
        @dragover="onTabDragOver($event, i)"
        @click="setActiveTab(group.id, tab.id)"
        @dblclick="pinTab(group.id, tab.id)"
        @mousedown.middle.prevent="onClose(tab, $event)"
      >
        <!-- 워크스페이스 복원으로 문서를 읽는 중 — 탭 아래쪽 진행선 (탐색기 로딩과 같은 위젯) -->
        <ProgressBar v-if="editors.loadingTabs.has(tab.id)" class="tab-progress" />
        <span v-if="tab.kind === 'terminal'" class="codicon codicon-terminal tab-icon" />
        <span v-else-if="tab.kind === 'folder'" class="codicon codicon-folder tab-icon" />
        <FileIcon v-else :name="iconName(tab)" />
        <span class="tab-label">{{ tab.name }}</span>
        <span v-if="descriptions.get(tab.id)" class="tab-description">{{ descriptions.get(tab.id) }}</span>
        <span class="tab-actions">
          <span
            class="tab-action"
            :class="{ kill: ctrlHeld && killable(tab) }"
            :title="killable(tab) ? (ctrlHeld ? 'Kill Terminal' : 'Close (Ctrl+click: Kill Terminal)') : undefined"
            @click.stop="onClose(tab, $event)"
          >
            <span class="codicon codicon-close" />
            <span v-if="tab.dirty" class="codicon codicon-circle-filled" />
          </span>
        </span>
      </div>
    </StripScroll>
    <div class="group-actions">
      <span v-if="htmlActive" class="group-action" title="Open Preview (Ctrl+Shift+V)" @click="toggleHtmlPreview(group.id, htmlActive)">
        <span class="codicon codicon-open-preview" />
      </span>
      <template v-if="previewActive">
        <span class="group-action" title="Reload Preview" @click="reloadPreview(previewActive.path)">
          <span class="codicon codicon-refresh" />
        </span>
        <span class="group-action" title="Show Source (Ctrl+Shift+V)" @click="toggleHtmlPreview(group.id, previewActive.id)">
          <span class="codicon codicon-code" />
        </span>
      </template>
      <!-- 그룹 잠금 (editor-group-empty-lock): 잠기면 채워진 자물쇠가 항상, 아니면 hover 시에만 열린 자물쇠. 빈 그룹은 잠글 수 없다 -->
      <span
        v-if="group.tabs.length"
        class="group-action lock"
        :class="{ locked: group.locked }"
        :title="group.locked ? 'Unlock Group' : 'Lock Group (keeps layout when a neighbor empties)'"
        @click="toggleGroupLock(group.id)"
      >
        <span class="codicon" :class="group.locked ? 'codicon-lock' : 'codicon-unlock'" />
      </span>
      <!-- 빈 그룹 닫기 — 잠금과 무관한 직접 닫기. 하나뿐인 그룹은 닫을 수 없다 -->
      <span v-if="!group.tabs.length && editors.groups.length > 1" class="group-action" title="Close Group" @click="closeEmptyGroup(group.id)">
        <span class="codicon codicon-close" />
      </span>
      <!-- 새 터미널·폴더 탭 버튼은 타이틀바 오른쪽 (전역 동작 — 탭이 없는 그룹에서도 보여야 한다). 분할은 팔레트 View: Split Editor -->
    </div>
  </div>
</template>

<style scoped>
.tabbar {
  position: relative;
  display: flex;
  height: 35px;
  flex-shrink: 0;
  background: var(--vscode-editorGroupHeader-tabsBackground);
}
/* WHY: VS Code 는 탭바 하단 1px 라인을 overlay(z9)로 깔고 active 탭이 z10 으로 덮는다 */
.tabbar::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 1px;
  background: var(--vscode-editorGroupHeader-tabsBorder);
  z-index: 9;
  pointer-events: none;
}
.tabs {
  flex: 1;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  height: 35px;
  padding-left: 10px;
  flex-shrink: 0;
  border-right: 1px solid var(--vscode-tab-border);
  background: var(--vscode-tab-inactiveBackground);
  color: var(--vscode-tab-inactiveForeground);
  cursor: pointer;
}
.tab :deep(.tab-progress) {
  top: auto;
  bottom: 0;
}
.tab.active {
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-tab-activeForeground);
}
.tab.active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--vscode-tab-activeBorderTop);
  z-index: 6;
}
.tab.active::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--vscode-tab-activeBorder);
  z-index: 10;
}
.tab-icon {
  font-size: 16px;
  margin-right: 6px;
  flex-shrink: 0;
}
.tab-label {
  font-size: 13px;
  line-height: 35px;
  /* WHY: VS Code monaco-icon-label 은 아이콘 16px + padding-right 6px */
  margin-left: 6px;
  white-space: nowrap;
}
.tab.preview .tab-label {
  font-style: italic;
}
/* 이름 중복 구분 힌트 — VS Code label-description 상당 (작고 흐리게) */
.tab-description {
  margin-left: 6px;
  font-size: 11px;
  line-height: 35px;
  white-space: nowrap;
  opacity: 0.7;
}
/* 외부 삭제된 파일 — 라벨 취소선 (VS Code monaco-icon-label.strikethrough 동일) */
.tab.orphaned .tab-label {
  text-decoration: line-through;
}
.tab-actions {
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tab-action {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
}
.tab-action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.tab-action .codicon {
  font-size: 16px;
}
/* 탭 드래그 삽입선 — box-shadow 라 레이아웃이 밀리지 않는다 */
.tab.drop-before {
  box-shadow: inset 2px 0 0 var(--vscode-focusBorder);
}
.tab.drop-after {
  box-shadow: inset -2px 0 0 var(--vscode-focusBorder);
}
/* 닫기 버튼: active 탭은 항상, inactive 탭은 hover 시에만 */
.tab:not(.dirty):not(.active):not(:hover) .codicon-close {
  visibility: hidden;
}
/* Ctrl 을 누른 동안 터미널 탭의 닫기 = 강제 종료 — 붉게 */
.tab-action.kill .codicon-close {
  color: var(--vscode-errorForeground);
}
/* dirty 탭: ● 표시, 버튼에 hover 하면 × 로 교체 */
.codicon-circle-filled {
  display: none;
}
.tab.dirty .codicon-close {
  display: none;
}
.tab.dirty .codicon-circle-filled {
  display: block;
}
.tab.dirty .tab-action:hover .codicon-close {
  display: block;
}
.tab.dirty .tab-action:hover .codicon-circle-filled {
  display: none;
}
.group-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 8px;
  gap: 4px;
}
.group-action {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  cursor: pointer;
  color: var(--vscode-foreground);
}
.group-action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
/* 잠금 아이콘: 안 잠긴 그룹은 탭바 hover 중에만 보인다 */
.lock:not(.locked) {
  visibility: hidden;
}
.tabbar:hover .lock {
  visibility: visible;
}
</style>
