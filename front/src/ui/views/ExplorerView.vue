<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { addExtraRoot, files, mainTree, moveExtraRoot, removeExtraRoot, toAbsPath } from '../../model/files';
import { retryActiveConnection } from '../../model/host';
import { activeSessionEmpty } from '../../model/sessions';
import { cancelDownload, clearDownload, confirmAllDownloads, confirmDownload, orderedDownloads, pendingDownloads, showAllDownloads, type DownloadState } from '../../model/downloads';
import Sash from '../widgets/Sash.vue';
import { connection, failureLabel, stageLabel } from '../../model/watch';
import { openQuickInput, workbench } from '../../model/workbench';
import { editorDrag } from '../editor/tabDnd';
import ProgressBar from '../widgets/ProgressBar.vue';
import FileTree from './FileTree.vue';
import ExtraRootTree from './ExtraRootTree.vue';

// 탐색기 사이드바 — 위에서부터 메인 워크스페이스 트리, 추가 탐색기 섹션들, Download 뷰. 트리 자체(행·선택·
// 파일 조작·드롭)는 FileTree 가 맡고 여기서는 배치와 섹션 목록만 다룬다. 메인은 위, Download 는 아래 고정이고
// 그 사이 섹션들만 헤더 드래그로 순서를 바꾼다 (ticket explorer-extra-roots, 사용자 결정 2026-09-14)

/** 빈 세션의 'Open Folder' — 경로 입력 퀵인풋 (시작 페이지와 동일) */
function openDefault(): void {
  openQuickInput('folder');
}

// Download 뷰 — 요청이 들어오면 자동으로 펼친다 (사용자가 접어 둔 뒤 새 요청이 와도 다시 펼침)
const downloadsOpen = ref(false);
watch(pendingDownloads, (n, prev) => {
  if (n > prev) downloadsOpen.value = true;
});
// 높이 — 위 경계 sash. 최소 = 헤더 22 + 행 2개(최근 1개 + 전체 기록 버튼). 보이는 항목 수는 행 높이로 잘라
// 스크롤 대신 "전체 다운로드 기록" 버튼(항상 표시)이 나머지를 맡는다
const DL_ROW = 22;
const DL_MIN = DL_ROW * 3;
const dlHeight = ref(DL_ROW * 5);
let dlStart = 0;
function resizeDl(dy: number): void {
  dlHeight.value = Math.max(DL_MIN, dlStart - dy); // 위쪽 경계를 끄므로 위로(dy<0) 갈수록 커진다
}
const dlVisible = computed(() => Math.max(1, Math.floor((dlHeight.value - DL_ROW * 2) / DL_ROW)));
const DL_LABEL: Record<DownloadState, string> = {
  pending: '대기',
  running: '받는 중',
  done: '완료',
  cancelled: '취소됨',
  failed: '실패',
};

// ---- 추가 탐색기 섹션 (ticket explorer-extra-roots) — 폴더 행(탐색기·섹션·폴더 탭)을 끄는 동안만 트리 하단에
// 겹치는 드롭 띠가 살아 있고, 포인터가 실제로 들어왔을 때만 문구 없이 영역 표시를 한다 (사용자 요청 2026-09-13).
// 놓으면 그 폴더를 루트로 하는 섹션이 Download 뷰 위에 쌓인다. 워크스페이스 밖 폴더는 addExtraRoot 가 조용히
// 무시한다 (사용자 결정 2026-09-14). 창 간(DND_FILE) 드래그는 받지 않는다 (ponytail)
const extraDropActive = ref(false);
const folderDrag = computed(() => editorDrag.kind === 'folder' && editorDrag.path !== '');
function onExtraDrop(e: DragEvent): void {
  e.preventDefault();
  extraDropActive.value = false;
  if (!folderDrag.value) return;
  void addExtraRoot(toAbsPath(editorDrag.path, workbench.rootPath), workbench.rootPath);
}

// ---- 섹션 순서 바꾸기 — 헤더를 끌면 놓일 자리를 섹션 사이 삽입선으로 보인다 (사용자 요청 2026-09-14).
// 자리는 포인터가 어느 섹션의 위/아래 절반에 있는지로 정한다 (VS Code 트리 삽입선과 같은 규칙).
// insertAt === 섹션 수 면 맨 아래 = 마지막 섹션 아래 선 = Download 바로 위
const reorderAbs = ref<string | null>(null);
const insertAt = ref<number | null>(null);

function onSectionsDragOver(e: DragEvent): void {
  if (reorderAbs.value === null) return; // 파일 드래그는 트리·드롭 존 몫
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const panes = [...(e.currentTarget as HTMLElement).children];
  let at = panes.length;
  for (let i = 0; i < panes.length; i++) {
    const r = panes[i].getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) {
      at = i;
      break;
    }
  }
  insertAt.value = at;
}

