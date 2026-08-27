<script setup lang="ts">
import { workbench, toggleSideBar, togglePanel, openQuickInput } from '../model/workbench';
</script>

<template>
  <div class="titlebar">
    <div class="titlebar-left">
      <span class="codicon codicon-menu menu-icon" />
    </div>
    <div class="titlebar-center">
      <span class="codicon codicon-arrow-left nav-icon disabled" />
      <span class="codicon codicon-arrow-right nav-icon disabled" />
      <div class="command-center" @click="openQuickInput('files')">
        <span class="codicon codicon-search search-icon" />
        <span class="command-center-label">{{ workbench.workspaceName }}</span>
      </div>
    </div>
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
      <span class="codicon codicon-layout layout-icon" />
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 35px;
  background: var(--vscode-titleBar-activeBackground);
  color: var(--vscode-titleBar-activeForeground);
  flex-shrink: 0;
}
.titlebar-left {
  display: flex;
  align-items: center;
  padding-left: 10px;
  width: 240px;
  flex-shrink: 0;
}
.menu-icon {
  font-size: 16px;
  padding: 6px;
  border-radius: 5px;
  cursor: pointer;
}
.menu-icon:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.titlebar-center {
  /* WHY: 레퍼런스는 command center 를 창 전체 기준으로 중앙 정렬한다 —
     flex 잔여 공간 기준이면 좌우 섹션 폭에 따라 밀리므로 절대 중앙 배치로 맞춘다 */
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
}
.nav-icon {
  font-size: 16px;
  padding: 3px;
  border-radius: 5px;
}
.nav-icon.disabled {
  opacity: 0.4;
}
.command-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  /* WHY: 레퍼런스 측정값 — 1280px 뷰포트에서 command center 는 538px ≈ 42vw(창 기준), 높이 24px */
  width: 42vw;
  max-width: 600px;
  height: 24px;
  background: var(--vscode-commandCenter-background);
  border: 1px solid var(--vscode-commandCenter-inactiveBorder, var(--vscode-commandCenter-border));
  border-radius: 6px;
  color: var(--vscode-commandCenter-foreground);
  font-size: 13px;
  cursor: pointer;
}
.command-center:hover {
  background: var(--vscode-commandCenter-activeBackground);
}
.search-icon {
  font-size: 14px;
  opacity: 0.8;
}
.command-center-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
