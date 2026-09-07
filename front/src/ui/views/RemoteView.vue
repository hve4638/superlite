<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  remote, refreshHosts, connectHost, openRecent, setHostState, setHostExpanded, setPaneOpen, type RemoteHost,
} from '../../model/remote';
import { openContextMenu, type ContextMenuItem } from '../../model/workbench';
import { DND_ROOTS, sessions } from '../../model/sessions';
import Sash from '../widgets/Sash.vue';

// 뷰를 보일 때마다 다시 읽는다 — 최근 폴더는 relay 가 attach 시 기록하므로 목록이 뒤처진다.
// 뷰가 열린 채로 원격 폴더가 열리는 경우는 세션 탭 변화로 잡는다: 탭 이름은 워크스페이스
// 정보가 온 뒤(= attach 응답·최근 기록 이후) 채워지므로 root|name 변화가 곧 갱신 시점
onMounted(() => void refreshHosts());
watch(
  () => sessions.list.map((t) => `${t.root}|${t.name}`).join('\n'),
  () => void refreshHosts(),
);

type Pane = 'favorite' | 'all';

// ALL pane 높이 — FAVORITE 도 열려 있을 때만 의미 (아니면 ALL 이 남은 공간을 다 쓴다).
// 세션 중에만 유지 (VS Code 도 뷰 pane 크기는 창 상태). 접힘은 전역 지속 (remote.panes)
const allHeight = ref(160);
const ALL_MIN = 44;
let allStart = 0;
function resizeAll(dy: number) {
  // 위쪽 경계를 끄므로 위로(dy<0) 갈수록 커진다
  allHeight.value = Math.max(ALL_MIN, allStart - dy);
}

// 펼친 호스트(최근 폴더 표시) — 호스트별 지속 (remote.collapsed, 기본 펼침). 같은 host 가 두 pane 에
// 있으면 함께 움직인다
function recentOf(h: RemoteHost): string[] {
  return remote.recent[h.name] ?? [];
}
/** 경로 아이템을 시작 페이지 Pinned 로 끌어 넣기 (ticket start-page-redesign) — 이 목록에는 그대로 남는다 */
function dragRecent(e: DragEvent, h: RemoteHost, p: string): void {
  e.dataTransfer?.setData(DND_ROOTS, JSON.stringify({ roots: [`ssh://${h.name}${p}`] }));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
}
function isExpanded(h: RemoteHost): boolean {
  return !remote.collapsed.includes(h.name);
}
function toggleHost(pane: Pane, h: RemoteHost): void {
  selected.value = `${pane}:${h.name}`;
  if (recentOf(h).length === 0) return;
  setHostExpanded(h.name, !isExpanded(h));
}

// 선택된 행 (호스트 또는 최근 폴더) — 클릭은 선택만, 접속은 hover 액션으로 (VS Code Remote Explorer)
const selected = ref<string | null>(null);
function recentKey(pane: Pane, h: RemoteHost, p: string): string {
  return `${pane}:${h.name}:${p}`;
}

function menuFor(pane: Pane, h: RemoteHost): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    h.favorite
      ? { label: '즐겨찾기 제거', run: () => void setHostState('unfav', h.name) }
      : { label: '즐겨찾기 추가', run: () => void setHostState('fav', h.name) },
  ];
  // 고정(fix)은 즐겨찾기에서만 (사용자 결정) — ALL 의 즐겨찾기 항목도 FAVORITE 쪽에서 다룬다
  if (pane === 'favorite') {
    items.push(
      h.pinned
        ? { label: '고정 해제', run: () => void setHostState('unpin', h.name) }
        : { label: '상태 고정 (F)', key: 'f', enabled: !h.missing, run: () => void setHostState('pin', h.name) },
    );
    if (h.drift) {
      items.push(
        { separator: true },
        { label: '이 경고 숨김', run: () => void setHostState('ack', h.name) },
        { label: '최신 상태로 갱신', run: () => void setHostState('refresh', h.name) },
      );
    }
  }
  return items;
}

function onRowContextMenu(e: MouseEvent, pane: Pane, h: RemoteHost): void {
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, menuFor(pane, h));
}

function onRecentContextMenu(e: MouseEvent, h: RemoteHost, path: string): void {
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, [
    { label: '최근 목록에서 제거', run: () => void setHostState('forget', h.name, { path }) },
  ]);
}

function rowTitle(h: RemoteHost): string {
  if (h.missing) return `${h.name} — ~/.ssh/config 에 없습니다`;
  return h.drift ? `${h.name} — 고정 저장본이 ~/.ssh/config 와 다릅니다` : h.name;
}

function iconOf(pane: Pane, h: RemoteHost): string {
  if (h.pinned) return 'codicon-pinned';
  if (pane === 'all' && h.favorite) return 'codicon-star-full';
  return 'codicon-vm';
}

function basename(path: string): string {
  return path.split('/').filter((s) => s !== '').pop() ?? path;
}
</script>

