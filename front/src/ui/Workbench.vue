<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { workbench, sideBarShown, activityBarShown } from '../model/workbench';
import { editors } from '../model/editors';
import { sessions } from '../model/sessions';
import { answerConfirm, dialog } from '../model/dialog';
import { version } from '../model/version';
import TitleBar from './TitleBar.vue';
import ActivityBar from './ActivityBar.vue';
import SideBar from './SideBar.vue';
import StatusBar from './StatusBar.vue';
import EditorArea from './editor/EditorArea.vue';
import QuickInput from './QuickInput.vue';
import ContextMenu from './ContextMenu.vue';
import Sash from './widgets/Sash.vue';
import ConfirmDialog from './widgets/ConfirmDialog.vue';
import AboutDialog from './widgets/AboutDialog.vue';
import ConflictToast from './widgets/ConflictToast.vue';
import NotificationToasts from './widgets/NotificationToasts.vue';

const SIDEBAR_MIN = 170;

function clampSideBar(width: number): number {
  const max = Math.round(window.innerWidth * 0.8);
  return Math.min(max, Math.max(SIDEBAR_MIN, width));
}

// 드래그 시작 시점 크기 — Sash 의 누적 델타를 여기에 더해 클램프한다
let sideBarStart = 0;

function resizeSideBar(dx: number) {
  workbench.sideBarWidth = clampSideBar(sideBarStart + dx);
}

// WHY: 창을 줄이면 저장된 사이드바 크기가 가용 공간을 넘어 에디터가 0px 로
//      붕괴할 수 있다 — 리사이즈 때 클램프만 다시 적용한다.
function onWindowResize() {
  workbench.sideBarWidth = clampSideBar(workbench.sideBarWidth);
}
onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize));
</script>

<template>
  <div class="workbench">
    <TitleBar />
    <!-- WHY: 세션(탭) 전환마다 본문을 통째로 재마운트한다 — monaco 에디터·트리 스크롤 같은
         컴포넌트 국소 명령형 상태가 세션을 넘어 새지 않게. 모델 상태는 세션 컨텍스트에
         남아 있으므로 재마운트가 곧 복원이다 (xterm 은 terminalHost 바인딩 맵이 살아 재부착) -->
    <div :key="sessions.activeId" class="workbench-middle">
      <ActivityBar v-if="activityBarShown()" />
      <div v-if="sideBarShown()" class="sidebar-slot">
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
      </div>
    </div>
    <StatusBar />
    <QuickInput v-if="workbench.quickInput.open" />
    <ContextMenu v-if="workbench.contextMenu.open" />
    <!-- 웹 전용 확인 창 — model/dialog.confirm 의 웹 경로 (앱은 OS 다이얼로그, ticket native-confirm-dialog) -->
    <ConfirmDialog
      v-if="dialog.pending"
      :message="dialog.pending.message"
      :detail="dialog.pending.detail"
      :confirm-label="dialog.pending.confirmLabel"
      :secondary-label="dialog.pending.secondaryLabel"
      @confirm="answerConfirm('confirm')"
      @secondary="answerConfirm('secondary')"
      @cancel="answerConfirm('cancel')"
    />
    <!-- Help: About — 버전·커밋·와이어·데몬 경로 (ticket release-versioning) -->
    <AboutDialog v-if="version.aboutOpen" />
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
</style>
