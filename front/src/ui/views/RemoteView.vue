<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import {
  remote, refreshHosts, connectHost, openRecent, openGroup, setHostState, setHostExpanded, setPaneOpen, isGroup,
  togglePin, forgetItem, setGroupAlias, dropItems, type RemoteHost, type RemoteItem, type ItemSource, type ItemTarget,
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

// 펼친 호스트(경로 아이템 표시) — 호스트별 지속 (remote.collapsed, 기본 펼침). 같은 host 가 두 pane 에
// 있으면 함께 움직인다
function itemsOf(h: RemoteHost): RemoteItem[] {
  return remote.items[h.name] ?? [];
}
function isExpanded(h: RemoteHost): boolean {
  return !remote.collapsed.includes(h.name);
}
function toggleHost(pane: Pane, h: RemoteHost): void {
  selected.value = `${pane}:${h.name}`;
  if (itemsOf(h).length === 0) return;
  setHostExpanded(h.name, !isExpanded(h));
}

// 선택된 행 (호스트 또는 경로 아이템) — 클릭은 선택만, 접속은 hover 액션으로 (VS Code Remote Explorer)
const selected = ref<string | null>(null);
function recentKey(pane: Pane, h: RemoteHost, p: string): string {
  return `${pane}:${h.name}:${p}`;
}

// ---- 경로 아이템 DnD (ticket remote-path-items) — 출처: 이 목록의 단일 아이템·그룹 멤버 (같은 host 안에서만
// 이동·복사), 시작 페이지 Pinned 의 원격 경로(복사와 같다). 목적지: 이 목록의 자리 또는 시작 페이지 Pinned
// (DND_ROOTS — 거기서는 복사). dataTransfer 에는 roots 만 싣고(시작 페이지의 from 과 섞이지 않게) 출처는
// 모듈 변수로 든다.
// 자리 판정은 카드마다가 아니라 pane-body 하나에서 포인터 Y 로 한다 (2026-09-08 개정 — 카드별 핸들러는 카드
// 사이 틈·그룹 여백·제목줄에서 판정이 빠져 "맨 뒤" 로 튀고, 그룹 안·밖 경계가 카드 안에서 갈려 순서가 오락가락
// 했다). 위에서 아래로 한 방향으로만 바뀌는 자리 순서: [아이템 앞] [단일: 가운데 = 그룹 만들기 | 그룹: 그룹 앞 →
// 멤버 사이 자리들 → 그룹 뒤] [아이템 뒤] … 카드 사이 틈은 반으로 갈라 위·아래 카드에 나눠 준다. 그룹의 제목줄·
// 위 여백 + 첫 멤버 위 1/3 = 그룹 앞, 끝 멤버 아래 1/3 + 아래 여백 = 그룹 뒤. 목록 아래 빈 공간 = 맨 뒤. Ctrl = 복사.

let dragSrc: { host: string; src: ItemSource } | null = null;
/** 드롭 표시 — 어느 host 의 어느 자리인지 */
const over = ref<{ host: string; target: ItemTarget } | null>(null);
/** 카드 바깥 여백 — 첫 카드 위·끝 카드 아래로 이만큼까지는 그 목록으로 본다 (CSS 의 카드 margin 과 같은 값) */
const GAP = 5;

function startDrag(e: DragEvent, h: RemoteHost, paths: string[], src: ItemSource): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DND_ROOTS, JSON.stringify({ roots: paths.map((p) => `ssh://${h.name}${p}`) }));
  e.dataTransfer.effectAllowed = 'copyMove';
  dragSrc = { host: h.name, src };
}
function endDrag(): void {
  dragSrc = null;
  over.value = null;
}
function hasRoots(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes(DND_ROOTS) ?? false;
}
/** 아이템 요소 하나 안에서의 자리 — 단일은 위·아래 1/4 = 앞·뒤, 가운데 = 그룹 만들기(자기 자신이면 위·아래 절반).
 *  그룹은 위에서부터 그룹 앞 → 멤버 i 앞(멤버 카드 가운데 선 기준) → 끝 멤버 뒤 → 그룹 뒤 */
