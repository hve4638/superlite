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
  runNotificationAction,
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
    <div v-if="n.action" class="toast-actions">
      <button class="toast-action" @click="runNotificationAction(n.id)">{{ n.action.label }}</button>
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
  /* min-width 0 — flex 기본 min-width:auto 라 공백 없는 긴 경로가 상자를 밀고 나간다.
     anywhere — 구분자 없는 경로도 상자 폭에서 꺾는다 (VS Code word-break: break-word 상당) */
  min-width: 0;
  overflow-wrap: anywhere;
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
/* VS Code notification-list-item-buttons-container 근사 — 본문 아래 오른쪽 정렬 버튼 */
.toast-actions {
  display: flex;
  justify-content: flex-end;
  padding: 0 8px 10px 36px;
}
.toast-action {
  padding: 2px 10px;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.toast-action:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
