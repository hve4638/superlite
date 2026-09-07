<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { openQuickInput } from '../model/workbench';
import { openFolder, retryActiveConnection } from '../model/host';
import {
  forgetRecent, groupTitle, openGroup, pinAsGroup, pinIntoGroup, recentName, recents, refreshRecents,
  setGroupAlias, unpinGroup, unpinMember, type PinSource, type RecentEntry,
} from '../model/recents';
import { DND_ROOTS, isRemoteEmpty, remoteHost, sessions } from '../model/sessions';
import { connection, failureLabel, stageLabel } from '../model/watch';
import { loadVersion, shortVersion } from '../model/version';

/** 원격 빈 세션이면 그 host — 접속 상태 줄을 보인다 (로컬 빈 세션은 연결이 없다) */
const host = computed(() => {
  const root = sessions.list.find((t) => t.id === sessions.activeId)?.root ?? null;
  return isRemoteEmpty(root) ? remoteHost(root ?? '') : null;
});
/** attach 전 — 폴더 열기(원격 browseDir)는 빈 목록으로 조용히 실패하므로 막는다 */
const connecting = computed(() => host.value !== null && connection.stage !== null);
const failed = computed(() => host.value !== null && connection.error !== null);
const statusText = computed(() => {
  if (connection.stage !== null) return stageLabel(connection.stage, connection.uploadBytes);
  if (connection.error !== null) return `${failureLabel(connection.failedStage)}: ${connection.error}`;
  return `Connected to ${host.value}`;
});

// 시작 페이지 — 루트 없는 빈 세션의 에디터 영역을 채운다 (ticket app-empty-session).
// 폴더를 열면 이 빈 탭 자리가 워크스페이스 세션으로 교체된다 (host.openFolder 의 replace).

/** 기본 열기 — 경로 입력 퀵인풋 ("Open folder by path", 앱·웹 공통). 앱은 퀵인풋에서
 *  Ctrl+O 를 한 번 더 누르면 OS 다이얼로그로 넘어간다 */
function openDefault(): void {
  openQuickInput('folder');
}

// 목록 (ticket start-page-recents → start-page-redesign) — 표시될 때와 세션 목록이 바뀔 때 다시 읽는다
// (다른 탭에서 폴더를 열어도 이 페이지의 목록이 따라온다). 왼쪽 = 최근 연 폴더 MRU, 오른쪽 = 고정 그룹
onMounted(() => {
  void refreshRecents();
  void loadVersion(); // 하단 버전 표기 (release-versioning) — mock 은 null 이라 비운다
});
watch(() => sessions.list.map((t) => t.root).join('\0'), () => void refreshRecents());
/** rtl 말줄임(경로 꼬리를 남기는 트릭)에서 맨 앞 '/' 가 뒤로 밀리지 않게 하는 LTR 마크 */
const LRM = '\u200E';

function entryTitle(e: RecentEntry): string {
  return e.missing ? `${e.root} (not found)` : e.root;
}
/** 항목 아이콘 — 원격은 remote, 로컬은 folder */
function entryIcon(root: string): string {
  return remoteHost(root) === null ? 'codicon-folder' : 'codicon-remote';
}

// ---- 드래그 (root 묶음, DND_ROOTS) — 출처: Recent 항목·Pinned 그룹/멤버·원격 탐색기 경로. 목적지: Pinned.
// 그룹 카드 위 = 그 그룹에 멤버 추가, 카드 위·아래 가장자리 = 그 앞·뒤에 새 그룹, 빈 곳 = 목록 끝에 새 그룹

type Payload = { roots: string[]; from?: PinSource };
/** 이 페이지에서 시작한 드래그의 출처 — dragover 중엔 dataTransfer 를 읽을 수 없어 따로 든다 */
let dragFrom: PinSource | undefined;
/** 드롭 표시 — 어느 그룹 카드의 어느 자리인지 (column = 빈 곳) */
const over = ref<{ group: number; zone: 'before' | 'into' | 'after'; at?: number } | 'column' | null>(null);

