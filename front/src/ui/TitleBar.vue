<script setup lang="ts">
import { computed } from 'vue';
import { workbench, toggleSideBar, togglePanel } from '../model/workbench';
import {
  inApp,
  appWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
} from '../model/window';
import {
  sessions,
  ownSession,
  activateSession,
  closeSession,
  addSession,
  type SessionTab,
} from '../model/sessions';

// 같은 이름(루트 basename)의 세션이 여럿이면 부모 디렉토리 힌트로 구분한다 (에디터 탭과 같은 규칙)
const descriptions = computed(() => {
  const byName = new Map<string, SessionTab[]>();
  for (const t of sessions.list) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  const out = new Map<string, string>();
  for (const tabs of byName.values()) {
    if (tabs.length < 2) continue;
    for (const t of tabs) out.set(t.id, parentHint(t.root));
  }
  return out;
});

/** 루트의 부모 디렉토리명 — root 는 native 경로라 구분자가 OS 마다 다르다 */
function parentHint(root: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const segs = root.split(sep).filter((s) => s !== '');
  return segs.length >= 2 ? segs[segs.length - 2] : sep;
}
</script>

<template>
  <!-- data-tauri-drag-region 은 이벤트 target 에만 적용된다 — 드래그할 빈 영역마다 직접 붙인다 -->
  <div class="titlebar" data-tauri-drag-region>
    <!-- 중앙: 워크스페이스 세션 탭 (decision/workspace-session-tabs.md) — 탭 밖 여백은 드래그 영역 -->
    <div class="titlebar-center" data-tauri-drag-region>
      <div v-if="inApp && sessions.list.length" class="session-tabs">
        <div
          v-for="tab in sessions.list"
          :key="tab.id"
          class="session-tab"
          :class="{ active: tab.id === ownSession }"
          :title="tab.root"
          @click="activateSession(tab.id)"
        >
          <span class="session-name">{{ tab.name }}</span>
          <span v-if="descriptions.get(tab.id)" class="session-description">{{
            descriptions.get(tab.id)
          }}</span>
          <span
            class="session-close codicon codicon-close"
            @click.stop="closeSession(tab.id)"
          />
        </div>
        <span
          class="session-add codicon codicon-add"
          title="Open Folder as New Session"
          @click="addSession()"
        />
      </div>
    </div>
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
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.session-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  overflow: hidden;
}
.session-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 4px 0 10px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  color: var(--vscode-titleBar-inactiveForeground);
  background: var(--vscode-tab-inactiveBackground);
}
.session-tab:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.session-tab.active {
  background: var(--vscode-tab-activeBackground);
  color: var(--vscode-titleBar-activeForeground);
  outline: 1px solid var(--vscode-tab-border);
}
.session-description {
  font-size: 10px;
  opacity: 0.7;
}
.session-close {
  font-size: 14px;
  padding: 1px;
  border-radius: 3px;
  visibility: hidden;
}
.session-tab:hover .session-close,
.session-tab.active .session-close {
  visibility: visible;
}
.session-close:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.session-add {
  font-size: 14px;
  padding: 3px;
  border-radius: 4px;
  cursor: pointer;
}
.session-add:hover {
  background: var(--vscode-toolbar-hoverBackground);
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