function targetIn(host: string, el: HTMLElement, index: number, y: number): ItemTarget {
  const members = Array.from(el.querySelectorAll<HTMLElement>('[data-member]')).map((m) => m.getBoundingClientRect());
  if (members.length === 0) {
    const r = el.getBoundingClientRect();
    const f = (y - r.top) / r.height;
    const self = dragSrc?.host === host && dragSrc.src.index === index && dragSrc.src.member === undefined;
    if (f < 0.25 || (self && f < 0.5)) return { kind: 'before', index };
    if (f > 0.75 || self) return { kind: 'after', index };
    return { kind: 'into', index };
  }
  const third = members[0]!.height / 3;
  if (y < members[0]!.top + third) return { kind: 'before', index };
  if (y > members[members.length - 1]!.bottom - third) return { kind: 'after', index };
  const at = members.findIndex((m) => y < (m.top + m.bottom) / 2);
  return { kind: 'member', index, at: at === -1 ? members.length : at };
}
/** pane-body 안 포인터 Y → (host, 자리). 호스트 카드 위·목록 밖이면 null, 마지막 목록 아래 빈 공간은 그 목록의 맨 뒤 */
function resolveTarget(body: HTMLElement, y: number): { host: string; target: ItemTarget } | null {
  const byHost = new Map<string, HTMLElement[]>();
  for (const el of body.querySelectorAll<HTMLElement>('[data-item]')) {
    const host = el.dataset['host'] ?? '';
    const list = byHost.get(host) ?? [];
    list.push(el);
    byHost.set(host, list);
  }
  let tail: { host: string; els: HTMLElement[] } | null = null;
  for (const [host, els] of byHost) {
    tail = { host, els };
    const rects = els.map((el) => el.getBoundingClientRect());
    if (y < rects[0]!.top - GAP || y > rects[rects.length - 1]!.bottom + GAP) continue;
    for (let i = 0; i < els.length; i++) {
      const next = rects[i + 1];
      const edge = next ? (rects[i]!.bottom + next.top) / 2 : rects[i]!.bottom + GAP;
      if (y <= edge) return { host, target: targetIn(host, els[i]!, i, y) };
    }
  }
  if (tail !== null && y > tail.els[tail.els.length - 1]!.getBoundingClientRect().bottom) {
    return { host: tail.host, target: { kind: 'after', index: tail.els.length - 1 } };
  }
  return null;
}
function overBody(e: DragEvent): void {
  if (!hasRoots(e)) return;
  const t = resolveTarget(e.currentTarget as HTMLElement, e.clientY);
  over.value = t;
  if (t === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
}
function leaveBody(e: DragEvent): void {
  const body = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && body.contains(e.relatedTarget)) return;
  over.value = null;
}
function dropBody(e: DragEvent): void {
  const target = over.value;
  const raw = e.dataTransfer?.getData(DND_ROOTS);
  const from = dragSrc !== null && dragSrc.host === target?.host ? dragSrc.src : undefined;
  endDrag();
  if (!raw || target === null) return;
  e.preventDefault();
  let roots: string[] = [];
  try {
    roots = (JSON.parse(raw) as { roots: string[] }).roots ?? [];
  } catch {
    return;
  }
  // 다른 host·로컬 경로는 이 목록에 넣지 않는다
  const prefix = `ssh://${target.host}`;
  const paths = roots.filter((r) => r.startsWith(`${prefix}/`)).map((r) => r.slice(prefix.length));
  if (paths.length === 0) return;
  void dropItems(target.host, paths, target.target, from, e.ctrlKey);
}
/** 최상위 아이템(단일 행·그룹 묶음)의 드롭 표시 클래스 */
function dropClass(h: RemoteHost, index: number): Record<string, boolean> {
  const o = over.value;
  const on = o !== null && o.host === h.name && o.target.index === index;
  return {
    'drop-before': on && o.target.kind === 'before',
    'drop-after': on && o.target.kind === 'after',
    'drop-into': on && o.target.kind === 'into',
  };
}
/** 멤버 줄의 삽입선 — at 가 이 줄 앞이면 위, 마지막 줄 뒤면 아래 */
function memberClass(h: RemoteHost, index: number, mi: number, last: boolean): Record<string, boolean> {
  const o = over.value;
  const on = o !== null && o.host === h.name && o.target.kind === 'member' && o.target.index === index;
  const at = on && o.target.kind === 'member' ? o.target.at : -1;
  return { 'drop-before': at === mi, 'drop-after': last && at === mi + 1 };
}

