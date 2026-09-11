<script setup lang="ts">
// 사이드바 터미널 뷰 (ticket term-list-reconnect) — 이 워크스페이스의 살아 있는 tmux 세션 목록.
// 행 클릭 = 탭으로 열기(이미 열려 있으면 그 탭 앞으로), 우클릭 = 새 탭으로·이름 바꾸기·종료.
// 데몬이 tmux 를 못 써 plain 으로 동작 중이면 위에 사유를 보인다. 상단은 클라이언트 tmux.conf 프로필
// 폼(ticket config-editors) — select 로 적용 프로필을 고르면 접속 중인 모든 데몬에 즉시 적용되고,
// 편집은 편집기 탭(openTmuxConf)에서. default 는 내장 기본값(읽기 전용)이고 + 는 그것을 복사해 시작, 복제는 선택된
// 프로필 복사 — 둘 다 인라인 이름 입력. 삭제는 확인 대화상자 (default 불가)
import { onMounted, ref } from 'vue';
import type { TerminalInfo } from '../../backend/types';
import {
  terminalState, terminals, refreshTerminals, attachTerminal, killListedTerminal, renameListedTerminal,
} from '../../model/terminal';
import {
  configEnabled, openTmuxConf, refreshTmuxProfiles, selectTmuxProfile, tmuxProfiles, updateTmuxProfiles,
} from '../../model/configfiles';
import { openContextMenu } from '../../model/workbench';
import { errText, notify } from '../../model/notifications';
import InlineNameInput from '../widgets/InlineNameInput.vue';
import { confirm } from '../../model/dialog';

// 목록은 tmux 서버가 원장 — 3초 폴링은 model 이 한다 (활동바 배지도 같은 목록을 쓴다). 여기서는 열릴 때 한 번
onMounted(() => {
  void refreshTerminals();
  if (configEnabled()) refreshTmuxProfiles().catch((e) => notify('error', `tmux profiles: ${errText(e)}`));
});

/** 이 창에서 열려 있는 세션인가 */
function isOpen(t: TerminalInfo): boolean {
  return terminals.list.some((i) => i.tmux?.id === t.id);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// 이름 바꾸기 — 행 자리의 인라인 입력 (Enter 확정, Escape 취소)
const renaming = ref<string | null>(null);
const renameText = ref('');
function startRename(t: TerminalInfo): void {
  renaming.value = t.id;
  renameText.value = t.name;
}
function commitRename(t: TerminalInfo): void {
  const name = renameText.value.trim();
  renaming.value = null;
  if (name && name !== t.name) void renameListedTerminal(t.id, name);
}

function onContextMenu(e: MouseEvent, t: TerminalInfo): void {
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, [
    { label: 'Open', run: () => attachTerminal(t) },
    { label: 'Open in New Tab', run: () => attachTerminal(t, { newTab: true }) },
    { separator: true },
    { label: 'Rename', run: () => startRename(t) },
    { separator: true },
    { label: 'Kill Terminal', run: () => void killListedTerminal(t.id) },
  ]);
}

// ---- tmux 프로필 폼
/** 진행 중인 이름 입력 — 새 프로필 또는 복제(from = 현재 선택) */
const naming = ref<'create' | 'clone' | null>(null);
function validName(v: string): string | null {
  const name = v.trim();
  if (!name) return 'A profile name must be provided.';
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name)) return 'Letters, digits, . _ - only.';
  if (tmuxProfiles.names.includes(name)) return `A profile '${name}' already exists.`;
  return null;
}
async function onSelect(e: Event): Promise<void> {
  const name = (e.target as HTMLSelectElement).value;
  try {
    await selectTmuxProfile(name);
    notify('info', `tmux.conf: '${name}' applied`);
  } catch (err) {
    notify('error', `tmux.conf: ${errText(err)}`);
  }
}
async function commitName(name: string): Promise<void> {
  const op = naming.value;
  naming.value = null;
  if (!op) return;
  try {
    await updateTmuxProfiles(op, name, op === 'clone' ? tmuxProfiles.active : undefined);
    await openTmuxConf(name);
  } catch (e) {
    notify('error', `tmux.conf: ${errText(e)}`);
  }
}
async function askDelete(name: string): Promise<void> {
  const choice = await confirm({
    message: `Delete tmux profile '${name}'?`,
    detail: 'The profile file is removed from this machine. If it is the applied profile, the built-in default is applied instead.',
    confirmLabel: 'Delete',
  });
  if (choice !== 'confirm') return;
  try {
    await updateTmuxProfiles('delete', name);
  } catch (e) {
    notify('error', `tmux.conf: ${errText(e)}`);
  }
}
</script>