function onSectionsDrop(e: DragEvent): void {
  if (reorderAbs.value === null || insertAt.value === null) return;
  e.preventDefault();
  e.stopPropagation();
  moveExtraRoot(reorderAbs.value, insertAt.value);
  endReorder();
}

function endReorder(): void {
  reorderAbs.value = null;
  insertAt.value = null;
}

/** 이 섹션에 그릴 삽입선 — 자기 위 경계, 또는 마지막 섹션이면 아래 경계 */
function lineFor(i: number, count: number): 'top' | 'bottom' | null {
  if (insertAt.value === null) return null;
  if (insertAt.value === i) return 'top';
  return insertAt.value === count && i === count - 1 ? 'bottom' : null;
}

/** 사이드바 제목의 새 파일·새 폴더 액션 — 메인 트리의 인라인 입력을 연다 (SideBar 가 이 expose 를 부른다) */
const mainTreeRef = ref<{ newFile: () => void; newFolder: () => void } | null>(null);
defineExpose({
  newFile: () => mainTreeRef.value?.newFile(),
  newFolder: () => mainTreeRef.value?.newFolder(),
});
</script>

<template>
  <div class="explorer-view">
    <!-- 빈 세션(루트 없음) — 트리 대신 폴더 열기 안내 (VS Code 'No Folder Opened' 뷰) -->
    <div v-if="activeSessionEmpty()" class="no-folder">
      <p>You have not yet opened a folder.</p>
      <button class="no-folder-open" @click="openDefault()">Open Folder</button>
    </div>
    <div v-else class="explorer-pane">
      <!-- 루트 첫 로드 중 — 사이드바 제목 아래 2px 에 겹치는 무한 진행선 (VS Code 뷰 progress) -->
      <ProgressBar v-if="files.loading && !connection.error" />
      <!-- 영구 접속 실패(원격 ssh) — 재연결하지 않으므로 사유 + Retry (시작 페이지의 Retry 와 같은
           경로, ticket remote-connect-retry). 재시도 중에는 접속 단계가 이 자리에 보인다 -->
      <div v-if="connection.error !== null" class="conn-error">
        <span class="codicon codicon-error" />
        <span>{{ failureLabel(connection.failedStage) }}: {{ connection.error }}</span>
        <button class="conn-retry" @click="retryActiveConnection()">Retry</button>
      </div>
      <div v-else-if="connection.stage !== null" class="conn-error connecting">
        <span class="codicon codicon-loading codicon-modifier-spin" />
        <span>{{ stageLabel(connection.stage, connection.uploadBytes) }}</span>
      </div>
      <FileTree ref="mainTreeRef" :tree="mainTree" primary />
      <!-- 추가 탐색기 드롭 존 — 폴더 드래그 중에만 pane 하단에 겹치는 투명 띠(레이아웃 불변). 포인터가
           실제로 들어왔을 때만 문구 없이 영역 표시만 -->
      <div
        v-if="folderDrag"
        class="xr-dropzone"
        :class="{ active: extraDropActive }"
        @dragover.prevent="extraDropActive = true; $event.dataTransfer && ($event.dataTransfer.dropEffect = 'copy')"
        @dragleave="extraDropActive = false"
        @drop="onExtraDrop"
      />
    </div>
    <!-- 추가 탐색기 섹션 — 드롭 순서대로 쌓이고 헤더 드래그로 자기들끼리 순서를 바꾼다.
         dragover/drop 은 묶음이 받는다 (포인터 위치로 삽입 자리를 정해야 한다) -->
    <div class="xr-sections" @dragover="onSectionsDragOver" @drop="onSectionsDrop">
      <ExtraRootTree
        v-for="(x, i) in files.extraRoots"
        :key="x.abs"
        :root="x"
        :line="lineFor(i, files.extraRoots.length)"
        @remove="removeExtraRoot(x.abs)"
        @reorder-start="reorderAbs = x.abs"
        @reorder-end="endReorder()"
      />
    </div>
    <!-- Download 뷰 (ticket cli-control-discussion) — 셸 심 `superlite download` 요청의 확인·상태.
         Outline·Timeline 스텁이 있던 자리. 페이지 전역 목록이라 빈 세션에서도 보인다. 위 경계 sash 로 높이
         조절(최소 = 헤더 + 행 2개 — 최근 1개 + "전체 다운로드 기록" 버튼), 넘치는 항목은 자르고 버튼이
         에디터 탭(DownloadsView)을 연다. 헤더의 체크는 일괄 다운로드 허용 -->
    <div class="dl-pane" :style="downloadsOpen ? { height: `${dlHeight}px` } : undefined">
      <Sash v-if="downloadsOpen" direction="horizontal" class="dl-sash" @dragstart="dlStart = dlHeight" @resize="resizeDl" />
      <div class="pane-header collapsed" @click="downloadsOpen = !downloadsOpen">
        <span class="codicon twisty" :class="downloadsOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'" />
        <span class="title">Download</span>
        <span v-if="pendingDownloads > 0" class="count">{{ pendingDownloads }}</span>
        <span class="spacer" />
        <span
          class="codicon codicon-check-all action"
          :class="{ disabled: pendingDownloads === 0 }"
          title="일괄 다운로드 허용"
          @click.stop="pendingDownloads > 0 && confirmAllDownloads()"
        />
      </div>
      <div v-if="downloadsOpen" class="downloads">
        <div v-if="orderedDownloads.length === 0" class="dl-empty">요청 없음</div>
        <div v-for="d in orderedDownloads.slice(0, dlVisible)" :key="d.id" class="dl-row" :title="`${d.session}: ${d.path}`">
          <span class="codicon" :class="d.kind === 'directory' ? 'codicon-folder' : 'codicon-file'" />
          <span class="dl-name">{{ d.name }}</span>
          <template v-if="d.state === 'pending'">
            <button class="dl-btn primary" @click="confirmDownload(d.id)">확인</button>
            <button class="dl-btn" @click="cancelDownload(d.id)">취소</button>
          </template>
          <template v-else>
            <span class="dl-state" :class="d.state" :title="d.error ?? ''">{{ DL_LABEL[d.state] }}</span>
            <span v-if="d.state !== 'running'" class="codicon codicon-close dl-close" @click="clearDownload(d.id)" />
          </template>
        </div>
      </div>
      <!-- 크롬의 "전체 다운로드 기록" 처럼 — 일반 글자색, 오른쪽 끝에 열기 아이콘만 -->
      <div v-if="downloadsOpen" class="dl-row dl-all" @click="showAllDownloads()">
        <span class="dl-name">전체 다운로드 기록</span>
        <span v-if="orderedDownloads.length > dlVisible" class="dl-state">+{{ orderedDownloads.length - dlVisible }}</span>
        <span class="codicon codicon-link-external dl-open" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-folder {
  padding: 12px 16px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.no-folder-open {
  padding: 5px 0;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
  cursor: pointer;
}
.no-folder-open:hover {
  background: var(--vscode-button-hoverBackground);
}
.explorer-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.explorer-pane {
  position: relative; /* 진행선·드롭 띠 기준 */
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.conn-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--vscode-errorForeground);
  word-break: break-all;
}
.conn-error.connecting {
  color: inherit;
  opacity: 0.85;
}
.conn-error .codicon {
  flex: none;
  font-size: 16px;
}
.conn-retry {
  padding: 2px 10px;
  border: 1px solid var(--vscode-button-border);
  border-radius: 2px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  cursor: pointer;
}
/* 추가 탐색기 섹션 묶음 — 메인 트리와 Download 사이. 순서 바꾸기 드롭을 여기서 받는다 */
.xr-sections {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}
/* ===== 추가 탐색기 드롭 존 — 하단 40px 겹침 띠, 들어왔을 때만 보인다 ===== */
.xr-dropzone {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40px;
  z-index: 1;
}
.xr-dropzone.active {
  background: var(--vscode-list-dropBackground);
  outline: 1px dashed var(--vscode-focusBorder);
  outline-offset: -2px;
}
/* ===== Download 뷰 행 ===== */
.pane-header .count {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 14px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.dl-pane {
  position: relative; /* sash 기준 */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dl-sash {
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  z-index: 1;
}
.pane-header .spacer {
  flex: 1;
}
.pane-header .action {
  font-size: 16px;
  margin-right: 6px;
  cursor: pointer;
}
.pane-header .action.disabled {
  opacity: 0.4;
  cursor: default;
}
.downloads {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  font-size: 13px;
}
.dl-all {
  flex-shrink: 0;
  cursor: pointer;
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
}
.dl-open {
  font-size: 14px;
  color: var(--vscode-descriptionForeground);
}
.dl-empty {
  padding: 4px 12px;
  color: var(--vscode-descriptionForeground);
}
.dl-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  white-space: nowrap;
}
.dl-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.dl-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dl-btn {
  height: 18px;
  padding: 0 8px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  font-size: 11px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.dl-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.dl-state {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.dl-state.failed {
  color: var(--vscode-errorForeground);
}
.dl-close {
  cursor: pointer;
  font-size: 14px;
}

/* ===== pane header (Download 뷰 헤더 — spec .pane-header: 22px, 11px/700, bg #181818) ===== */
.pane-header {
  display: flex;
  align-items: center;
  height: 22px;
  flex-shrink: 0;
  background: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarSectionHeader-foreground);
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
}
.pane-header.collapsed {
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
}
.pane-header .twisty {
  font-size: 16px;
  margin: 0 2px;
  flex-shrink: 0;
}
.pane-header .title {
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
