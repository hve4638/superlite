<script setup lang="ts">
// git 인증 대화상자 (ticket scm-subrepo-credential) — gitauth 모델 상태 셋 중 하나가 열려 있을 때 뜬다:
//   prompt  git credential get (push/pull/fetch 중 helper 가 비었을 때 사용자명·비밀번호) — 확정이 곧 답
//   device  GitHub device flow (client ID 입력 → 코드 표시·폴링 대기 → 오류)
//   manual  사용자명·토큰 수동 등록
// ScmView 안에 있으므로 SCM 뷰가 보일 때만 그려진다 — askpass 는 gitauth 가 뷰를 먼저 연다.
// 스타일은 ConfirmDialog 와 같은 모양 (ponytail: 범용 다이얼로그 서비스 없음)
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  gitAuth, answerPrompt, cancelPrompt, setGithubClientId, cancelDeviceFlow, addCredential,
} from '../../model/gitauth';
import { errText, notify } from '../../model/notifications';

const username = ref('');
const secret = ref('');
const host = ref('');
const clientId = ref(gitAuth.githubClientId);
const remember = ref(true);
const dialogEl = ref<HTMLElement | null>(null);

type Mode = 'prompt' | 'device' | 'manual';
const mode = computed<Mode>(() => (gitAuth.prompt ? 'prompt' : gitAuth.device ? 'device' : 'manual'));
const prompt = computed(() => gitAuth.prompt);
const device = computed(() => gitAuth.device);

/** 저장 위치 안내 — 백엔드 머신의 OS 키체인, 없으면 파일 강등 (VS Code 도 같은 강등) */
const rememberLabel = computed(() =>
  gitAuth.keychain === false
    ? 'Remember (no OS keychain on the backend — saved to a private file)'
    : 'Remember (saved in the OS keychain of the backend machine)',
);
const title = computed(() => {
  if (mode.value === 'prompt') return `Git credentials for ${prompt.value?.host ?? ''}`;
  if (mode.value === 'device') return 'Sign in to GitHub';
  return 'Add Git credential';
});

/** 모드가 바뀔 때 입력 초기화 + 첫 입력에 포커스 */
watch(mode, reset, { immediate: true });
function reset(): void {
  username.value = mode.value === 'prompt' ? (prompt.value?.username ?? '') : '';
  secret.value = '';
  host.value = '';
  remember.value = true;
  clientId.value = gitAuth.githubClientId;
  // 모드마다 첫 입력이 다르다 — DOM 갱신 뒤 대화상자 안의 첫 input 에 포커스
  void nextTick(() => dialogEl.value?.querySelector('input')?.focus());
}

function submit(): void {
  if (mode.value === 'prompt') {
    if (!secret.value || !username.value.trim()) return;
    answerPrompt({ username: username.value.trim(), secret: secret.value, remember: remember.value });
  } else if (mode.value === 'device') {
    if (device.value?.step === 'clientId' && clientId.value.trim()) setGithubClientId(clientId.value);
    else if (device.value?.step === 'error') cancelDeviceFlow();
  } else {
    const h = host.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!h || !username.value.trim() || !secret.value) return;
    void addCredential({ host: h, username: username.value.trim(), secret: secret.value }).catch((e) => notify('error', `Failed to save: ${errText(e)}`));
    gitAuth.manual = false;
  }
}

function cancel(): void {
  if (mode.value === 'prompt') cancelPrompt();
  else if (mode.value === 'device') cancelDeviceFlow();
  else gitAuth.manual = false;
}

function copyCode(): void {
  if (device.value?.step === 'code') void navigator.clipboard.writeText(device.value.userCode);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    submit();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <div class="dialog-backdrop" @mousedown.self="cancel()">
    <div ref="dialogEl" class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-body">
        <span class="codicon" :class="mode === 'device' ? 'codicon-github' : 'codicon-key'" />
        <div class="dialog-text">
          <div class="dialog-message">{{ title }}</div>

          <template v-if="mode === 'prompt' && prompt">
            <label class="field">
              <span>Username</span>
              <input v-model="username" spellcheck="false" autocomplete="off" />
            </label>
            <label class="field">
              <span>Password or token</span>
              <input v-model="secret" type="password" autocomplete="off" />
            </label>
            <label class="check">
              <input v-model="remember" type="checkbox" />
              <span>{{ rememberLabel }}</span>
            </label>
          </template>

          <template v-else-if="mode === 'device' && device">
            <template v-if="device.step === 'clientId'">
              <div class="dialog-detail">
                Device flow needs an OAuth App client ID. Create one at GitHub → Settings → Developer settings →
                OAuth Apps (enable "Device flow"), then paste its Client ID.
              </div>
              <label class="field">
                <span>Client ID</span>
                <input v-model="clientId" spellcheck="false" autocomplete="off" />
              </label>
            </template>
            <template v-else-if="device.step === 'code'">
              <div class="dialog-detail">
                Open <a :href="device.verificationUri" target="_blank" rel="noreferrer">{{ device.verificationUri }}</a>
                and enter this code:
              </div>
              <div class="user-code">
                <span>{{ device.userCode }}</span>
                <span class="codicon codicon-copy action" title="Copy" @click="copyCode()" />
              </div>
              <div class="dialog-detail waiting">
                <span class="codicon codicon-loading codicon-modifier-spin" />
                Waiting for authorization…
              </div>
            </template>
            <div v-else class="dialog-detail error">{{ device.message }}</div>
          </template>

          <template v-else>
            <label class="field">
              <span>Host (e.g. gitlab.com)</span>
              <input v-model="host" spellcheck="false" autocomplete="off" />
            </label>
            <label class="field">
              <span>Username</span>
              <input v-model="username" spellcheck="false" autocomplete="off" />
            </label>
            <label class="field">
              <span>Password or token</span>
              <input v-model="secret" type="password" autocomplete="off" />
            </label>
          </template>
        </div>
      </div>
      <div class="dialog-actions">
        <button v-if="!(mode === 'device' && device?.step === 'code')" class="dialog-button primary" @click="submit()">
          {{ mode === 'manual' ? 'Add' : 'OK' }}
        </button>
        <button v-if="!(mode === 'device' && device?.step === 'error')" class="dialog-button" @click="cancel()">Cancel</button>
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
.dialog-body > .codicon {
  font-size: 26px;
  color: var(--vscode-notificationsInfoIcon-foreground);
  flex: none;
}
.dialog-text {
  flex: 1;
  min-width: 0;
}
.dialog-message {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}
.dialog-detail {
  margin-top: 6px;
  line-height: 18px;
  opacity: 0.9;
  user-select: text;
  word-break: break-word;
}
.dialog-detail.error {
  color: var(--vscode-errorForeground);
}
.dialog-detail a {
  color: var(--vscode-textLink-foreground);
}
.waiting {
  display: flex;
  align-items: center;
  gap: 6px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 10px;
}
.field > span {
  opacity: 0.9;
}
.field > input {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--vscode-input-border);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.field > input:focus {
  border-color: var(--vscode-focusBorder);
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.user-code {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 22px;
  font-family: monospace;
  letter-spacing: 2px;
  user-select: text;
}
.user-code .action {
  font-size: 16px;
  cursor: pointer;
  padding: 2px;
  border-radius: 5px;
  color: var(--vscode-icon-foreground);
}
.user-code .action:hover {
  background: var(--vscode-toolbar-hoverBackground);
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
