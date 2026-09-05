<script setup lang="ts">
import { computed, ref } from 'vue';
import type { EditorGroup, SplitSide } from '../../model/editors';
import { editors, moveTabSplit, moveTabToGroup, openFile, openFileSplit, openHex } from '../../model/editors';
import { editorDrag, endEditorDrag } from './tabDnd';
import TabBar from './TabBar.vue';
import MonacoHost from './MonacoHost.vue';
import ImageView from './ImageView.vue';
import HexView from './HexView.vue';
import HtmlPreview from './HtmlPreview.vue';
import FileIcon from '../widgets/FileIcon.vue';

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

function onBodyDrop(e: DragEvent) {
  e.preventDefault();
  const zone = zoneAt(e);
  if (editorDrag.kind === 'tab') {
    if (zone === 'center') moveTabToGroup(editorDrag.groupId, editorDrag.tabId, props.group.id);
    else moveTabSplit(editorDrag.groupId, editorDrag.tabId, props.group.id, zone);
  } else if (editorDrag.kind === 'file') {
    if (zone === 'center') void openFile(editorDrag.path, { groupId: props.group.id });
    else void openFileSplit(editorDrag.path, props.group.id, zone);
  }
  dropZone.value = 'none';
  endEditorDrag();
}

const active = computed(() => props.group.tabs.find((t) => t.id === props.group.activeTabId) ?? null);
// WHY: VS Code 는 diff 에디터에 breadcrumbs 를 표시하지 않는다
const crumbs = computed(() =>
  active.value && active.value.kind === 'file' ? active.value.path.split('/') : [],
);

// hex·preview 탭 — 문서 상태와 무관하게 편집기 자리에 전용 뷰 (아래 unopenable·image 분기보다 먼저)
const viewer = computed(() => {
  const t = active.value;
  return t && (t.kind === 'hex' || t.kind === 'preview') ? { kind: t.kind, path: t.path } : null;
});

// 활성 탭 문서의 열 수 없음 사유 — 있으면 monaco 대신 안내 화면 (diff 탭도 같은 문서라 동일)
const unopenable = computed(() =>
  active.value && !viewer.value ? editors.docs.get(active.value.path)?.unopenable ?? null : null,
);

// 활성 탭 문서의 이미지 데이터 — 있으면 monaco 대신 이미지 뷰어 (unopenable 과 같은 자리.
// diff 탭도 워킹트리 이미지를 그대로 보여준다 — 이미지 diff 는 범위 밖)
const image = computed(() => {
  const t = viewer.value ? null : active.value;
  const data = t ? editors.docs.get(t.path)?.image : undefined;
  return t && data !== undefined ? { path: t.path, data } : null;
});

/** 안내 문구용 크기 표기 — 상한이 수십 MB 라 MB 고정으로 충분하다 */
function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

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
    <template v-if="group.tabs.length">
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
    </template>
    <div class="editor-body">
      <!-- hex·HTML 프리뷰 탭 — 편집기 자리에 전용 뷰 (path 키라 탭 전환 시 컴포넌트가 갈린다) -->
      <HexView v-if="viewer && viewer.kind === 'hex'" :key="viewer.path" :path="viewer.path" />
      <HtmlPreview v-else-if="viewer" :key="viewer.path" :path="viewer.path" />
      <!-- 이미지 파일 — 편집기 자리에 뷰어. 탭·breadcrumbs 는 그대로 (unopenable 과 동일 배치) -->
      <ImageView v-else-if="image" :path="image.path" :data="image.data" />
      <!-- 열 수 없는 파일(크기 초과·이진) 안내 — 탭·breadcrumbs 는 그대로, 편집기만 대체 -->
      <div v-else-if="unopenable" class="unopenable">
        <p v-if="unopenable.kind === 'large'">
          The file is not displayed in the text editor because it is too large
          ({{ fmtMB(unopenable.size) }}).
        </p>
        <p v-else>
          The file is not displayed in the text editor because it is either binary or
          uses an unsupported text encoding.
        </p>
        <!-- hex 뷰어는 청크 읽기라 크기 상한이 없다 — 두 사유 모두 진입점 -->
        <a class="unopenable-link" @click="active && openHex(active.path)">Open in Hex Editor</a>
      </div>
      <MonacoHost v-if="group.tabs.length" v-show="!unopenable && !image && !viewer" :group="group" />
      <div v-else class="watermark">
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
      <!-- 드래그 중에만 존재 — monaco 가 드래그 이벤트를 삼키지 않게 본문을 덮는다 -->
      <div
        v-if="editorDrag.kind !== 'none'"
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
/* VS Code binary/large 안내 근사 — 중앙 정렬 텍스트 한 줄 */
.unopenable-link {
  display: block;
  margin-top: 8px;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
.unopenable-link:hover {
  text-decoration: underline;
}
.unopenable {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 20px;
  text-align: center;
  color: var(--vscode-editor-foreground);
  font-size: 13px;
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
