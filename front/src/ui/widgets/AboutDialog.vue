<script setup lang="ts">
// About 모달 (VS Code Help: About 근사) — 버전·커밋·빌드 시각·와이어·데몬 경로 + Copy.
// 본문은 model/version 의 aboutText 하나 — 표시와 복사가 같은 문자열이다.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { aboutText, closeAbout, version } from '../../model/version';

const okBtn = ref<HTMLButtonElement | null>(null);
const copied = ref(false);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    closeAbout();
  }
}
async function copy(): Promise<void> {
  await navigator.clipboard.writeText(`superlight\n${aboutText()}`);
  copied.value = true;
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true);
  okBtn.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <div class="dialog-backdrop" @mousedown.self="closeAbout()">
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-body">
        <span class="codicon codicon-info" />
        <div class="dialog-text">
          <div class="dialog-message">superlight</div>
          <pre class="dialog-detail">{{ aboutText() }}</pre>
        </div>
      </div>
      <div class="dialog-actions">
        <button v-if="version.info" class="dialog-button" @click="copy()">{{ copied ? 'Copied' : 'Copy' }}</button>
        <button ref="okBtn" class="dialog-button primary" @click="closeAbout()">OK</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ConfirmDialog 와 같은 비주얼 */
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
  max-width: 640px;
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
.dialog-body > .codicon-info {
  font-size: 26px;
  color: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
}
.dialog-text {
  min-width: 0;
}
.dialog-message {
  font-size: 15px;
  margin-bottom: 8px;
}
.dialog-detail {
  margin: 0;
  font: inherit;
  font-size: 12px;
  opacity: 0.85;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 20px 16px;
}
.dialog-button {
  padding: 4px 14px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  font-size: 13px;
  cursor: pointer;
}
.dialog-button.primary {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}
.dialog-button:hover {
  filter: brightness(1.1);
}
</style>