<template>
  <div class="remote-view">
    <div v-if="remote.error" class="empty-note">{{ remote.error }}</div>
    <!-- 두 pane (SCM 의 GRAPH 와 같은 섹션 헤더). FAVORITE 가 남은 공간, ALL 은 위 경계 sash 로
         높이 조절 — FAVORITE 가 닫히면 ALL 이 남은 공간을 쓴다 -->
    <section
      v-for="pane in (['favorite', 'all'] as Pane[])"
      :key="pane"
      class="pane"
      :class="{ open: remote.panes[pane], fill: pane === 'favorite' || !remote.panes.favorite }"
      :style="pane === 'all' && remote.panes.all && remote.panes.favorite ? { height: `${allHeight}px` } : undefined"
    >
      <Sash
        v-if="pane === 'all' && remote.panes.all && remote.panes.favorite"
        direction="horizontal"
        class="all-sash"
        @dragstart="allStart = allHeight"
        @resize="resizeAll"
      />
      <div class="pane-header" @click="setPaneOpen(pane, !remote.panes[pane])">
        <span class="twisty codicon" :class="remote.panes[pane] ? 'codicon-chevron-down' : 'codicon-chevron-right'" />
        <span class="pane-title">{{ pane }}</span>
        <span v-if="(pane === 'favorite' ? remote.favorites : remote.all).length" class="pane-count">
          {{ (pane === 'favorite' ? remote.favorites : remote.all).length }}
        </span>
      </div>
      <div v-if="remote.panes[pane]" class="pane-body">
        <div v-if="pane === 'favorite' && remote.favorites.length === 0" class="empty-note">
          No favorites. Right-click a host in ALL to add one.
        </div>
        <div v-else-if="pane === 'all' && remote.loaded && remote.all.length === 0" class="empty-note">
          No hosts in ~/.ssh/config on the backend machine.
        </div>
        <template v-for="h in pane === 'favorite' ? remote.favorites : remote.all" :key="h.name">
          <div
            class="row"
            :class="{ drift: h.drift || h.missing, selected: selected === `${pane}:${h.name}` }"
            :title="rowTitle(h)"
            @click="toggleHost(pane, h)"
            @contextmenu="onRowContextMenu($event, pane, h)"
          >
            <span
              class="twistie codicon"
              :class="recentOf(h).length ? (isExpanded(h) ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''"
            />
            <span class="codicon type-icon" :class="iconOf(pane, h)" />
            <span class="row-name">{{ h.name }}</span>
            <!-- VS Code Remote-SSH 관례: arrow-right = 현재 창(탭)에 연결, empty-window = 새 창(탭) -->
            <div v-if="!h.missing" class="row-actions">
              <span
                class="action codicon codicon-arrow-right"
                title="Connect in Current Tab"
                @click.stop="connectHost(h.name, 'replace')"
              />
              <span
                class="action codicon codicon-empty-window"
                title="Connect in New Tab"
                @click.stop="connectHost(h.name, 'new')"
              />
            </div>
          </div>
          <!-- 최근 연 폴더 (VS Code Remote Explorer 의 호스트 하위 항목) — 클릭은 선택, 접속은 호스트 행과
               같은 hover 액션 (→ 현재 탭 대체 / 새 탭) -->
          <template v-if="isExpanded(h)">
            <div
              v-for="p in recentOf(h)"
              :key="p"
              class="row recent"
              :class="{ selected: selected === recentKey(pane, h, p) }"
              :title="p"
              draggable="true"
              @click.stop="selected = recentKey(pane, h, p)"
              @contextmenu="onRecentContextMenu($event, h, p)"
              @dragstart="dragRecent($event, h, p)"
            >
              <span class="codicon type-icon codicon-folder" />
              <span class="row-name">{{ basename(p) }}</span>
              <span class="row-desc">{{ p }}</span>
              <div class="row-actions">
                <span
                  class="action codicon codicon-arrow-right"
                  title="Open in Current Tab"
                  @click.stop="openRecent(h.name, p, 'replace')"
                />
                <span
                  class="action codicon codicon-empty-window"
                  title="Open in New Tab"
                  @click.stop="openRecent(h.name, p, 'new')"
                />
              </div>
            </div>
          </template>
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.remote-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.empty-note {
  padding: 8px 12px;
  color: var(--vscode-descriptionForeground);
  word-break: break-all;
}
.row {
  display: flex;
  align-items: center;
  height: 22px;
  padding-left: 4px;
  white-space: nowrap;
  cursor: pointer;
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.row.selected {
  background: var(--vscode-list-inactiveSelectionBackground);
}
/* drift·missing: 고정 저장본이 현재 config 와 다름 / config 에 없음 */
.row.drift .row-name {
  font-style: italic;
  color: var(--vscode-descriptionForeground);
}
.row.recent {
  padding-left: 28px;
}
.twistie {
  flex: none;
  width: 16px;
  font-size: 16px;
  margin-right: 2px;
  color: var(--vscode-icon-foreground);
}
.type-icon {
  flex: none;
  font-size: 16px;
  margin-right: 6px;
  color: var(--vscode-icon-foreground);
}
/* 이름이 우선, 경로 설명이 먼저 줄어든다 (flex-shrink 가중치) — 좁은 사이드바에서 폴더 이름이
   잘리던 것을 완화 (remote-explorer-polish 4) */
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
.row-actions {
  display: none;
  margin-left: auto;
  margin-right: 6px;
  align-items: center;
  flex: none;
}
.row:hover .row-actions {
  display: flex;
}
.action {
  font-size: 16px;
  padding: 2px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--vscode-icon-foreground);
}
.action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* ── pane (ScmView 의 pane 헤더 규격: 22px / 11px bold uppercase) ── */
.pane {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.pane.open.fill {
  flex: 1;
}
.all-sash {
  top: -2px;
}
.pane-header {
  flex: none;
  height: 22px;
  display: flex;
  align-items: center;
  padding-left: 2px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
  background: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarSectionHeader-foreground);
}
.pane:first-of-type .pane-header {
  border-top: none;
}
.pane-header .twisty {
  font-size: 16px;
  margin: 0 2px;
}
.pane-title {
  margin-left: 2px;
  text-transform: uppercase;
  white-space: nowrap;
}
.pane-count {
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 400;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.pane-body {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
</style>
