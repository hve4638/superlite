<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EDITOR_ZOOM_MAX, EDITOR_ZOOM_MIN, EDITOR_ZOOM_STEP, activeTab, base64Bytes, editorView, editors, indentOf, languageLabel, setEditorZoom, toggleViewerAutoReload, viewerAutoReload } from '../model/editors';
import { activeRepo } from '../model/scm';
import { transfer } from '../model/transfer';
import { connection, stageLabel, failureLabel } from '../model/watch';
import { cmdlineKey, inputText, toggleVimMode, vimMode, vimModeLabel } from '../model/nvim';
import { setTerminalZoom, terminalView } from '../model/terminal';

// diff 탭도 path 를 가지므로 kind 무관하게 파일 정보를 표시한다 (VS Code 동일)
const fileTab = computed(() => activeTab());
// 활성 편집기 파일이 속한 저장소의 브랜치 (VS Code 동일 — 다중 저장소면 파일을 따라 바뀐다)
const repo = computed(() => activeRepo());
const branchLabel = computed(() => (repo.value ? (repo.value.dirty ? `${repo.value.branch}*` : repo.value.branch) : ''));

// 이미지 탭이면 텍스트 항목(Ln/Col·Spaces·인코딩·언어) 대신 해상도·크기·배율을 표시한다
// (VS Code 이미지 프리뷰 동일 — 해상도는 로드 전이면 아직 없다)
const image = computed(() => {
  const t = fileTab.value;
  if (!t || t.kind === 'hex' || t.kind === 'preview' || t.kind === 'terminal' || t.kind === 'folder') return null;
  const data = editors.docs.get(t.path)?.image;
  if (data === undefined) return null;
  return { view: editors.imageView.get(t.path), size: base64Bytes(data) };
});
// hex 탭은 바이트 수만 — 로드 전이면 null (텍스트 항목도 이미지 항목도 아니다)
const hexSize = computed(() => {
  const t = fileTab.value;
  return t && t.kind === 'hex' ? editors.hex.get(t.path)?.size ?? null : null;
});
const viewerTab = computed(() => fileTab.value !== null && (fileTab.value.kind === 'hex' || fileTab.value.kind === 'preview' || fileTab.value.kind === 'terminal' || fileTab.value.kind === 'folder'));

// 접속 진행 중 경과 시간 힌트 — 1초 틱 (헬퍼 업로드처럼 오래 걸리는 단계용)
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  if (tick !== null) clearInterval(tick);
});
/** 원격 표시등 라벨 — 접속 단계 진행 중 / 영구 실패(단계 구분) / 실제 재연결 */
const remoteLabel = computed(() => {
  if (connection.stage !== null) {
    const secs = Math.max(0, Math.floor((now.value - connection.stageSince) / 1000));
    return `${stageLabel(connection.stage, connection.uploadBytes)}${secs >= 3 ? ` ${secs}s` : ''}`;
  }
  if (connection.error !== null) return failureLabel(connection.failedStage);
  return 'Reconnecting…';
});

// 편집기 줌 팝오버 — 배율 항목 클릭으로 열고, 바깥 클릭·Escape 로 닫는다. 슬라이더는 10% 단위(step).
// WHY: 상태바가 overflow hidden 이라 항목 안의 absolute 는 위로 잘린다 — fixed 로 띄우고 항목의
//      오른쪽 끝에 맞춘다 (열 때 한 번 계산; 상태바는 창 맨 아래 고정이라 bottom 은 상수)
const zoomOpen = ref(false);
const zoomItem = ref<HTMLElement | null>(null);
const zoomRight = ref(0);
function toggleZoom(): void {
  if (!zoomOpen.value && zoomItem.value) {
    zoomRight.value = Math.round(window.innerWidth - zoomItem.value.getBoundingClientRect().right);
  }
  zoomOpen.value = !zoomOpen.value;
}
function onZoomOutside(e: MouseEvent): void {
  if (!zoomItem.value?.contains(e.target as Node)) zoomOpen.value = false;
}
function onZoomKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') zoomOpen.value = false;
}
watch(zoomOpen, (open) => {
  if (open) {
    window.addEventListener('mousedown', onZoomOutside, true);
    window.addEventListener('keydown', onZoomKey, true);
  } else {
    window.removeEventListener('mousedown', onZoomOutside, true);
    window.removeEventListener('keydown', onZoomKey, true);
  }
});
onBeforeUnmount(() => (zoomOpen.value = false));

