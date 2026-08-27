<script setup lang="ts">
// 범용 알림 토스트 스택 (VS Code notification toast 근사) — model/notifications 의 표피.
// 새 알림이 아래에 붙고 위로 쌓인다. hover 는 자동 숨김을 멈추고, Escape 는 전부 닫는다
// (VS Code notifications.hideToasts 와 동일).
import { onBeforeUnmount, onMounted } from 'vue';
import {
  dismissNotification,
  notifications,
  pauseNotification,
  resumeNotification,
} from '../../model/notifications';

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || notifications.list.length === 0) return;
  for (const n of [...notifications.list]) dismissNotification(n.id);
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    v-for="n in notifications.list"
    :key="n.id"
    class="toast"
    role="alert"
    @mouseenter="pauseNotification(n.id)"
    @mouseleave="resumeNotification(n.id)"
  >
    <div class="toast-body">
      <span class="codicon" :class="`codicon-${n.severity}`" :data-severity="n.severity" />
      <span class="toast-message">{{ n.message }}</span>
      <button class="toast-close" aria-label="Close" @click="dismissNotification(n.id)">
        <span class="codicon codicon-close" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ConflictToast 와 같은 비주얼 — 스택 배치는 Workbench 의 .toast-stack 이 맡는다 */
.toast {
  width: 450px;
  background: var(--vscode-notifications-background);
  color: var(--vscode-notifications-foreground);
  border: 1px solid var(--vscode-notificationToast-border);
  box-shadow: 0 0 8px 2px var(--vscode-widget-shadow);
  font-size: 13px;
}
.toast-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 8px 10px 12px;
}
.toast-body > .codicon {
  font-size: 16px;
  flex: none;
}
.toast-body > [data-severity='error'] {
  color: var(--vscode-notificationsErrorIcon-foreground);
}
.toast-body > [data-severity='warning'] {
  color: var(--vscode-notificationsWarningIcon-foreground);
}
.toast-body > [data-severity='info'] {
  color: var(--vscode-notificationsInfoIcon-foreground);
}
.toast-message {
  flex: 1;
  line-height: 18px;
  user-select: text;
}
.toast-close {
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.8;
}
.toast-close:hover {
  opacity: 1;
}
</style>
