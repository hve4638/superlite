<script setup lang="ts">
import { inApp } from '../model/window';
import { openQuickInput } from '../model/workbench';

// 시작 페이지 — 루트 없는 빈 세션의 에디터 영역을 채운다 (ticket app-empty-session).
// 폴더를 열면 이 빈 탭 자리가 워크스페이스 세션으로 교체된다 (host.openFolder 의 replace).

/** 기본 열기 — 경로 입력 퀵인풋 ("Open folder by path", 앱·웹 공통). 앱은 OS
 *  다이얼로그도 Ctrl+Shift+O 로 병행 제공된다 (아래 힌트) */
function openDefault(): void {
  openQuickInput('folder');
}
</script>

<template>
  <div class="start-page">
    <div class="start-title">superlight</div>
    <div class="start-sub">You have not yet opened a folder.</div>
    <button class="start-open" @click="openDefault()">Open Folder…</button>
    <div class="start-hints">
      <div class="hint-row">
        <span class="hint-label">Open folder by path</span>
        <span class="hint-key">Ctrl+O</span>
      </div>
      <div v-if="inApp" class="hint-row">
        <span class="hint-label">Open folder (OS dialog)</span>
        <span class="hint-key">Ctrl+Shift+O</span>
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
