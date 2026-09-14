<script setup lang="ts">
import { ref } from 'vue';
import { activateSession, closeSession, loading, sessionCtxOf, sessions, type SessionTab } from '../../model/sessions';
import { confirm } from '../../model/dialog';
import { goTo } from './nav';
import FullscreenButton from './FullscreenButton.vue';
import WorkspacePicker from './WorkspacePicker.vue';

// Workspace 탭 (ticket mobile-shell, 사용자 결정 2026-09-15) — 데스크톱 세션 탭 줄에 해당한다. 열린 워크스페이스(sessions.list —
// 세션마다 자기 연결·트리·SCM·터미널 목록)를 나열하고, 탭하면 activateSession 으로 전환해 Editor 로 넘어간다 (파일·세션·Git·Editor
// 는 전부 활성 세션의 것이라 함께 바뀐다; 전환 때 Monaco 모델 캐시를 버려 undo 는 잃는다 — 데스크톱과 같다). 헤더 + = 추가
// (WorkspacePicker), 행 × = closeSession (그 세션에 미저장이 있으면 확인; 마지막 하나는 닫지 않는다 — 웹은 빈 세션으로 대체돼
// 화면이 비므로). 목록·활성은 model/mobileSessions 가 기억해 다음 부팅에 그대로 연다
const picking = ref(false);
const isActive = (t: SessionTab) => t.id === sessions.activeId;
function pick(t: SessionTab): void {
  activateSession(t.id);
  goTo('editor');
}
async function close(t: SessionTab): Promise<void> {
  if (sessions.list.length <= 1) return;
  if (sessionCtxOf(t.id)?.editors.hasDirtyDocs()) {
    const c = await confirm({ message: `Discard unsaved changes in '${t.name}'?`, detail: 'Closing the workspace discards them.', confirmLabel: 'Discard' });
    if (c !== 'confirm') return;
  }
  closeSession(t.id);
}
</script>

<template>
  <WorkspacePicker v-if="picking" @close="picking = false" />
  <div v-else class="m-screen">
    <header class="m-header">
      <span class="codicon codicon-folder-library" />
      <span class="title">Workspaces</span>
      <button class="m-icon-btn" title="Add workspace" @click="picking = true"><span class="codicon codicon-add" /></button>
      <FullscreenButton />
    </header>
    <div class="m-list">
      <div v-for="t in sessions.list" :key="t.id" class="m-row" :class="{ active: isActive(t) }" @click="pick(t)">
        <span class="codicon" :class="loading.has(t.id) ? 'codicon-loading codicon-modifier-spin' : isActive(t) ? 'codicon-check' : 'codicon-root-folder'" />
        <div class="main">
          <div class="name">{{ t.name || 'Empty' }}</div>
          <div class="meta">{{ t.root ?? 'no folder' }}</div>
        </div>
        <button class="m-icon-btn close" title="Close workspace" :disabled="sessions.list.length <= 1" @click.stop="close(t)"><span class="codicon codicon-close" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.m-row.active .name {
  color: var(--sl-accent, #3794ff);
}
.m-row .close {
  flex-shrink: 0;
}
</style>