function startDrag(e: DragEvent, roots: string[], from?: PinSource): void {
  if (!e.dataTransfer) return;
  const payload: Payload = from === undefined ? { roots } : { roots, from };
  e.dataTransfer.setData(DND_ROOTS, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'move';
  dragFrom = from;
}
function endDrag(): void {
  dragFrom = undefined;
  over.value = null;
}
function hasRoots(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes(DND_ROOTS) ?? false;
}
function zoneOf(e: DragEvent): 'before' | 'into' | 'after' {
  const el = e.currentTarget as HTMLElement;
  const y = e.clientY - el.getBoundingClientRect().top;
  if (y < el.offsetHeight * 0.25) return 'before';
  if (y > el.offsetHeight * 0.75) return 'after';
  return 'into';
}
function overGroup(e: DragEvent, group: number): void {
  if (!hasRoots(e)) return;
  e.preventDefault();
  e.stopPropagation();
  let zone = zoneOf(e);
  // 자기 그룹 위는 '추가' 가 무의미 — 위·아래 자리만 (멤버를 같은 그룹에 놓는 것도 무동작)
  if (dragFrom?.group === group && zone === 'into') zone = e.clientY < midY(e) ? 'before' : 'after';
  over.value = { group, zone };
}
function midY(e: DragEvent): number {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return r.top + r.height / 2;
}
/** 멤버 줄 위 — 위 절반은 그 앞, 아래 절반은 그 뒤에 삽입 (같은 그룹 안 순서 변경 포함) */
function overMember(e: DragEvent, group: number, index: number): void {
  if (!hasRoots(e)) return;
  if (dragFrom?.group === group && dragFrom.member === undefined) return; // 자기 그룹 안으로는 못 넣는다 — 카드 규칙으로
  e.preventDefault();
  e.stopPropagation();
  over.value = { group, zone: 'into', at: e.clientY < midY(e) ? index : index + 1 };
}
function overColumn(e: DragEvent): void {
  if (!hasRoots(e)) return;
  e.preventDefault();
  over.value = 'column';
}
function payloadOf(e: DragEvent): Payload | null {
  const raw = e.dataTransfer?.getData(DND_ROOTS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Payload;
  } catch {
    return null;
  }
}
function dropOnGroup(e: DragEvent, group: number): void {
  e.preventDefault();
  e.stopPropagation();
  const target = over.value;
  const p = payloadOf(e);
  endDrag();
  if (p === null || target === null || target === 'column') return;
  if (target.zone === 'into') void pinIntoGroup(p.roots, group, p.from, target.at);
  else void pinAsGroup(p.roots, target.zone === 'before' ? group : group + 1, p.from);
}
function dropOnColumn(e: DragEvent): void {
  e.preventDefault();
  const p = payloadOf(e);
  endDrag();
  if (p === null) return;
  void pinAsGroup(p.roots, recents.pinned.length, p.from);
}
function overClass(group: number): Record<string, boolean> {
  const o = over.value;
  const on = o !== null && o !== 'column' && o.group === group;
  return {
    'drop-into': on && o.zone === 'into' && o.at === undefined,
    'drop-before': on && o.zone === 'before',
    'drop-after': on && o.zone === 'after',
  };
}
/** 멤버 줄의 삽입선 — at 가 이 줄 앞이면 위, 마지막 줄 뒤면 아래 */
function memberClass(group: number, index: number, last: boolean): Record<string, boolean> {
  const o = over.value;
  const on = o !== null && o !== 'column' && o.group === group && o.at !== undefined;
  return { 'drop-before': on && o.at === index, 'drop-after': on && last && o.at === index + 1 };
}

// ---- 별칭 인라인 편집 (제목 줄 ✎)

const editing = ref<number | null>(null);
const draft = ref('');
const aliasInput = ref<HTMLInputElement | null>(null);
function beginAlias(group: number): void {
  editing.value = group;
  draft.value = recents.pinned[group]?.alias ?? '';
  void nextTick(() => {
    aliasInput.value?.focus();
    aliasInput.value?.select();
  });
}
function commitAlias(): void {
  const g = editing.value;
  editing.value = null;
  if (g !== null) void setGroupAlias(g, draft.value);
}
function cancelAlias(): void {
  editing.value = null;
}
</script>

<template>
  <div class="start-page">
    <div class="start-title">Superlite</div>
    <div class="start-sub">You have not yet opened a folder.</div>
    <!-- 원격 빈 세션의 접속 상태 — 단계 진행 / 실패 단계(연결 자체 vs 그 뒤) / 완료. 실패는 Retry -->
    <div v-if="host !== null" class="start-status" :class="{ failed, connecting }">
      <span v-if="connecting" class="codicon codicon-loading codicon-modifier-spin" />
      <span v-else-if="failed" class="codicon codicon-error" />
      <span v-else class="codicon codicon-remote" />
      <span>{{ statusText }}</span>
      <button v-if="failed" class="start-retry" @click="retryActiveConnection()">Retry</button>
    </div>
    <button class="start-open" :disabled="connecting" @click="openDefault()">Open Folder…</button>
    <div class="start-recents">
      <div class="recent-col">
        <div class="recent-head">Recent</div>
        <div class="recent-list">
          <div v-if="recents.recents.length === 0" class="recent-empty">No recent folders</div>
          <div
            v-for="e in recents.recents"
            :key="e.root"
            class="recent-row"
            :class="{ missing: e.missing }"
            :title="entryTitle(e)"
            draggable="true"
            @click="openFolder(e.root)"
            @dragstart="startDrag($event, [e.root])"
            @dragend="endDrag()"
          >
            <span class="recent-icon codicon" :class="entryIcon(e.root)" />
            <span class="recent-name">
              {{ recentName(e.root) }}<span v-if="remoteHost(e.root) !== null" class="recent-host"> from {{ remoteHost(e.root) }}</span>
            </span>
            <span class="recent-actions">
              <button class="recent-act codicon codicon-pin" title="Pin" @click.stop="pinAsGroup([e.root], recents.pinned.length)" />
              <button class="recent-act codicon codicon-close" title="Remove from Recent" @click.stop="forgetRecent(e.root)" />
            </span>
            <span class="recent-path">{{ LRM + e.root }}</span>
          </div>
        </div>
      </div>
      <!-- Pinned — 그룹 목록. 컬럼 자체가 드롭 대상(빈 곳 = 목록 끝에 새 그룹), 카드는 자기 자리를 우선한다 -->
      <div
        class="recent-col pinned"
        :class="{ 'drop-column': over === 'column' }"
        @dragover="overColumn($event)"
        @dragleave="over = null"
        @drop="dropOnColumn($event)"
      >
        <div class="recent-head">Pinned</div>
        <div class="recent-list">
          <div v-if="recents.pinned.length === 0" class="recent-empty">No pinned folders — pin or drag from Recent</div>
          <div
            v-for="(g, gi) in recents.pinned"
            :key="gi"
            class="recent-row group"
            :class="[{ missing: g.roots.every((e) => e.missing) }, overClass(gi)]"
            draggable="true"
            @dragstart="startDrag($event, g.roots.map((e) => e.root), { group: gi })"
            @dragend="endDrag()"
            @dragover="overGroup($event, gi)"
            @drop="dropOnGroup($event, gi)"
          >
            <span class="recent-icon codicon codicon-multiple-windows" />
            <input
              v-if="editing === gi"
              :ref="(el) => (aliasInput = el as HTMLInputElement | null)"
              v-model="draft"
              class="alias-input"
              placeholder="Group name"
              @click.stop
              @keydown.enter.prevent="commitAlias()"
              @keydown.esc.prevent="cancelAlias()"
              @blur="commitAlias()"
            />
            <span v-else class="recent-name group-title" title="Open all" @click="openGroup(g.roots.map((e) => e.root))">
              {{ groupTitle(g) }}
            </span>
            <span class="recent-actions">
              <button class="recent-act codicon codicon-edit" title="Rename" @click.stop="beginAlias(gi)" />
              <button class="recent-act codicon codicon-close" title="Unpin group" @click.stop="unpinGroup(gi)" />
            </span>
            <div
              v-for="(e, mi) in g.roots"
              :key="e.root"
              class="group-item"
              :class="[{ missing: e.missing }, memberClass(gi, mi, mi === g.roots.length - 1)]"
              :title="entryTitle(e)"
              draggable="true"
              @click.stop="openFolder(e.root)"
              @dragstart.stop="startDrag($event, [e.root], { group: gi, member: e.root })"
              @dragend.stop="endDrag()"
              @dragover="overMember($event, gi, mi)"
            >
              <span class="group-name">
                {{ recentName(e.root) }}<span v-if="remoteHost(e.root) !== null" class="recent-host"> from {{ remoteHost(e.root) }}</span>
              </span>
              <span class="recent-path">{{ LRM + e.root }}</span>
              <button class="recent-act codicon codicon-close" title="Remove from group" @click.stop="unpinMember(gi, e.root)" />
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="start-hints">
      <div class="hint-row">
        <span class="hint-label">Open folder by path</span>
        <span class="hint-key">Ctrl+O</span>
      </div>
    </div>
    <div v-if="shortVersion() !== null" class="start-version" title="Help: About (command palette)">{{ shortVersion() }}</div>
  </div>
</template>

<style scoped>
.start-page {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  user-select: none;
}
.start-title {
  font-size: 34px;
  font-weight: 300;
  letter-spacing: 1px;
  color: var(--vscode-titleBar-inactiveForeground);
}
.start-sub {
  font-size: 13px;
  opacity: 0.7;
  margin-bottom: 14px;
}
.start-open {
  padding: 6px 18px;
  border: none;
  border-radius: 2px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  font-size: 13px;
  cursor: pointer;
}
.start-status {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 520px;
  font-size: 12px;
  opacity: 0.85;
  margin-bottom: 4px;
}
.start-status > span:not(.codicon) {
  overflow-wrap: anywhere;
}
.start-status .codicon {
  flex: none;
}
.start-status.failed {
  color: var(--vscode-errorForeground, #f48771);
}
.start-retry {
  margin-left: 6px;
  padding: 2px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  font-size: 12px;
  cursor: pointer;
}
.start-open:disabled {
  opacity: 0.5;
  cursor: default;
}
.start-open:hover {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.start-recents {
  margin-top: 18px;
  display: grid;
  grid-template-columns: minmax(220px, 340px) minmax(220px, 340px);
  gap: 28px;
  max-width: 760px;
  width: min(760px, 90%);
}
.recent-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: 4px;
}
.recent-col.pinned.drop-column {
  outline: 1px dashed var(--vscode-focusBorder, #007fd4);
  outline-offset: 4px;
}
.recent-head {
  font-size: 15px;
  font-weight: 300;
  margin-bottom: 6px;
  color: var(--vscode-titleBar-inactiveForeground);
}
/* 목록이 길면 컬럼 안에서 스크롤 — 얇은 스크롤바, 컬럼에 마우스를 올렸을 때만 보인다 */
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: min(420px, 55vh);
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  scrollbar-gutter: stable;
}
.recent-list::-webkit-scrollbar {
  width: 6px;
}
.recent-list::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
}
.recent-col:hover .recent-list::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
}
.recent-list::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
.recent-empty {
  font-size: 12px;
  opacity: 0.55;
}
.recent-row {
  position: relative;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  grid-template-rows: auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 2px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}
