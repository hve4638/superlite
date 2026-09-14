<script setup lang="ts">
import { answerConfirm, dialog } from '../../model/dialog';
import { dismissNotification, notifications, runNotificationAction } from '../../model/notifications';
</script>

<template>
  <!-- 알림 토스트 (model/notifications) 와 확인 대화상자 (model/dialog) 의 모바일 렌더링 — 데스크톱 위젯은 폭 420px 전제라 따로 그린다 -->
  <div class="toasts">
    <div v-for="n in notifications.list" :key="n.id" class="toast" :class="n.severity">
      <span class="msg">{{ n.message }}</span>
      <button v-if="n.action" @click="runNotificationAction(n.id)">{{ n.action.label }}</button>
      <button class="x" @click="dismissNotification(n.id)"><span class="codicon codicon-close" /></button>
    </div>
  </div>
  <div v-if="dialog.pending" class="modal">
    <div class="box">
      <div class="message">{{ dialog.pending.message }}</div>
      <div v-if="dialog.pending.detail" class="detail">{{ dialog.pending.detail }}</div>
      <div class="actions">
        <button class="m-primary" @click="answerConfirm('confirm')">{{ dialog.pending.confirmLabel }}</button>
        <button v-if="dialog.pending.secondaryLabel" @click="answerConfirm('secondary')">{{ dialog.pending.secondaryLabel }}</button>
        <button @click="answerConfirm('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 56px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 50;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--vscode-notifications-background, #252526);
  border-left: 4px solid var(--vscode-notificationsInfoIcon-foreground, #3794ff);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
.toast.warning {
  border-left-color: var(--vscode-notificationsWarningIcon-foreground, #cca700);
}
.toast.error {
  border-left-color: var(--vscode-notificationsErrorIcon-foreground, #f14c4c);
}
.toast .msg {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
}
.toast button {
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}
.modal {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.box {
  width: min(360px, 90vw);
  padding: 16px;
  border-radius: 8px;
  background: var(--vscode-editorWidget-background, #202020);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
}
.message {
  font-weight: 600;
}
.detail {
  margin-top: 8px;
  font-size: 13px;
  opacity: 0.8;
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}
.actions button {
  padding: 10px;
  border-radius: 6px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}
</style>
