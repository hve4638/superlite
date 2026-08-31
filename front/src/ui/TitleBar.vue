<script setup lang="ts">
import { workbench, toggleSideBar, togglePanel } from '../model/workbench';
import {
  inApp,
  appWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
} from '../model/window';
</script>

<template>
  <!-- data-tauri-drag-region 은 이벤트 target 에만 적용된다 — 드래그할 빈 영역마다 직접 붙인다 -->
  <div class="titlebar" data-tauri-drag-region>
    <!-- 중앙: 추후 워크스페이스 세션 탭 자리 (decision/workspace-session-tabs.md) — 비워둔다 -->
    <div class="titlebar-center" data-tauri-drag-region />
    <div class="titlebar-right" data-tauri-drag-region>
      <span
        class="codicon codicon-layout-sidebar-left layout-icon"
        :class="{ off: !workbench.sideBarVisible }"
        @click="toggleSideBar()"
      />
      <span
        class="codicon codicon-layout-panel layout-icon"
        :class="{ off: !workbench.panelVisible }"
        @click="togglePanel()"
      />
    </div>
    <div v-if="inApp" class="window-controls">
      <div
        class="window-control codicon codicon-chrome-minimize"
        @click="minimizeWindow()"
      />
      <div
        class="window-control codicon"
        :class="appWindow.maximized ? 'codicon-chrome-restore' : 'codicon-chrome-maximize'"
        @click="toggleMaximizeWindow()"
      />
      <div
        class="window-control window-control-close codicon codicon-chrome-close"
        @click="closeWindow()"
      />
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
  display: flex;
  align-items: stretch;
  height: 35px;
  background: var(--vscode-titleBar-activeBackground);
  color: var(--vscode-titleBar-activeForeground);
  flex-shrink: 0;
}
.titlebar-center {
  flex: 1;
}
.titlebar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  padding: 0 8px;
  flex-shrink: 0;
}
.layout-icon {
  font-size: 16px;
  padding: 4px;
  border-radius: 5px;
  cursor: pointer;
}
.layout-icon:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.layout-icon.off {
  opacity: 0.6;
}
.window-controls {
  display: flex;
  flex-shrink: 0;
}
.window-control {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  font-size: 16px;
}
.window-control:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
/* VS Code 도 창 닫기 hover 색은 토큰 없이 고정값이다 (workbench 하드코드) */
.window-control-close:hover {
  background: rgba(232, 17, 35, 0.9);
  color: #ffffff;
}
</style>