// vim 명령줄(: / ?) 이 열리면 상태바의 보이지 않는 입력창으로 포커스를 옮긴다 — normal 모드의
// 편집기는 readOnly 라 IME 조합이 시작되지 않아 한글 검색을 칠 수 없다. 이 입력창은 IME 대상일
// 뿐 값은 쓰지 않는다: 일반 키는 keydown 에서 nvim 으로, 조합 텍스트는 compositionend 에서
const vimInput = ref<HTMLInputElement | null>(null);
watch(() => vimMode.cmdline !== null, (open) => {
  if (open) void nextTick(() => vimInput.value?.focus());
});
function onVimInputKey(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (cmdlineKey(e)) e.preventDefault();
}
function onVimCompose(e: CompositionEvent): void {
  if (e.data) inputText(e.data);
  (e.target as HTMLInputElement).value = '';
}
// 조합 없이 들어온 텍스트(붙여넣기·insertText) — 조합 중(isComposing)은 compositionend 가 보낸다
function onVimInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  if ((e as InputEvent).isComposing || !el.value) return;
  inputText(el.value);
  el.value = '';
}

/** 전송 진행 라벨 — "Downloading x 42%" (총량을 아직 모르면 퍼센트 없이) */
const transferLabel = computed(() => {
  const t = transfer.active;
  if (!t) return '';
  return t.total > 0 ? `${t.label} ${Math.floor((t.done / t.total) * 100)}%` : t.label;
});

/** 파일 크기 표기 — VS Code 상태바와 같은 단위 자동 선택 */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
</script>