.recent-row:hover {
  background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
}
.recent-row.group {
  cursor: default;
}
.recent-row.group.drop-into {
  background: var(--vscode-list-dropBackground, rgba(83, 89, 93, 0.5));
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
}
.recent-row.group.drop-before::before,
.recent-row.group.drop-after::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: var(--vscode-focusBorder, #007fd4);
}
.recent-row.group.drop-before::before {
  top: -3px;
}
.recent-row.group.drop-after::after {
  bottom: -3px;
}
/* 멤버 줄 사이 삽입선 */
.group-item {
  position: relative;
}
.group-item.drop-before::before,
.group-item.drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 4px;
  height: 2px;
  background: var(--vscode-focusBorder, #007fd4);
}
.group-item.drop-before::before {
  top: -2px;
}
.group-item.drop-after::after {
  bottom: -2px;
}
.recent-row.missing,
.group-item.missing {
  opacity: 0.45;
}
.recent-icon {
  font-size: 16px;
  opacity: 0.8;
}
.recent-name {
  color: var(--vscode-textLink-foreground, #3794ff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-title {
  cursor: pointer;
}
.group-title:hover {
  text-decoration: underline;
}
.recent-host {
  color: var(--vscode-foreground);
  opacity: 0.45;
}
.recent-path {
  grid-column: 2;
  font-size: 11px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.alias-input {
  min-width: 0;
  padding: 0 4px;
  border: 1px solid var(--vscode-focusBorder, #007fd4);
  border-radius: 2px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, inherit);
  font: inherit;
  outline: none;
}
/* 그룹의 멤버 줄 — 이름과 경로를 나란히 (이름은 내용폭, 경로가 남은 폭에서 꼬리를 남기며 줄임), 끝에 × */
.group-item {
  grid-column: 2 / 4;
  display: grid;
  grid-template-columns: minmax(0, max-content) minmax(0, 1fr) 16px;
  gap: 8px;
  align-items: center;
  padding: 1px 4px 1px 0;
  border-radius: 3px;
  font-size: 12px;
  cursor: pointer;
}
.group-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
}
/* 멤버 하나만 열린다는 표시 — 제목 hover 와 같은 밑줄 */
.group-item:hover .group-name {
  text-decoration: underline;
}
.group-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-item .recent-path {
  grid-column: auto;
}
.recent-actions {
  display: flex;
  gap: 2px;
}
.recent-act {
  visibility: hidden;
  border: none;
  background: none;
  color: inherit;
  font-size: 14px;
  padding: 0;
  cursor: pointer;
  opacity: 0.7;
}
.recent-row:hover > .recent-actions .recent-act,
.group-item:hover > .recent-act {
  visibility: visible;
}
.recent-act:hover {
  opacity: 1;
}
.start-hints {
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  opacity: 0.75;
}
.hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.start-version {
  position: absolute;
  right: 12px;
  bottom: 8px;
  font-size: 11px;
  opacity: 0.55;
}
.hint-key {
  padding: 1px 6px;
  border: 1px solid var(--vscode-tab-border);
  border-radius: 3px;
  background: var(--vscode-tab-activeBackground);
  font-family: monospace;
  font-size: 11px;
}
</style>