// ---- 그룹 별칭 인라인 편집 (우클릭 '그룹 이름...') — 별칭이 없어도 편집 중에는 제목줄이 나타난다
const editing = ref<{ host: string; index: number } | null>(null);
const draft = ref('');
const aliasInput = ref<HTMLInputElement | null>(null);
function isEditing(h: RemoteHost, index: number): boolean {
  return editing.value?.host === h.name && editing.value.index === index;
}
function beginAlias(h: RemoteHost, index: number): void {
  const g = itemsOf(h)[index];
  editing.value = { host: h.name, index };
  draft.value = g !== undefined && isGroup(g) ? (g.alias ?? '') : '';
  void nextTick(() => {
    aliasInput.value?.focus();
    aliasInput.value?.select();
  });
}
function commitAlias(): void {
  const ed = editing.value;
  editing.value = null;
  if (ed !== null) void setGroupAlias(ed.host, ed.index, draft.value);
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

function pinItem(h: RemoteHost, index: number, pinned: boolean): ContextMenuItem {
  return pinned
    ? { label: '고정 해제', run: () => void togglePin(h.name, index) }
    : { label: '상단에 고정 (P)', key: 'p', run: () => void togglePin(h.name, index) };
}
/** 단일 아이템 메뉴 — pin 토글·제거 */
function onItemContextMenu(e: MouseEvent, h: RemoteHost, index: number, path: string, pinned: boolean): void {
  e.preventDefault();
  openContextMenu(e.clientX, e.clientY, [
    pinItem(h, index, pinned),
    { label: '목록에서 제거', run: () => void forgetItem(h.name, path) },
  ]);
}
/** 그룹 멤버 메뉴 — 그룹 pin·별칭·그룹에서 제거 (하나 남으면 그룹이 풀린다). 제목줄(path 없음)은 제거 없음 */
function onMemberContextMenu(e: MouseEvent, h: RemoteHost, index: number, pinned: boolean, path?: string): void {
  e.preventDefault();
  const items: ContextMenuItem[] = [
    pinItem(h, index, pinned),
    { label: '그룹 이름...', run: () => beginAlias(h, index) },
  ];
  if (path !== undefined) items.push({ separator: true }, { label: '그룹에서 제거', run: () => void forgetItem(h.name, path, index) });
  openContextMenu(e.clientX, e.clientY, items);
}

/** 카드 둘째 줄 — 호스트 상태 한마디 */
function hostDesc(h: RemoteHost): string {
  if (h.missing) return 'not in ~/.ssh/config';
  if (h.drift) return 'pinned · config changed';
  if (h.pinned) return 'pinned';
  return h.favorite ? 'ssh · favorite' : 'ssh';
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
      <div
        v-if="remote.panes[pane]"
        class="pane-body"
        @dragover="overBody($event)"
        @dragleave="leaveBody($event)"
        @drop="dropBody($event)"
      >
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
              :class="itemsOf(h).length ? (isExpanded(h) ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''"
            />
            <span class="codicon type-icon" :class="iconOf(pane, h)" />
            <span class="row-text">
              <span class="row-name">{{ h.name }}</span>
              <span class="row-desc">{{ hostDesc(h) }}</span>
            </span>
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
          <!-- 경로 아이템 (VS Code Remote Explorer 의 호스트 하위 항목 + pin·그룹) — 클릭은 선택, 접속은 호스트
               행과 같은 hover 액션 (→ 현재 탭 대체 / 새 탭). 그룹은 행 없이 멤버들을 세로선으로 묶어 항상
               펼쳐 보인다 — 그룹 열기 액션은 묶음 첫 줄(별칭 제목줄 또는 첫 멤버) hover -->
          <template v-if="isExpanded(h)">
            <template v-for="(it, ii) in itemsOf(h)" :key="ii">
              <div
                v-if="!isGroup(it)"
                class="row recent"
                :class="[{ selected: selected === recentKey(pane, h, it.path) }, dropClass(h, ii)]"
                :title="it.path"
                :data-host="h.name"
                :data-item="ii"
                draggable="true"
                @click.stop="selected = recentKey(pane, h, it.path)"
                @contextmenu="onItemContextMenu($event, h, ii, it.path, it.pinned)"
                @dragstart="startDrag($event, h, [it.path], { index: ii })"
                @dragend="endDrag()"
              >
                <span class="codicon type-icon" :class="it.pinned ? 'codicon-pinned' : 'codicon-folder'" />
                <span class="row-text">
                  <span class="row-name">{{ basename(it.path) }}</span>
                  <span class="row-desc">{{ it.path }}</span>
                </span>
                <div class="row-actions">
                  <span
                    class="action codicon codicon-arrow-right"
                    title="Open in Current Tab"
                    @click.stop="openRecent(h.name, it.path, 'replace')"
                  />
                  <span
                    class="action codicon codicon-empty-window"
                    title="Open in New Tab"
                    @click.stop="openRecent(h.name, it.path, 'new')"
                  />
                </div>
              </div>
              <div v-else class="group" :class="dropClass(h, ii)" :data-host="h.name" :data-item="ii">
                <div
                  v-if="it.alias !== undefined || it.pinned || isEditing(h, ii)"
                  class="row recent group-title"
                  draggable="true"
                  @dragstart="startDrag($event, h, it.paths, { index: ii })"
                  @dragend="endDrag()"
                  @contextmenu="onMemberContextMenu($event, h, ii, it.pinned)"
                >
                  <input
                    v-if="isEditing(h, ii)"
                    :ref="(el) => (aliasInput = el as HTMLInputElement | null)"
                    v-model="draft"
                    class="alias-input"
                    placeholder="Group name"
                    @click.stop
                    @keydown.enter.prevent="commitAlias()"
                    @keydown.esc.prevent="editing = null"
                    @blur="commitAlias()"
                  />
                  <template v-else>
                    <span v-if="it.pinned" class="codicon codicon-pinned title-pin" />
                    <span class="row-name alias">{{ it.alias ?? 'Group' }}</span>
                  </template>
                  <div class="row-actions">
                    <span
                      class="action codicon codicon-run-all"
                      title="Open Group in Current Tab + New Tabs"
                      @click.stop="openGroup(h.name, it.paths, 'replace')"
                    />
                    <span
                      class="action codicon codicon-multiple-windows"
                      title="Open Group in New Tabs"
                      @click.stop="openGroup(h.name, it.paths, 'new')"
                    />
                  </div>
                </div>
                <div
                  v-for="(p, mi) in it.paths"
                  :key="p"
                  class="row recent member"
                  :class="[{ selected: selected === recentKey(pane, h, p) }, memberClass(h, ii, mi, mi === it.paths.length - 1)]"
                  :title="p"
                  :data-member="mi"
                  draggable="true"
                  @click.stop="selected = recentKey(pane, h, p)"
                  @contextmenu="onMemberContextMenu($event, h, ii, it.pinned, p)"
                  @dragstart.stop="startDrag($event, h, [p], { index: ii, member: p })"
                  @dragend.stop="endDrag()"
                >
                  <span class="codicon type-icon codicon-folder" />
                  <span class="row-text">
                    <span class="row-name">{{ basename(p) }}</span>
                    <span class="row-desc">{{ p }}</span>
                  </span>
                  <div class="row-actions">
                    <template v-if="mi === 0 && it.alias === undefined && !it.pinned && !isEditing(h, ii)">
                      <span
                        class="action codicon codicon-run-all"
                        title="Open Group in Current Tab + New Tabs"
                        @click.stop="openGroup(h.name, it.paths, 'replace')"
                      />
                      <span
                        class="action codicon codicon-multiple-windows"
                        title="Open Group in New Tabs"
                        @click.stop="openGroup(h.name, it.paths, 'new')"
                      />
                      <span class="action-gap" />
                    </template>
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
              </div>
            </template>
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
/* 카드형 행 (2026-09-08 사용자 요청) — 탐색기 트리 대신 블럭처럼: 두 줄(이름 + 설명), 테두리·둥근 모서리,
   카드 사이 2px 틈. 호스트 카드와 경로 카드가 같은 규격이고 경로 카드는 안쪽으로 들여 쌓인다 */
.row {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 40px;
  margin: 5px 8px 5px 6px;
  padding: 4px 6px;
  border: 1px solid var(--vscode-widget-border);
  border-radius: 5px;
  background: var(--vscode-editorWidget-background);
  white-space: nowrap;
  cursor: pointer;
}
/* hover 는 배경·윤곽을 또렷하게 (평소 카드는 흐릿 — 사용자 요청 2026-09-08) */
.row:hover {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-descriptionForeground);
}
.row.selected {
  background: var(--vscode-list-inactiveSelectionBackground);
  border-color: var(--vscode-focusBorder);
}
/* drift·missing: 고정 저장본이 현재 config 와 다름 / config 에 없음 */
.row.drift .row-name {
  font-style: italic;
  color: var(--vscode-descriptionForeground);
}
.row.recent {
  margin-left: 16px;
}
.row-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
  line-height: 16px;
}
/* 드롭 표시 (2026-09-08 개정 — 안·밖·가운데가 한눈에 구분되게):
   - 최상위 앞·뒤: 카드(또는 그룹 카드) 밖 틈에 폭 전체 굵은 선 (3px)
   - 그룹 안 앞·뒤: 그룹 카드 안쪽에 들여 그은 얇은 액센트 선 (2px)
   - 가운데(그룹 만들기): 카드 배경·점선 테두리 강조 + 오른쪽 "+ Group" 표시 */
