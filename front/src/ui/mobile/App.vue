<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { goTo, nav, type Tab } from './nav';
import SessionsScreen from './SessionsScreen.vue';
import FilesScreen from './FilesScreen.vue';
import ScmScreen from './ScmScreen.vue';
import EditorArea from './EditorArea.vue';
import WorkspaceScreen from './WorkspaceScreen.vue';
import Overlays from './Overlays.vue';
import { activeGroup } from '../../model/editors';
import { scm } from '../../model/scm';

// 모바일 셸 뼈대 (ticket mobile-shell) — 하단 탭 다섯을 번갈아 보인다. 파일·세션·Git 은 데스크톱 사이드바 뷰릿 역할(목록에서
// 고르면 Editor 탭으로 넘어간다), Editor 는 편집기 영역(열린 탭 전부 — 파일·diff·터미널), 맨 왼쪽 Workspace 는 데스크톱의
// 세션 탭 줄(열린 워크스페이스 전환·추가·닫기 — 앞의 넷은 전부 활성 세션의 것이라 여기서 바꾸면 함께 바뀐다, 사용자 결정
// 2026-09-15, 자리는 맨 왼쪽). 화면은 하나만 마운트되고 상태는 전부 model 에 있어 다시 마운트해도 그대로다.
// 목록 화면(파일·세션·Git·폴더 선택)은 상단 헤더에 제목과 동작 아이콘을 둔다. Editor 만 헤더가 없고 탭 줄 오른쪽에 아이콘을
// 둔다 (사용자 결정 2026-09-15). 하단 바는 탭 넷뿐이다
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'workspace', icon: 'folder-library', label: 'Workspace' },
  { id: 'files', icon: 'files', label: 'Files' },
  { id: 'sessions', icon: 'terminal', label: 'Sessions' },
  { id: 'scm', icon: 'source-control', label: 'Git' },
  { id: 'editor', icon: 'layout', label: 'Editor' },
];
const changeCount = computed(() => scm.changes.length);
const openCount = computed(() => activeGroup().tabs.length);
function badge(id: Tab): number {
  if (id === 'scm') return changeCount.value;
  if (id === 'editor') return openCount.value;
  return 0;
}

// 소프트 키보드가 올라온 동안 하단 탭 바를 숨긴다 (사용자 요청 2026-09-15) — 남은 세로 공간을 터미널·편집기에 준다.
// 판정: 편집 가능한 요소(xterm·Monaco 의 textarea, 커밋 메시지)에 포커스가 있고, 뷰포트가 같은 폭에서 본 최대 높이보다
// 뚜렷이(25% 넘게) 짧을 때 (viewport meta interactive-widget=resizes-content 라 키보드가 innerHeight 를 줄인다). 기준을
// screen.height 가 아니라 관측 최대치로 두는 이유: 전체화면 진입·이탈은 15% 안쪽이라 걸리지 않고, 회전은 폭이 바뀌어
// 기준을 새로 잡는다. 하드웨어 키보드는 높이가 안 줄어 바가 남는다
let maxH = window.innerHeight;
let lastW = window.innerWidth;
function editing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable);
}
function updateKeyboard(): void {
  if (window.innerWidth !== lastW) {
    lastW = window.innerWidth;
    maxH = window.innerHeight;
  } else maxH = Math.max(maxH, window.innerHeight);
  nav.keyboard = editing() && window.innerHeight < maxH * 0.75;
}
onMounted(() => {
  window.addEventListener('resize', updateKeyboard);
  window.visualViewport?.addEventListener('resize', updateKeyboard);
  document.addEventListener('focusin', updateKeyboard);
  document.addEventListener('focusout', () => setTimeout(updateKeyboard, 50)); // 포커스 이동 중간 상태를 건너뛴다
});
</script>

<template>
  <div class="m-app">
    <FilesScreen v-if="nav.tab === 'files'" />
    <SessionsScreen v-else-if="nav.tab === 'sessions'" />
    <ScmScreen v-else-if="nav.tab === 'scm'" />
    <WorkspaceScreen v-else-if="nav.tab === 'workspace'" />
    <EditorArea v-else />
    <nav v-show="!nav.keyboard" class="m-tabs">
      <button v-for="t in TABS" :key="t.id" :class="{ active: nav.tab === t.id }" @click="goTo(t.id)">
        <span class="codicon" :class="`codicon-${t.icon}`" />
        <span class="label">{{ t.label }}</span>
        <span v-if="badge(t.id) > 0" class="badge">{{ badge(t.id) }}</span>
      </button>
    </nav>
    <Overlays />
  </div>
</template>

<style>
/* 모바일 셸 공통 — 화면 하나가 뷰포트 전체, 페이지 스크롤·당겨서 새로고침 없음 */
.m-app {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  overscroll-behavior: none;
  font-size: 15px;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
}
.m-app button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  touch-action: manipulation;
}
.m-screen {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.m-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 8px;
  flex-shrink: 0;
  background: var(--vscode-sideBarSectionHeader-background, #1f1f1f);
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, #2b2b2b);
}
.m-header .title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.m-header .sub {
  font-weight: 400;
  opacity: 0.6;
  font-size: 12px;
}
.m-icon-btn {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  flex-shrink: 0;
}
.m-icon-btn .codicon {
  font-size: 20px;
}
.m-icon-btn.on {
  background: var(--sl-accent-soft, #0e639c);
  color: #fff;
}
.m-icon-btn:disabled {
  opacity: 0.35;
}
.m-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.m-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 4px 12px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--vscode-widget-border, #2b2b2b);
}
.m-row:active {
  background: var(--vscode-list-activeSelectionBackground, #04395e);
}
.m-row .main {
  flex: 1;
  min-width: 0;
}
.m-row .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-row .meta {
  font-size: 12px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-section {
  padding: 10px 12px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.6;
}
.m-empty {
  padding: 32px 16px;
  text-align: center;
  opacity: 0.6;
}
.m-tabs {
  display: flex;
  height: 56px;
  flex-shrink: 0;
  border-top: 1px solid var(--vscode-widget-border, #2b2b2b);
  background: var(--vscode-activityBar-background, #181818);
  padding-bottom: env(safe-area-inset-bottom);
}
.m-tabs button {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  position: relative;
  opacity: 0.55;
}
.m-tabs button.active {
  opacity: 1;
  color: var(--sl-accent, #3794ff);
}
.m-tabs .codicon {
  font-size: 22px;
}
.m-tabs .label {
  font-size: 11px;
}
.m-tabs .badge {
  position: absolute;
  top: 6px;
  left: calc(50% + 6px);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  background: var(--sl-accent, #3794ff);
  color: #fff;
}
.m-primary {
  padding: 10px 16px;
  border-radius: 6px;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.m-primary:disabled {
  opacity: 0.4;
}
.m-banner {
  padding: 8px 12px;
  font-size: 13px;
  background: var(--vscode-inputValidation-warningBackground, #352a05);
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
  display: flex;
  align-items: center;
  gap: 8px;
}
.m-banner .msg {
  flex: 1;
}
.m-banner button {
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
}
</style>
