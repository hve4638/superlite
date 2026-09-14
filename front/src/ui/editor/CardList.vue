<script setup lang="ts">
import type { Tab } from '../../model/editors';
import { closeCard, editors, setActiveCard } from '../../model/editors';
import { requestKillTerminal, terminals } from '../../model/terminal';
import { instanceDot } from '../../model/agent';
import FileIcon from '../widgets/FileIcon.vue';
import TerminalBadge from './TerminalBadge.vue';

// 카드가 있는 탭의 오른쪽 세로 목록 (ticket terminal-tab-panes) — 첫 항목은 탭 자신(닫기 없음, 탭 × 로만), 그 아래 카드들.
// 카드 추가 진입점은 팔레트뿐(Tab: New Terminal Card) — 여기엔 선택·닫기만 있다
const props = defineProps<{ tab: Tab & { cards: NonNullable<Tab['cards']> }; groupId: number }>();

function iconName(t: Tab): string {
  return t.path.slice(t.path.lastIndexOf('/') + 1);
}
// 터미널 카드의 Ctrl+닫기는 탭바와 같이 강제 종료 (tmux 세션 kill 확인)
function onClose(card: Tab, e: MouseEvent) {
  if (card.kind === 'terminal' && e.ctrlKey && terminals.list.some((t) => t.id === card.term && t.tmux !== undefined)) {
    requestKillTerminal(card.term);
    return;
  }
  closeCard(props.groupId, props.tab.id, card.id);
}
</script>

<template>
  <div class="card-list">
    <div
      v-for="(item, i) in [tab, ...tab.cards.tabs]"
      :key="i === 0 ? '' : item.id"
      class="card"
      :class="{ active: i === 0 ? tab.cards.activeTabId === null : item.id === tab.cards.activeTabId, dirty: item.dirty, orphaned: editors.orphaned.has(item.path) }"
      :title="item.path || item.name"
      @click="setActiveCard(groupId, tab.id, i === 0 ? null : item.id)"
      @mousedown.middle.prevent="i > 0 && onClose(item, $event)"
    >
      <span v-if="item.kind === 'terminal'" class="codicon codicon-terminal card-icon" />
      <span v-else-if="item.kind === 'folder'" class="codicon codicon-folder card-icon" />
      <FileIcon v-else :name="iconName(item)" />
      <span class="card-label">{{ item.name }}</span>
      <TerminalBadge v-if="item.kind === 'terminal'" :inst="terminals.list.find((t) => t.id === item.term)" :dot="instanceDot(item.term)" />
      <span v-if="i > 0" class="card-close" title="Close" @click.stop="onClose(item, $event)">
        <span class="codicon" :class="item.dirty ? 'codicon-circle-filled' : 'codicon-close'" />
      </span>
    </div>
  </div>
</template>

<style scoped>
/* VS Code 터미널 패널의 오른쪽 탭 목록을 닮는다 — 고정 폭, 22px 행 */
.card-list {
  width: 160px;
  flex-shrink: 0;
  overflow-y: auto;
  border-left: 1px solid var(--vscode-editorGroup-border);
  background: var(--vscode-sideBar-background);
  color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
  padding: 4px 0;
}
.card {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 4px 0 8px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.card:hover {
  background: var(--vscode-list-hoverBackground);
}
.card.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.card.orphaned .card-label {
  text-decoration: line-through;
}
.card-icon {
  margin-right: 6px;
  font-size: 14px;
}
.card :deep(.file-icon) {
  margin-right: 6px;
}
.card-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-close {
  display: none;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 16px;
}
.card:hover .card-close,
.card.dirty .card-close {
  display: inline-flex;
}
.card-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
</style>
