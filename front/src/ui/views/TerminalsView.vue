<script setup lang="ts">
// 사이드바 터미널 뷰 (ticket term-list-reconnect) — 이 워크스페이스의 살아 있는 tmux 세션 목록.
// 행 클릭 = 탭으로 열기(이미 열려 있으면 그 탭 앞으로), 우클릭 = 새 탭으로·이름 바꾸기·종료.
// 데몬이 tmux 를 못 써 plain 으로 동작 중이면 위에 사유를 보인다. 설정 톱니(제목 액션)로 클라이언트
// tmux.conf 편집 영역을 토글 — 저장하면 접속 중인 모든 데몬에 즉시 적용된다
import { onMounted, onUnmounted, ref } from 'vue';
import type { TerminalInfo } from '../../backend/types';
import {
  terminalState, terminals, refreshTerminals, attachTerminal, killListedTerminal, renameListedTerminal,
  loadTmuxConf, saveTmuxConf,
} from '../../model/terminal';
import { openContextMenu } from '../../model/workbench';
import { errText, notify } from '../../model/notifications';

// 목록은 tmux 서버가 원장 — 뷰가 보이는 동안 3초마다 다시 읽는다 (다른 창·PC 의 attach 수, 실행 중
// 명령 변화). 열기·닫기·종료는 즉시 갱신한다 (model)
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void refreshTerminals();
  timer = setInterval(() => void refreshTerminals(), 3000);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
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

// ---- tmux.conf 편집 (제목 액션 톱니로 토글)
const confOpen = ref(false);
const confText = ref('');
const confSaving = ref(false);
async function toggleConf(): Promise<void> {
  confOpen.value = !confOpen.value;
  if (!confOpen.value) return;
  try {
    confText.value = await loadTmuxConf();
  } catch (e) {
    notify('error', `tmux.conf: ${errText(e)}`);
  }
}
async function saveConf(): Promise<void> {
  confSaving.value = true;
  try {
    await saveTmuxConf(confText.value);
    notify('info', 'tmux.conf saved and applied');
  } catch (e) {
    notify('error', `tmux.conf: ${errText(e)}`);
  } finally {
    confSaving.value = false;
  }
}
defineExpose({ toggleConf });
</script>

<template>
  <div class="terminals-view">
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
    <section v-if="confOpen" class="conf">
      <div class="pane-header">
        <span class="pane-title">tmux.conf</span>
        <button class="save" :disabled="confSaving" @click="void saveConf()">Save</button>
      </div>
      <textarea v-model="confText" class="conf-text" spellcheck="false" placeholder="# 사용자 tmux 설정 — 내장 기본값(base.conf) 뒤에 적용된다" />
    </section>
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
  color: var(--vscode-errorForeground, #f14c4c);
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
.conf {
  flex: none;
  display: flex;
  flex-direction: column;
  height: 45%;
  min-height: 120px;
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
}
.pane-header {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: bold;
  text-transform: uppercase;
  background: var(--vscode-sideBarSectionHeader-background);
}
.save {
  margin-left: auto;
  font: inherit;
  font-size: 11px;
  padding: 1px 8px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 2px;
  cursor: pointer;
}
.save:disabled {
  opacity: 0.6;
}
.conf-text {
  flex: 1;
  min-height: 0;
  resize: none;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: none;
  outline: none;
  padding: 6px 8px;
}
</style>