<template>
  <div class="statusbar">
    <div class="statusbar-left">
      <!-- 끊김 중엔 VS Code 원격 표시등처럼 offline 색 + 라벨 (재연결은 WsBackend 가 자동으로) -->
      <!-- 접속 단계 진행 중(초기 접속)은 Reconnecting 이 아니라 단계 라벨 — 초기 접속과 실제 재연결을 구분한다 -->
      <!-- 진행 중은 오류색이 아니라 원격 표시등 기본색 + 회전 아이콘 — 빨간색은 실패·끊김에만 -->
      <div
        class="statusbar-item remote"
        :class="{ offline: !connection.ok && connection.stage === null, connecting: connection.stage !== null }"
        :title="connection.stage !== null ? remoteLabel : connection.ok ? 'Open a Remote Window' : connection.error ?? 'Reconnecting…'"
      >
        <span v-if="connection.stage !== null" class="codicon codicon-loading codicon-modifier-spin" />
        <span v-else class="codicon codicon-remote" />
        <!-- 영구 실패(원격 ssh)는 재연결하지 않는다 — Reconnecting 대신 실패 단계 표시 -->
        <span v-if="!connection.ok || connection.stage !== null">{{ remoteLabel }}</span>
      </div>
      <!-- 원격 파일 전송(다운로드·업로드) 진행 — 한 번에 하나 (ticket explorer-download) -->
      <div v-if="transfer.active" class="statusbar-item" :title="transferLabel">
        <span class="codicon codicon-loading codicon-modifier-spin" />
        <span>{{ transferLabel }}</span>
      </div>
      <div v-if="branchLabel" class="statusbar-item" :title="`${repo!.branch} (Git)`">
        <span class="codicon codicon-source-control" />
        <span>{{ branchLabel }}</span>
      </div>
      <!-- vim 모드(임베드 nvim, ticket editor-vim-mode) — 켜져 있을 때만. 모드 + 명령줄(: / ?) + 입력 중 키 + 메시지.
           클릭 = 끄기 (켜기는 팔레트 'View: Toggle Vim Mode'). starting 은 접속·초기화 중 -->
      <div v-if="vimMode.enabled" class="statusbar-item vim" title="Vim mode — click to turn off" @click="toggleVimMode">
        <span v-if="vimMode.status !== 'ready'" class="codicon codicon-loading codicon-modifier-spin" />
        <span v-else-if="vimMode.cmdline" class="vim-cmdline" @click.stop>
          {{ vimMode.cmdline.prompt }}{{ vimMode.cmdline.firstc }}{{ vimMode.cmdline.content }}
          <input ref="vimInput" class="vim-cmdline-input" @keydown="onVimInputKey" @compositionend="onVimCompose" @input="onVimInput" @click.stop />
        </span>
        <span v-else>-- {{ vimModeLabel(vimMode.mode) }} --</span>
        <span v-if="vimMode.showcmd" class="vim-showcmd">{{ vimMode.showcmd }}</span>
        <span v-if="vimMode.message && !vimMode.cmdline" class="vim-message">{{ vimMode.message }}</span>
      </div>
      <div class="statusbar-item" title="No Problems">
        <span class="codicon codicon-error" />
        <span>0</span>
        <span class="codicon codicon-warning" />
        <span>0</span>
      </div>
    </div>
    <div class="statusbar-right">
      <template v-if="fileTab && image">
        <div v-if="image.view" class="statusbar-item">
          <span>{{ image.view.w }}x{{ image.view.h }}</span>
        </div>
        <div class="statusbar-item"><span>{{ fmtSize(image.size) }}</span></div>
        <div class="statusbar-item">
          <span>{{
            image.view === undefined || image.view.zoom === 'fit'
              ? 'Fit'
              : `${Math.round(image.view.zoom * 100)}%`
          }}</span>
        </div>
      </template>
      <div v-else-if="hexSize !== null" class="statusbar-item"><span>{{ fmtSize(hexSize) }}</span></div>
      <!-- HTML 프리뷰 탭이면 자동 갱신 토글 — 뷰어 종류별 스위치 (PDF 뷰어는 pdf 키로 같은 자리) -->
      <div
        v-else-if="fileTab?.kind === 'preview'"
        class="statusbar-item"
        :title="viewerAutoReload.html ? 'Auto Reload is on — click to turn off' : 'Auto Reload is off — click to turn on'"
        @click="toggleViewerAutoReload('html')"
      >
        <span class="codicon" :class="viewerAutoReload.html ? 'codicon-sync' : 'codicon-sync-ignored'" />
        <span>Auto Reload: {{ viewerAutoReload.html ? 'On' : 'Off' }}</span>
      </div>
      <template v-else-if="fileTab && !viewerTab">
        <div class="statusbar-item">
          <span>Ln {{ editors.cursor.line }}, Col {{ editors.cursor.col }}</span>
        </div>
        <div class="statusbar-item">
          <span>Spaces: {{ indentOf(fileTab.path) }}</span>
        </div>
        <div class="statusbar-item"><span>UTF-8</span></div>
        <div class="statusbar-item"><span>LF</span></div>
        <div class="statusbar-item"><span>{{ languageLabel(fileTab.path) }}</span></div>
        <!-- 편집기 줌 — 웹뷰 줌(Ctrl+=)과 별개로 편집기 글꼴만. 팝오버는 항목 위로 열린다 -->
        <div ref="zoomItem" class="statusbar-item zoom" :class="{ open: zoomOpen }" title="Editor Zoom" @click="toggleZoom">
          <span>{{ editorView.zoom }}%</span>
          <!-- 슬라이더 하나뿐 — 값은 상태바 항목이 보여준다. 채워진 구간은 트랙 그라디언트로 (ends 는 0~100% 비율) -->
          <div v-if="zoomOpen" class="zoom-popover" :style="{ right: `${zoomRight}px` }" @click.stop>
            <input
              type="range"
              :min="EDITOR_ZOOM_MIN"
              :max="EDITOR_ZOOM_MAX"
              :step="EDITOR_ZOOM_STEP"
              :value="editorView.zoom"
              :style="{ '--fill': `${((editorView.zoom - EDITOR_ZOOM_MIN) / (EDITOR_ZOOM_MAX - EDITOR_ZOOM_MIN)) * 100}%` }"
              @input="setEditorZoom(Number(($event.target as HTMLInputElement).value))"
            />
          </div>
        </div>
      </template>
      <div v-else-if="fileTab?.kind === 'terminal'" ref="zoomItem" class="statusbar-item zoom" :class="{ open: zoomOpen }" title="Terminal Zoom" @click="toggleZoom">
        <!-- 터미널 줌 — 편집기 줌과 별개의 값 (Ctrl+= / Ctrl+- / Ctrl+0 은 터미널 포커스 중 이쪽) -->
        <span>{{ terminalView.zoom }}%</span>
        <div v-if="zoomOpen" class="zoom-popover" :style="{ right: `${zoomRight}px` }" @click.stop>
          <input
            type="range"
            :min="EDITOR_ZOOM_MIN"
            :max="EDITOR_ZOOM_MAX"
            :step="EDITOR_ZOOM_STEP"
            :value="terminalView.zoom"
            :style="{ '--fill': `${((terminalView.zoom - EDITOR_ZOOM_MIN) / (EDITOR_ZOOM_MAX - EDITOR_ZOOM_MIN)) * 100}%` }"
            @input="setTerminalZoom(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>
      <div class="statusbar-item" title="No Notifications">
        <span class="codicon codicon-bell" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 22px;
  background: var(--vscode-statusBar-background);
  color: var(--vscode-statusBar-foreground);
  font-size: 12px;
  flex-shrink: 0;
  overflow: hidden;
}
.statusbar-left,
.statusbar-right {
  display: flex;
  align-items: center;
  height: 100%;
}
.statusbar-left {
  padding-left: 2px;
}
.statusbar-right {
  padding-right: 2px;
}
.statusbar-item {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 100%;
  padding: 0 5px;
  cursor: pointer;
  white-space: nowrap;
}
.statusbar-item:hover {
  background: var(--vscode-statusBarItem-hoverBackground);
}
.statusbar-item .codicon {
  font-size: 14px;
}
.statusbar-item.connecting {
  background: var(--vscode-statusBarItem-remoteBackground, #16825d);
  color: var(--vscode-statusBarItem-remoteForeground, #ffffff);
}
.statusbar-item.zoom.open {
  background: var(--vscode-statusBarItem-hoverBackground);
}
.zoom-popover {
  position: fixed;
  bottom: 26px;
  width: 180px;
  padding: 10px 12px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
  cursor: default;
  z-index: 100;
}
/* VS Code 톤의 슬라이더 — 얇은 트랙, 채워진 구간은 focusBorder 파랑, 작은 둥근 손잡이 */
.zoom-popover input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 12px;
  margin: 0;
  background: transparent;
  cursor: pointer;
  --track: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
  --accent: var(--vscode-focusBorder, #0078d4);
}
.zoom-popover input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(to right, var(--accent) var(--fill), var(--track) var(--fill));
}
.zoom-popover input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 11px;
  height: 11px;
  margin-top: -4px;
  border-radius: 50%;
  border: none;
  background: var(--accent);
}
.zoom-popover input[type='range']:focus {
  outline: none;
}
.statusbar-item.vim {
  gap: 8px;
}
.statusbar-item.vim .vim-cmdline {
  font-family: var(--vscode-editor-font-family, monospace);
}
.statusbar-item.vim .vim-cmdline-input {
  width: 1px;
  border: none;
  outline: none;
  padding: 0;
  background: transparent;
  color: transparent;
  caret-color: transparent;
}
.statusbar-item.vim .vim-showcmd {
  opacity: 0.7;
}
.statusbar-item.vim .vim-message {
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.statusbar-item.offline {
  background: var(--vscode-statusBarItem-offlineBackground, #6c1717);
  color: var(--vscode-statusBarItem-offlineForeground, #ffffff);
}
</style>
