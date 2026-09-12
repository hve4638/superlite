<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EditorGroup, SplitSide } from '../../model/editors';
import { addGroupBeside, editors, moveTabSplit, moveTabToGroup, openFile, openFileSplit, openFolderTab, openFolderTabSplit } from '../../model/editors';
import { createTerminal } from '../../model/terminal';
import { requestTabsMove } from '../../model/sessions';
import { editorDrag, endEditorDrag, foreignDrag, isForeignDrag, readForeignDrop } from './tabDnd';
import TabBar from './TabBar.vue';
import TabBody from './TabBody.vue';
import CardList from './CardList.vue';
import FileIcon from '../widgets/FileIcon.vue';
import ProgressBar from '../widgets/ProgressBar.vue';

const props = defineProps<{ group: EditorGroup }>();

// 탭 드래그 중 에디터 본문 드롭 존 — 중앙: 이 그룹으로 이동, 가장자리: 그 방향 새 그룹으로 분리
const dropZone = ref<'none' | 'center' | SplitSide>('none');

function zoneAt(e: DragEvent): 'center' | SplitSide {
  // 빈 그룹은 분할할 이유가 없다 — 전체가 이동/열기 존
  if (!props.group.tabs.length) return 'center';
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const dx = (e.clientX - rect.left) / rect.width;
  const dy = (e.clientY - rect.top) / rect.height;
  // 중앙 절반 박스는 이동, 밖은 가장 가까운 변으로 분할 (VS Code 존 배치 근사)
  if (dx > 0.25 && dx < 0.75 && dy > 0.25 && dy < 0.75) return 'center';
  const near = Math.min(dx, 1 - dx, dy, 1 - dy);
  return near === dx ? 'left' : near === 1 - dx ? 'right' : near === dy ? 'up' : 'down';
}

