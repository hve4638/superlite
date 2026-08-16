<script setup lang="ts">
import { workbench, showViewlet, type ViewletId } from '../model/workbench';
import { scm } from '../model/scm';

const items: { id: ViewletId; icon: string; label: string }[] = [
  { id: 'explorer', icon: 'codicon-files', label: 'Explorer' },
  { id: 'search', icon: 'codicon-search', label: 'Search' },
  { id: 'scm', icon: 'codicon-source-control', label: 'Source Control' },
];

function isActive(id: ViewletId): boolean {
  return workbench.sideBarVisible && workbench.activeViewlet === id;
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
      </div>
    </div>
    <div class="actions-bottom">
      <div class="action-item" title="Accounts">
        <span class="codicon codicon-account" />
      </div>
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
</style>
