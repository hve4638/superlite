<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { activeTab, base64Bytes, editors, indentOf, languageLabel, toggleViewerAutoReload, viewerAutoReload } from '../model/editors';
import { scm } from '../model/scm';
import { connection, stageLabel, failureLabel } from '../model/watch';

// diff 탭도 path 를 가지므로 kind 무관하게 파일 정보를 표시한다 (VS Code 동일)
const fileTab = computed(() => activeTab());
const branchLabel = computed(() => (scm.dirty ? `${scm.branch}*` : scm.branch));

// 이미지 탭이면 텍스트 항목(Ln/Col·Spaces·인코딩·언어) 대신 해상도·크기·배율을 표시한다
// (VS Code 이미지 프리뷰 동일 — 해상도는 로드 전이면 아직 없다)
const image = computed(() => {
  const t = fileTab.value;
  if (!t || t.kind === 'hex' || t.kind === 'preview') return null;
  const data = editors.docs.get(t.path)?.image;
  if (data === undefined) return null;
  return { view: editors.imageView.get(t.path), size: base64Bytes(data) };
});
// hex 탭은 바이트 수만 — 로드 전이면 null (텍스트 항목도 이미지 항목도 아니다)
const hexSize = computed(() => {
  const t = fileTab.value;
  return t && t.kind === 'hex' ? editors.hex.get(t.path)?.size ?? null : null;
});
const viewerTab = computed(() => fileTab.value !== null && (fileTab.value.kind === 'hex' || fileTab.value.kind === 'preview'));

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
      <div v-if="scm.branch" class="statusbar-item" :title="`${scm.branch} (Git)`">
        <span class="codicon codicon-source-control" />
        <span>{{ branchLabel }}</span>
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
      </template>
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
.statusbar-item.offline {
  background: var(--vscode-statusBarItem-offlineBackground, #6c1717);
  color: var(--vscode-statusBarItem-offlineForeground, #ffffff);
}
</style>
