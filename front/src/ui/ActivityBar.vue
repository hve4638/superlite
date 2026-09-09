<script setup lang="ts">
import { computed } from 'vue';
import { workbench, showViewlet, sideBarShown, type ViewletId } from '../model/workbench';
import { scm } from '../model/scm';
import { remoteEnabled } from '../model/remote';
import { terminalState } from '../model/terminal';

// 터미널 뷰 — 데몬이 tmux 방식(또는 tmux 를 못 써 plain 으로 대체 — 경고 배지)일 때만. Windows
// (unsupported)와 attach 응답 전(unknown)·mock 은 아이콘 자체가 없다 (ticket term-list-reconnect)
const items = computed<{ id: ViewletId; icon: string; label: string }[]>(() => [
  { id: 'explorer', icon: 'codicon-files', label: 'Explorer' },
  { id: 'search', icon: 'codicon-search', label: 'Search' },
  { id: 'scm', icon: 'codicon-source-control', label: 'Source Control' },
  // 원격 탐색기 — 백엔드 HTTP API 가 있는 환경만 (mock 은 원격 개념이 없다)
  ...(remoteEnabled()
    ? [{ id: 'remote' as ViewletId, icon: 'codicon-remote-explorer', label: 'Remote Explorer' }]
    : []),
  ...(terminalState.mode === 'tmux' || terminalState.mode === 'plain'
    ? [{ id: 'terminals' as ViewletId, icon: 'codicon-terminal', label: 'Terminals' }]
    : []),
]);

function isActive(id: ViewletId): boolean {
  return sideBarShown() && workbench.activeViewlet === id;
}
</script>

<template>
  <div class="activitybar">
    <div class="actions-top">
      <div
        v-for="item in items"
        :key="item.id"
        class="action-item"
        :class="{ active: isActive(item.id) }"
        :title="item.label"
        @click="showViewlet(item.id, true)"
      >
        <div class="active-item-indicator" />
        <span class="codicon" :class="item.icon" />
        <span v-if="item.id === 'scm' && scm.changes.length" class="badge">
          {{ scm.changes.length }}
        </span>
        <span
          v-if="item.id === 'terminals' && terminalState.error"
          class="badge warn codicon codicon-error"
          :title="`tmux 를 쓸 수 없어 일반 터미널로 동작 중: ${terminalState.error}`"
        />
      </div>
    </div>
    <div class="actions-bottom">
      <div class="action-item" title="Manage">
        <span class="codicon codicon-settings-gear" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.activitybar {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 48px;
  background: var(--vscode-activityBar-background);
  flex-shrink: 0;
}
.action-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  cursor: pointer;
  color: var(--vscode-activityBar-inactiveForeground);
}
.action-item:hover,
.action-item.active {
  color: var(--vscode-activityBar-foreground);
}
.action-item .codicon {
  font-size: 24px;
}
.active-item-indicator {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0;
}
.action-item.active .active-item-indicator {
  border-left: 2px solid var(--vscode-activityBar-activeBorder);
}
.badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 20px;
  background: var(--vscode-activityBarBadge-background);
  color: var(--vscode-activityBarBadge-foreground);
  font-size: 9px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
/* tmux 불가 경고 — 우측 하단 붉은 느낌표 */
.badge.warn {
  padding: 0;
  min-width: 16px;
  background: var(--vscode-errorForeground);
  color: #fff;
  font-size: 12px;
}
</style>