.row.drop-into {
  background: var(--vscode-list-dropBackground);
  border: 1px dashed var(--vscode-focusBorder);
}
.row.drop-into .row-actions {
  display: none;
}
.row.drop-into::after {
  content: '+ Group';
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  padding: 1px 6px;
  border-radius: 9px;
  font-size: 11px;
  background: var(--vscode-focusBorder);
  color: var(--vscode-button-foreground);
  pointer-events: none;
}
.pane-body > .row.drop-before::before,
.pane-body > .row.drop-after::after,
.group.drop-before::before,
.group.drop-after::after {
  content: '';
  position: absolute;
  left: -4px;
  right: -4px;
  height: 3px;
  border-radius: 2px;
  background: var(--vscode-focusBorder);
  pointer-events: none;
  z-index: 1;
}
.pane-body > .row.drop-before::before,
.group.drop-before::before {
  top: -6px;
}
.pane-body > .row.drop-after::after,
.group.drop-after::after {
  bottom: -6px;
}
.group .row.drop-before::before,
.group .row.drop-after::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 6px;
  height: 2px;
  background: var(--sl-accent);
  pointer-events: none;
  z-index: 1;
}
.group .row.drop-before::before {
  top: -3px;
}
.group .row.drop-after::after {
  bottom: -3px;
}
/* 그룹 밖 앞·뒤로 나가는 중에는 그룹 카드 테두리를 흐리게 — "밖" 임을 한 번 더 */
.group.drop-before,
.group.drop-after {
  opacity: 0.75;
}
/* 그룹 — 그룹 자체가 카드이고 그 안에 멤버 카드가 쌓인다 (항상 펼침). 왼쪽 액센트 띠로 그룹임을 표시,
   별칭이 있을 때만 위에 작은 제목줄 (사용자 요청 2026-09-08) */
.group {
  position: relative;
  margin: 5px 8px 5px 16px;
  padding: 3px 3px 3px 5px;
  border: 1px solid var(--vscode-widget-border);
  border-left: 3px solid var(--sl-accent);
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.04);
}
.group .row.recent {
  margin: 3px 0;
}
.row.group-title {
  min-height: 20px;
  margin: 0 0 2px;
  padding: 0 4px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}
.row.group-title:hover {
  background: var(--vscode-list-hoverBackground);
}
.title-pin {
  font-size: 14px;
  margin-right: 4px;
}
.row.group-title .alias {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.action-gap {
  width: 6px;
}
.alias-input {
  min-width: 0;
  flex: 1;
  height: 16px;
  padding: 0 4px;
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 2px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  font-size: 11px;
  outline: none;
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
  font-size: 18px;
  margin-right: 8px;
  color: var(--vscode-icon-foreground);
}
.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-desc {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions {
  display: none;
  margin-left: auto;
  align-items: center;
  flex: none;
  padding-left: 4px;
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
