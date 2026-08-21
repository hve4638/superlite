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

const SIDEBAR_MIN = 170;
const PANEL_MIN = 77;

function resizeSideBar(dx: number) {
  const max = Math.round(window.innerWidth * 0.8);
  workbench.sideBarWidth = Math.min(max, Math.max(SIDEBAR_MIN, workbench.sideBarWidth + dx));
}

function resizePanel(dy: number) {
  const max = window.innerHeight - 35 - 22 - 100;
  workbench.panelHeight = Math.min(max, Math.max(PANEL_MIN, workbench.panelHeight - dy));
}

// WHY: 창을 줄이면 저장된 사이드바/패널 크기가 가용 공간을 넘어 에디터가 0px 로
//      붕괴할 수 있다 — 리사이즈 때 델타 0 으로 클램프만 다시 적용한다.
function onWindowResize() {
  resizeSideBar(0);
  if (workbench.panelVisible) resizePanel(0);
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
        <Sash direction="vertical" class="sidebar-sash" @resize="resizeSideBar" />
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
          <Sash direction="horizontal" class="panel-sash" @resize="resizePanel" />
        </div>
      </div>
    </div>
    <StatusBar />
    <QuickInput v-if="workbench.quickInput.open" />
    <ContextMenu v-if="workbench.contextMenu.open" />
    <ConflictToast v-if="editors.saveConflict !== null" />
  </div>
</template>

<style scoped>
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
