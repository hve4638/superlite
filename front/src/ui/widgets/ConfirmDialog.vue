<script setup lang="ts">
// 모달 confirm (VS Code dialog 근사) — Enter=확인, Escape=취소, 확인 버튼 자동 포커스.
// ponytail: 범용 다이얼로그 서비스 없음 — 쓰는 곳이 넷(탐색기 삭제·SCM discard·에디터 닫기·원격 데몬
// 강제 정리)이고 각자 v-if + props 로 띄운다. 상한(한 화면에 둘 이상 동시 필요)은 아직 아니다.
import { onBeforeUnmount, onMounted, ref } from 'vue';

// secondaryLabel 이 있으면 3버튼 (Save / Don't Save / Cancel 류 — 에디터 닫기 확인)
defineProps<{ message: string; detail: string; confirmLabel: string; secondaryLabel?: string }>();
const emit = defineEmits<{ confirm: []; secondary: []; cancel: [] }>();

const confirmBtn = ref<HTMLButtonElement | null>(null);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('cancel');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    emit('confirm');
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  confirmBtn.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <div class="dialog-backdrop" @mousedown.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-body">
        <span class="codicon codicon-warning" />
        <div class="dialog-text">
          <div class="dialog-message">{{ message }}</div>
          <div class="dialog-detail">{{ detail }}</div>
        </div>
      </div>
      <div class="dialog-actions">
        <button ref="confirmBtn" class="dialog-button primary" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
        <button v-if="secondaryLabel" class="dialog-button" @click="emit('secondary')">
          {{ secondaryLabel }}
        </button>
        <button class="dialog-button" @click="emit('cancel')">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2600;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  justify-content: center;
}
.dialog {
  margin-top: 15vh;
  height: fit-content;
  min-width: 420px;
  max-width: 560px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-editorWidget-foreground);
  border: 1px solid var(--vscode-editorWidget-border);
  box-shadow: 0 0 8px 2px var(--vscode-widget-shadow);
  font-size: 13px;
}
.dialog-body {
  display: flex;
  gap: 10px;
  padding: 20px 20px 10px;
}
.dialog-body > .codicon-warning {
  font-size: 26px;
  color: var(--vscode-notificationsWarningIcon-foreground);
  flex: none;
}
.dialog-message {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  user-select: text;
}
.dialog-detail {
  margin-top: 6px;
  line-height: 18px;
  opacity: 0.9;
  user-select: text;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 20px 20px;
}
.dialog-button {
  height: 26px;
  padding: 0 14px;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.dialog-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.dialog-button.primary:hover {
  background: var(--vscode-button-hoverBackground);
}
.dialog-button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 2px;
}
</style>