function onBodyDragOver(e: DragEvent) {
  const zone = zoneAt(e);
  // 자기 그룹 탭을 자기 가운데 드롭은 no-op — 드롭 대상으로 받지도, 하이라이트하지도 않는다
  if (zone === 'center' && editorDrag.kind === 'tab' && editorDrag.groupId === props.group.id) {
    dropZone.value = 'none';
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dropZone.value = zone;
}

// 다른 창에서 온 드롭 — 탭은 출처에 이동 요청(가장자리는 toSplit 으로 받는 쪽이 새 그룹을 만든다),
// 경로는 한 창 안의 탐색기 드롭과 같은 경로로 연다 (ticket cross-window-editor-drop)
function onForeignBodyDrop(e: DragEvent, zone: 'center' | SplitSide) {
  const d = readForeignDrop(e);
  if (!d) return;
  if (d.kind === 'tab') {
    requestTabsMove(d.window, { fromSession: d.session, editorTab: { groupId: d.groupId, tabId: d.tabId } }, {
      toGroupId: props.group.id,
      toSplit: zone === 'center' ? undefined : zone,
    });
  } else if (d.kind === 'folder') {
    if (zone === 'center') openFolderTab(d.path, { groupId: props.group.id });
    else openFolderTabSplit(d.path, props.group.id, zone);
  } else {
    if (zone === 'center') void openFile(d.path, { groupId: props.group.id });
    else void openFileSplit(d.path, props.group.id, zone);
  }
}

function onBodyDrop(e: DragEvent) {
  e.preventDefault();
  const zone = zoneAt(e);
  if (editorDrag.kind === 'none') {
    // 이 창의 드래그가 아니다 — 다른 창의 탭·탐색기 경로면 받고, 그 밖(OS 파일 등)은 종전처럼 삼킨다
    if (isForeignDrag(e)) onForeignBodyDrop(e, zone);
  } else if (editorDrag.kind === 'tab') {
    if (zone === 'center') moveTabToGroup(editorDrag.groupId, editorDrag.tabId, props.group.id);
    else moveTabSplit(editorDrag.groupId, editorDrag.tabId, props.group.id, zone);
  } else if (editorDrag.kind === 'file') {
    if (zone === 'center') void openFile(editorDrag.path, { groupId: props.group.id });
    else void openFileSplit(editorDrag.path, props.group.id, zone);
  } else if (editorDrag.kind === 'folder') {
    if (zone === 'center') openFolderTab(editorDrag.path, { groupId: props.group.id });
    else openFolderTabSplit(editorDrag.path, props.group.id, zone);
  } else if (editorDrag.kind === 'new-folder') {
    openFolderTab('', { groupId: zone === 'center' ? props.group.id : addGroupBeside(props.group.id, zone) ?? undefined });
  } else if (editorDrag.kind === 'new-terminal') {
    createTerminal({ groupId: zone === 'center' ? props.group.id : addGroupBeside(props.group.id, zone) ?? undefined });
  }
  dropZone.value = 'none';
  endEditorDrag();
}

const active = computed(() => props.group.tabs.find((t) => t.id === props.group.activeTabId) ?? null);
// WHY: VS Code 는 diff 에디터에 breadcrumbs 를 표시하지 않는다
const crumbs = computed(() =>
  active.value && active.value.kind === 'file' ? active.value.path.split('/') : [],
);
// 카드 (ticket terminal-tab-panes): 활성 탭에 카드가 있으면 오른쪽에 CardList, 활성 카드가 있으면 본문은 카드 목록의
// TabBody 로 바뀐다. 탭 자신의 TabBody 는 v-show 로 남긴다 — 카드로 갔다 와도 monaco 가 리마운트되지 않는다
const withCards = computed(() => (active.value?.cards ? (active.value as typeof active.value & { cards: NonNullable<typeof active.value.cards> }) : null));
const cardActive = computed(() => withCards.value !== null && withCards.value.cards.activeTabId !== null);
const groupActive = computed(() => editors.activeGroupId === props.group.id);

function focusGroup() {
  editors.activeGroupId = props.group.id;
}

const SHORTCUTS = [
  { label: 'Show All Commands', keys: ['Ctrl', 'Shift', 'P'] },
  { label: 'Go to File', keys: ['Ctrl', 'P'] },
  { label: 'Toggle Terminal', keys: ['Ctrl', '`'] },
];
</script>

<template>
  <div class="editor-group" @mousedown="focusGroup">
    <!-- 빈 그룹도 탭바를 그린다 — 자물쇠·닫기 × 자리 (editor-group-empty-lock) -->
    <TabBar :group="group" />
    <div v-if="crumbs.length" class="breadcrumbs">
      <template v-for="(seg, i) in crumbs" :key="i">
        <span v-if="i > 0" class="codicon codicon-chevron-right sep" />
        <span class="crumb">
          <FileIcon v-if="i === crumbs.length - 1" :name="seg" />
          <span class="crumb-label">{{ seg }}</span>
        </span>
      </template>
    </div>
    <div class="editor-body">
      <!-- 활성 탭의 로드가 800ms 를 넘김 — 제목 영역(탭바·breadcrumbs) 아래 2px 진행선 (VS Code editor progress) -->
      <ProgressBar v-if="active && editors.slowTabs.has(active.id)" />
      <div class="body-row">
        <TabBody v-show="!cardActive" :holder="group" :group-id="group.id" :active="groupActive && !cardActive" @focus="focusGroup" />
        <TabBody v-if="withCards && cardActive" :key="withCards.id" :holder="withCards.cards" :group-id="group.id" :active="groupActive" @focus="focusGroup" />
        <CardList v-if="withCards" :tab="withCards" :group-id="group.id" />
      </div>
      <div v-if="!group.tabs.length" class="watermark">
        <div class="watermark-grid">
          <template v-for="s in SHORTCUTS" :key="s.label">
            <span class="watermark-label">{{ s.label }}</span>
            <span class="watermark-keys">
              <template v-for="(k, i) in s.keys" :key="i">
                <span v-if="i > 0" class="key-sep">+</span>
                <span class="key">{{ k }}</span>
              </template>
            </span>
          </template>
        </div>
      </div>
      <!-- 드래그 중에만 존재 — monaco 가 드래그 이벤트를 삼키지 않게 본문을 덮는다 (다른 창의 드래그도) -->
      <div
        v-if="editorDrag.kind !== 'none' || foreignDrag.active"
        class="drop-layer"
        :class="dropZone"
        @dragover="onBodyDragOver"
        @dragleave="dropZone = 'none'"
        @drop="onBodyDrop"
      />
    </div>
  </div>
</template>

<style scoped>
.editor-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  background: var(--vscode-editor-background);
}
.breadcrumbs {
  display: flex;
  align-items: center;
  height: 22px;
  flex-shrink: 0;
  /* WHY: VS Code 는 첫 항목 앞에 공백문자(' ')를 렌더한다 — 4px 로 근사 */
  padding-left: 4px;
  background: var(--vscode-breadcrumb-background);
  color: var(--vscode-breadcrumb-foreground);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
}
.crumb {
  display: flex;
  align-items: center;
  height: 22px;
  cursor: pointer;
}
.crumb:hover .crumb-label {
  color: var(--vscode-breadcrumb-focusForeground);
}
.crumb .file-icon {
  margin-right: 6px;
}
.breadcrumbs .sep {
  font-size: 16px;
  flex-shrink: 0;
  margin: 0 4px;
}
.editor-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.body-row {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}
.drop-layer {
  position: absolute;
  inset: 0;
  z-index: 20;
}
.drop-layer::before {
  content: '';
  position: absolute;
  inset: 0;
  display: none;
  background: var(--vscode-editorGroup-dropBackground);
  pointer-events: none;
}
.drop-layer.center::before {
  display: block;
}
.drop-layer.right::before {
  display: block;
  left: 50%;
}
.drop-layer.left::before {
  display: block;
  right: 50%;
}
.drop-layer.up::before {
  display: block;
  bottom: 50%;
}
.drop-layer.down::before {
  display: block;
  top: 50%;
}
.watermark {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* VS Code watermark: 라벨 오른쪽 정렬 / 키 왼쪽 정렬 2열 */
.watermark-grid {
  display: grid;
  grid-template-columns: auto auto;
  column-gap: 24px;
  row-gap: 8px;
  align-items: center;
}
.watermark-label {
  text-align: right;
  color: var(--vscode-descriptionForeground);
  letter-spacing: 0.04em;
  font-size: 13px;
}
.watermark-keys {
  display: flex;
  align-items: center;
}
.key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 12px;
  padding: 3px 5px;
  margin: 0 2px;
  font-size: 11px;
  line-height: 10px;
  border-radius: 3px;
  color: var(--vscode-keybindingLabel-foreground);
  background: var(--vscode-keybindingLabel-background);
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
  box-shadow: inset 0 -1px 0 var(--vscode-keybindingLabel-border);
}
.key:first-child {
  margin-left: 0;
}
.key-sep {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
</style>
