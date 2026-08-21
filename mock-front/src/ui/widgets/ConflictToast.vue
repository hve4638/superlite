<script setup lang="ts">
// 저장 충돌 알림 토스트 (VS Code notification toast 근사) — editors.saveConflict 가 있을 때만
// 마운트된다. ponytail: 범용 알림 센터 없음 — 알림이 이것뿐이라 단일 목적 컴포넌트로 충분.
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { editors, overwriteConflict, revertConflict } from '../../model/editors';

const name = computed(() => {
  const p = editors.saveConflict ?? '';
  return p.slice(p.lastIndexOf('/') + 1);
});

// VS Code 알림처럼 Escape 로 닫힌다 (버튼은 네이티브 button — Tab/Enter 동작)
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') editors.saveConflict = null;
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="toast" role="alert">
    <div class="toast-body">
      <span class="codicon codicon-error" />
      <span class="toast-message">
        Failed to save '{{ name }}': The content of the file is newer. Please revert
        your version or overwrite the content of the file with your changes.
      </span>
      <button class="toast-close" aria-label="Close" @click="editors.saveConflict = null">
        <span class="codicon codicon-close" />
      </button>
    </div>
    <div class="toast-actions">
      <button class="toast-button" @click="revertConflict()">Revert</button>
      <button class="toast-button" @click="overwriteConflict()">Overwrite</button>
    </div>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  right: 12px;
  bottom: 30px;
  width: 450px;
  z-index: 50;
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
.toast-body > .codicon-error {
  color: var(--vscode-notificationsErrorIcon-foreground);
  font-size: 16px;
  flex: none;
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
.toast-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px 10px;
}
.toast-button {
  height: 24px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.toast-button:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
