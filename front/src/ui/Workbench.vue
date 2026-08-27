<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { workbench } from '../model/workbench';
import { editors } from '../model/editors';
import TitleBar from './TitleBar.vue';
import ActivityBar from './ActivityBar.vue';
import SideBar from './SideBar.vue';
import StatusBar from './StatusBar.vue';
import EditorArea from './editor/EditorArea.vue';
import PanelArea from './panel/PanelArea.vue';
import QuickInput from './QuickInput.vue';
import ContextMenu from './ContextMenu.vue';
import Sash from './widgets/Sash.vue';
import ConflictToast from './widgets/ConflictToast.vue';
import NotificationToasts from './widgets/NotificationToasts.vue';

const SIDEBAR_MIN = 170;
const PANEL_MIN = 77;

function clampSideBar(width: number): number {
  const max = Math.round(window.innerWidth * 0.8);
  return Math.min(max, Math.max(SIDEBAR_MIN, width));
}

function clampPanel(height: number): number {
  const max = window.innerHeight - 35 - 22 - 100;
  return Math.min(max, Math.max(PANEL_MIN, height));
}

// 드래그 시작 시점 크기 — Sash 의 누적 델타를 여기에 더해 클램프한다
let sideBarStart = 0;
let panelStart = 0;

function resizeSideBar(dx: number) {
  workbench.sideBarWidth = clampSideBar(sideBarStart + dx);
}

function resizePanel(dy: number) {
  workbench.panelHeight = clampPanel(panelStart - dy);
}

// WHY: 창을 줄이면 저장된 사이드바/패널 크기가 가용 공간을 넘어 에디터가 0px 로
//      붕괴할 수 있다 — 리사이즈 때 클램프만 다시 적용한다.
function onWindowResize() {
  workbench.sideBarWidth = clampSideBar(workbench.sideBarWidth);
  if (workbench.panelVisible) workbench.panelHeight = clampPanel(workbench.panelHeight);
}
onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize));
</script>

<template>
  <div class="workbench">
    <TitleBar />
    <div class="workbench-middle">
      <ActivityBar />
      <div v-if="workbench.sideBarVisible" class="sidebar-slot">
        <SideBar />
        <Sash
          direction="vertical"
          class="sidebar-sash"
          @dragstart="sideBarStart = workbench.sideBarWidth"
          @resize="resizeSideBar"
        />
      </div>
      <div class="main-slot">
        <div class="editor-slot">
          <EditorArea />
        </div>
        <div
          v-if="workbench.panelVisible"
          class="panel-slot"
          :style="{ height: `${workbench.panelHeight}px` }"
        >
          <PanelArea />
          <Sash
            direction="horizontal"
            class="panel-sash"
            @dragstart="panelStart = workbench.panelHeight"
            @resize="resizePanel"
          />
        </div>
      </div>
    </div>
    <StatusBar />
    <QuickInput v-if="workbench.quickInput.open" />
    <ContextMenu v-if="workbench.contextMenu.open" />
    <!-- VS Code 처럼 토스트는 우하단 한 스택 — 새 알림이 아래, 충돌 토스트가 있으면 맨 아래 -->
    <div class="toast-stack">
      <NotificationToasts />
      <ConflictToast v-if="editors.saveConflict !== null" />
    </div>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 12px;
  bottom: 30px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-editor-background);
}
.workbench-middle {
  flex: 1;
  display: flex;
  min-height: 0;
}
.sidebar-slot {
  position: relative;
  display: flex;
  flex-shrink: 0;
}
.sidebar-sash {
  right: -2px;
}
.main-slot {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.editor-slot {
  flex: 1;
  min-height: 0;
  display: flex;
}
.panel-slot {
  position: relative;
  flex-shrink: 0;
}
.panel-sash {
  top: -2px;
}
</style>
