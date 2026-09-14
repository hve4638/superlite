<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { TerminalInfo } from '../../backend/types';
import { listedDot } from '../../model/agent';
import { attachTerminal, createTerminal, killListedTerminal, refreshTerminals, terminalState } from '../../model/terminal';
import { confirm } from '../../model/dialog';
import { workbench } from '../../model/workbench';
import { connection } from '../../model/watch';
import TerminalBadge from '../editor/TerminalBadge.vue';
import { goTo } from './nav';
import FullscreenButton from './FullscreenButton.vue';

// 세션 탭 — 이 워크스페이스의 살아 있는 tmux 세션 (model 이 3초마다 갱신). 탭하면 붙어서 Editor 탭의 터미널 탭으로.
// 에이전트 상태 점은 데스크톱 사이드바와 같은 TerminalBadge (model/agent 의 listedDot)
onMounted(() => void refreshTerminals());
const list = computed(() => [...terminalState.list].sort((a, b) => b.activity - a.activity));
function agentLabel(t: TerminalInfo): string {
  const a = t.agent;
  if (!a || a.state === 'exited' || a.state === 'unknown') return t.command;
  const state = a.state === 'needsInput' ? 'needs input' : a.state;
  return `${a.agent} · ${state}${a.detail.message ? ` · ${a.detail.message}` : ''}`;
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
// at: {} — 카드 배치(cardPlaceFor)를 거치지 않고 편집기 영역의 탭으로 (모바일 탭 줄은 카드를 그리지 않는다).
// 이미 열려 있으면 model 이 그 탭을 앞으로 세운다
function open(info: TerminalInfo): void {
  if (attachTerminal(info, { at: {} })) goTo('editor');
}
// 새 터미널 = 이 워크스페이스에 tmux 세션 하나 (데스크톱 createTerminal 그대로) → Editor 의 터미널 탭
function create(): void {
  createTerminal({});
  goTo('editor');
}
// 행의 휴지통 = tmux 세션 종료 (데스크톱 사이드바의 Kill Terminal). Editor 탭의 × 는 detach 만이라 종료는 여기서만.
// 터치라 오조작이 쉬워 확인을 한 번 거친다 (사용자 결정 2026-09-15)
async function kill(t: TerminalInfo): Promise<void> {
  const c = await confirm({ message: `Kill terminal '${t.name}'?`, detail: 'The tmux session and its processes will be terminated.', confirmLabel: 'Kill' });
  if (c === 'confirm') await killListedTerminal(t.id);
}
</script>

<template>
  <div class="m-screen">
    <header class="m-header">
      <span class="codicon codicon-terminal" />
      <span class="title">{{ workbench.workspaceName || 'Superlite' }} <span class="sub">{{ workbench.rootPath }}</span></span>
      <button class="m-icon-btn" title="New terminal" @click="create"><span class="codicon codicon-add" /></button>
      <button class="m-icon-btn" title="Refresh" @click="refreshTerminals()"><span class="codicon codicon-refresh" /></button>
      <FullscreenButton />
    </header>
    <div v-if="!connection.ok" class="m-banner"><span class="msg">{{ connection.error ?? 'Reconnecting…' }}</span></div>
    <div v-else-if="terminalState.mode === 'plain' || terminalState.mode === 'unsupported'" class="m-banner">
      <span class="msg">tmux unavailable — {{ terminalState.error ?? 'no session list' }}</span>
    </div>
    <div class="m-list">
      <div v-if="list.length === 0" class="m-empty">No terminal sessions</div>
      <div v-for="t in list" :key="t.id" class="m-row" :class="{ card: t.host }" @click="open(t)">
        <TerminalBadge :dot="listedDot(t.id)" class="big" />
        <div class="main">
          <div class="name">{{ t.name }}</div>
          <div class="meta">{{ agentLabel(t) }}</div>
        </div>
        <div class="meta right">
          <span v-if="t.attached > 0" class="codicon codicon-eye" :title="`${t.attached} attached`" />
          {{ ago(t.activity) }}
        </div>
        <button class="m-icon-btn kill" title="Kill terminal" @click.stop="kill(t)"><span class="codicon codicon-trash" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.m-row.card {
  padding-left: 28px;
}
.big :deep(.dot) {
  width: 11px;
  height: 11px;
}
.big :deep(.term-badge) {
  margin: 0;
  width: 14px;
  justify-content: center;
}
.right {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.m-row .kill {
  color: var(--vscode-foreground);
  opacity: 0.6;
}
</style>
