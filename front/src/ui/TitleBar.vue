<script setup lang="ts">
import { workbench, toggleSideBar, togglePanel } from '../model/workbench';
</script>

<template>
  <div class="titlebar">
    <div class="titlebar-right">
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
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 35px;
  background: var(--vscode-titleBar-activeBackground);
  color: var(--vscode-titleBar-activeForeground);
  flex-shrink: 0;
}
.titlebar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  width: 240px;
  padding-right: 8px;
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
</style>
