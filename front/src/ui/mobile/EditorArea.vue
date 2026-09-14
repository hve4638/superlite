<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Tab } from '../../model/editors';
import { activeGroup, closeTab, editors, saveActive, setActiveTab } from '../../model/editors';
import TerminalPane from './TerminalPane.vue';
import EditorPane from './EditorPane.vue';
import DiffPane from './DiffPane.vue';
import FullscreenButton from './FullscreenButton.vue';

// 편집기 영역 (ticket mobile-shell, 사용자 결정 2026-09-14: 세션 탭은 빼도 편집기 탭은 있어야 한다) — 데스크톱의 편집기 영역에
// 해당한다. 헤더 대신 맨 위 한 줄(사용자 결정 2026-09-15): 왼쪽은 활성 그룹(모바일은 그룹 분할이 없어 하나)의 탭 전부를 가로
// 스크롤로, 오른쪽은 고정 폭 동작 아이콘(저장 — 파일 탭일 때, 전체화면). 탭이 많아져도 탭 영역 안에서만 스크롤되고 아이콘
// 영역을 넘지 않는다. 본문은 활성 탭의 종류별 pane(터미널·파일·diff). 탭 목록·활성 탭·닫기는 전부 model/editors 라 데스크톱과
// 같은 규칙이다 — × 는 closeTab 그대로 (미저장 확인 대화상자 포함, 터미널 탭은 detach). 카드는 그리지 않는다 (모바일은 at: {} 로
// 붙여 카드가 생기지 않는다)
const group = computed(() => activeGroup());
const tabs = computed(() => group.value.tabs);
const active = computed<Tab | null>(() => tabs.value.find((t) => t.id === group.value.activeTabId) ?? null);
const strip = ref<HTMLElement | null>(null);

const doc = computed(() => (active.value?.kind === 'file' ? editors.docs.get(active.value.path) : undefined));
const canSave = computed(() => doc.value !== undefined && doc.value.content !== doc.value.savedContent && doc.value.readOnly !== true);

function select(t: Tab): void {
  if (t.id !== group.value.activeTabId) setActiveTab(group.value.id, t.id);
}
function close(t: Tab): void {
  closeTab(group.value.id, t.id);
}
watch(
  () => group.value.activeTabId,
  () => void nextTick(() => strip.value?.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest' })),
  { immediate: true },
);
</script>

<template>
  <div class="m-screen">
    <div class="strip">
      <div ref="strip" class="tabs">
        <div v-for="t in tabs" :key="t.id" class="tab" :class="{ active: t.id === group.activeTabId, preview: t.preview }" @click="select(t)">
          <span v-if="t.kind === 'terminal'" class="codicon codicon-terminal kind" />
          <span class="label">{{ t.name }}</span>
          <button class="close" :class="{ dirty: t.dirty }" @click.stop="close(t)"><span class="codicon" :class="t.dirty ? 'codicon-circle-filled' : 'codicon-close'" /></button>
        </div>
      </div>
      <div class="actions">
        <button v-if="active?.kind === 'file'" class="m-icon-btn" :disabled="!canSave" title="Save" @click="saveActive()"><span class="codicon codicon-save" /></button>
        <FullscreenButton />
      </div>
    </div>
    <div v-if="!active" class="m-empty">No open tabs<br /><span class="hint">Pick a file, session or change from the tabs below</span></div>
    <TerminalPane v-else-if="active.kind === 'terminal'" :key="active.id" :term="active.term" />
    <EditorPane v-else-if="active.kind === 'file'" :path="active.path" />
    <DiffPane v-else-if="active.kind === 'diff'" :key="active.id" :tab="active" />
    <div v-else class="m-empty">{{ active.name }}<br /><span class="hint">This tab type is not available on mobile</span></div>
  </div>
</template>

<style scoped>
.hint {
  font-size: 13px;
  opacity: 0.7;
}
.strip {
  display: flex;
  align-items: stretch;
  height: 40px;
  flex-shrink: 0;
  background: var(--vscode-editorGroupHeader-tabsBackground, #181818);
  border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #2b2b2b);
}
.tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow-x: auto;
  scrollbar-width: none;
}
.actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 2px;
  border-left: 1px solid var(--vscode-tab-border, #2b2b2b);
}
.actions .m-icon-btn {
  width: 40px;
  height: 40px;
}
.tabs::-webkit-scrollbar {
  display: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  padding-left: 12px;
  flex-shrink: 0;
  max-width: 60vw;
  font-size: 13px;
  color: var(--vscode-tab-inactiveForeground, #9d9d9d);
  border-right: 1px solid var(--vscode-tab-border, #2b2b2b);
}
.tab.active {
  color: var(--vscode-tab-activeForeground, #fff);
  background: var(--vscode-tab-activeBackground, #1f1f1f);
  box-shadow: inset 0 1px 0 var(--sl-accent, #3794ff);
}
.tab.preview .label {
  font-style: italic;
}
.tab .kind {
  font-size: 14px;
  margin-right: 4px;
}
.tab .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab .close {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tab .close .codicon {
  font-size: 16px;
}
.tab .close.dirty .codicon {
  font-size: 10px;
  color: var(--sl-accent, #3794ff);
}
</style>
