<script setup lang="ts">
import { computed } from 'vue';
import { openQuickInput } from '../model/workbench';
import { retryActiveConnection } from '../model/host';
import { isRemoteEmpty, remoteHost, sessions } from '../model/sessions';
import { connection, failureLabel, stageLabel } from '../model/watch';

/** 원격 빈 세션이면 그 host — 접속 상태 줄을 보인다 (로컬 빈 세션은 연결이 없다) */
const host = computed(() => {
  const root = sessions.list.find((t) => t.id === sessions.activeId)?.root ?? null;
  return isRemoteEmpty(root) ? remoteHost(root ?? '') : null;
});
/** attach 전 — 폴더 열기(원격 browseDir)는 빈 목록으로 조용히 실패하므로 막는다 */
const connecting = computed(() => host.value !== null && connection.stage !== null);
const failed = computed(() => host.value !== null && connection.error !== null);
const statusText = computed(() => {
  if (connection.stage !== null) return stageLabel(connection.stage, connection.uploadBytes);
  if (connection.error !== null) return `${failureLabel(connection.failedStage)}: ${connection.error}`;
  return `Connected to ${host.value}`;
});

// 시작 페이지 — 루트 없는 빈 세션의 에디터 영역을 채운다 (ticket app-empty-session).
// 폴더를 열면 이 빈 탭 자리가 워크스페이스 세션으로 교체된다 (host.openFolder 의 replace).

/** 기본 열기 — 경로 입력 퀵인풋 ("Open folder by path", 앱·웹 공통). 앱은 퀵인풋에서
 *  Ctrl+O 를 한 번 더 누르면 OS 다이얼로그로 넘어간다 */
function openDefault(): void {
  openQuickInput('folder');
}
</script>

<template>
  <div class="start-page">
    <div class="start-title">superlight</div>
    <div class="start-sub">You have not yet opened a folder.</div>
    <!-- 원격 빈 세션의 접속 상태 — 단계 진행 / 실패 단계(연결 자체 vs 그 뒤) / 완료. 실패는 Retry -->
    <div v-if="host !== null" class="start-status" :class="{ failed, connecting }">
      <span v-if="connecting" class="codicon codicon-loading codicon-modifier-spin" />
      <span v-else-if="failed" class="codicon codicon-error" />
      <span v-else class="codicon codicon-remote" />
      <span>{{ statusText }}</span>
      <button v-if="failed" class="start-retry" @click="retryActiveConnection()">Retry</button>
    </div>
    <button class="start-open" :disabled="connecting" @click="openDefault()">Open Folder…</button>
    <div class="start-hints">
      <div class="hint-row">
        <span class="hint-label">Open folder by path</span>
        <span class="hint-key">Ctrl+O</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.start-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  user-select: none;
}
.start-title {
  font-size: 34px;
  font-weight: 300;
  letter-spacing: 1px;
  color: var(--vscode-titleBar-inactiveForeground);
}
.start-sub {
  font-size: 13px;
  opacity: 0.7;
  margin-bottom: 14px;
}
.start-open {
  padding: 6px 18px;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  font-size: 13px;
  cursor: pointer;
}
.start-status {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 520px;
  font-size: 12px;
  opacity: 0.85;
  margin-bottom: 4px;
}
.start-status > span:not(.codicon) {
  overflow-wrap: anywhere;
}
.start-status .codicon {
  flex: none;
}
.start-status.failed {
  color: var(--vscode-errorForeground, #f48771);
}
.start-retry {
  margin-left: 6px;
  padding: 2px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  font-size: 12px;
  cursor: pointer;
}
.start-open:disabled {
  opacity: 0.5;
  cursor: default;
}
.start-open:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.start-hints {
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  opacity: 0.75;
}
.hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.hint-key {
  padding: 1px 6px;
  border: 1px solid var(--vscode-tab-border);
  border-radius: 3px;
  background: var(--vscode-tab-activeBackground);
  font-family: monospace;
  font-size: 11px;
}
</style>
