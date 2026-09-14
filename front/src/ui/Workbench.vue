<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { workbench, sideBarShown, sideBarPinned, hideFloatingSideBar, activityBarShown } from '../model/workbench';
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
/** 플로팅 사이드바의 왼쪽 여백(px) — 카드처럼 떠 보이게. CSS 의 .sidebar-slot.floating padding-left 와 같은 값 */
const FLOAT_GAP = 8;

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
      <!-- 플로팅(기본): 자리는 0 이고(음수 margin-right 로 자기 폭만큼 상쇄) 편집기 영역 위에 겹쳐 그린다.
           고정(pin)하면 종전처럼 flex 자리를 차지한다 (ticket floating-sidebar) -->
      <div
        v-if="sideBarShown()"
        class="sidebar-slot"
        :class="{ floating: !sideBarPinned() }"
        :style="sideBarPinned() ? undefined : { marginRight: `-${workbench.sideBarWidth + FLOAT_GAP}px` }"
      >
        <SideBar />
        <Sash
          direction="vertical"
          class="sidebar-sash"
          @dragstart="sideBarStart = workbench.sideBarWidth"
          @resize="resizeSideBar"
        />
      </div>
      <!-- 플로팅 사이드바는 편집기 영역을 마우스로 누르면 접힌다 (포커스 이동만으로는 안 접힘 — 2026-09-14 결정).
           캡처 단계라 편집기·터미널이 이벤트를 삼켜도 잡힌다 -->
      <div class="main-slot" @mousedown.capture="hideFloatingSideBar()">
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
/* 플로팅 — 뒤(main-slot)와 monaco 위젯(suggest 40·hover 50)보다 위. 패널은 사방 여백을 두고 둥글게 떠 있고
   Fluent 아크릴 재질을 흉내낸다 (2026-09-14 사용자 요청, Windows Terminal 의 그것): 큰 블러 + 채도, 틴트 65%,
   ::before 의 feTurbulence 노이즈 3%, 넓은 그림자(거리감), 위쪽 1px 하이라이트(유리 두께). sash(z 35)는 그대로 */
.sidebar-slot.floating {
  z-index: 60;
  padding: 8px 0 8px 8px;
}
.sidebar-slot.floating :deep(.sidebar) {
  position: relative;
  border-radius: 8px;
  background: color-mix(in srgb, var(--vscode-sideBar-background) 65%, transparent);
  backdrop-filter: blur(32px) saturate(150%);
  box-shadow:
    0 0 0 1px var(--vscode-sideBar-border, rgba(128, 128, 128, 0.35)),
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 16px 48px rgba(0, 0, 0, 0.55);
}
.sidebar-slot.floating :deep(.sidebar)::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
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