<template>
  <div class="terminals-view">
    <div v-if="configEnabled()" class="profiles" title="Client tmux.conf profile — applied to every connected daemon">
      <span class="codicon codicon-settings-gear type-icon" />
      <select class="profile-select" :value="tmuxProfiles.active" @change="void onSelect($event)">
        <option v-for="n in tmuxProfiles.names" :key="n" :value="n">{{ n === 'default' ? 'default (built-in)' : n }}</option>
      </select>
      <span class="codicon codicon-edit action" :title="tmuxProfiles.active === 'default' ? 'View Built-in Default (read-only)' : 'Edit Profile'" @click="void openTmuxConf()" />
      <span class="codicon codicon-add action" title="New Profile..." @click="naming = 'create'" />
      <span class="codicon codicon-copy action" title="Duplicate Profile..." @click="naming = 'clone'" />
      <span
        class="codicon codicon-trash action"
        :class="{ disabled: tmuxProfiles.active === 'default' }"
        title="Delete Profile"
        @click="tmuxProfiles.active !== 'default' && void askDelete(tmuxProfiles.active)"
      />
    </div>
    <div v-if="naming" class="profile-name">
      <InlineNameInput
        :initial="naming === 'clone' ? `${tmuxProfiles.active}-copy` : ''"
        :validate="validName"
        @commit="(v) => void commitName(v)"
        @cancel="naming = null"
      />
    </div>
    <div v-if="terminalState.error" class="warn-note">
      <span class="codicon codicon-error" />
      <span>tmux unavailable — terminals will not survive closing the app. {{ terminalState.error }}</span>
    </div>
    <div class="list">
      <div v-if="terminalState.list.length === 0" class="empty-note">
        No live terminals in this workspace. Ctrl+` opens a new one.
      </div>
      <div
        v-for="t in terminalState.list"
        :key="t.id"
        class="row"
        :class="{ open: isOpen(t) }"
        :title="`${t.name} — ${t.command}${t.attached ? ` · ${t.attached} attached` : ' · detached'}`"
        @click="attachTerminal(t)"
        @contextmenu="onContextMenu($event, t)"
      >
        <span class="codicon codicon-terminal type-icon" />
        <input
          v-if="renaming === t.id"
          v-model="renameText"
          class="rename"
          @click.stop
          @keydown.enter.prevent="commitRename(t)"
          @keydown.escape.prevent="renaming = null"
          @blur="commitRename(t)"
          @vue:mounted="(vn: { el: HTMLInputElement }) => vn.el.focus()"
        />
        <template v-else>
          <span class="row-name">{{ t.name }}</span>
          <span class="row-desc">{{ t.command }}</span>
          <span class="row-meta">
            <span v-if="t.attached" class="codicon codicon-eye" :title="`${t.attached} attached`" />
            <span class="ago">{{ ago(t.activity) }}</span>
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminals-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.warn-note {
  display: flex;
  gap: 6px;
  padding: 6px 12px;
  color: var(--vscode-errorForeground);
  word-break: break-word;
}
.empty-note {
  padding: 8px 12px;
  color: var(--vscode-descriptionForeground);
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 8px 0 4px;
  white-space: nowrap;
  cursor: pointer;
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row.open .row-name {
  font-weight: 600;
}
.type-icon {
  flex: none;
  font-size: 16px;
  margin-right: 6px;
  color: var(--vscode-icon-foreground);
}
.row-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-desc {
  flex: 0 1000 auto;
  min-width: 0;
  margin-left: 6px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}
.row-meta .codicon {
  font-size: 14px;
}
.rename {
  flex: 1;
  min-width: 0;
  height: 18px;
  font: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-focusBorder);
  outline: none;
  padding: 0 4px;
}
.profiles {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px 0 4px;
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
}
.profile-select {
  flex: 1;
  min-width: 0;
  height: 20px;
  font: inherit;
  font-size: 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  outline: none;
}
.profiles .action {
  flex: none;
  font-size: 16px;
  padding: 2px;
  border-radius: 3px;
  cursor: pointer;
  color: var(--vscode-icon-foreground);
}
.profiles .action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.profiles .action.disabled {
  opacity: 0.4;
  cursor: default;
}
.profiles .action.disabled:hover {
  background: none;
}
.profile-name {
  padding: 2px 8px 4px;
}
</style>
