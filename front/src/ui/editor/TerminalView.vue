<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { editors } from '../../model/editors';
import { answerCloseRequest, closeRequestOf } from '../../model/terminal';
import { TERMINAL_BACKGROUND, attachTerminal, fitTerminal, focusTerminal } from './terminalHost';

// 터미널 탭의 본문 — xterm 은 terminalHost 의 바인딩이 소유하고 여기는 붙이고 크기를 맞출 뿐.
// 탭 전환·세션 전환으로 언마운트돼도 스크롤백은 바인딩에 그대로 남는다.
// active: 이 터미널이 활성 그룹의 활성 탭(덱이면 활성 덱의 활성 카드)인가 — TabBody 가 계산한다. 마운트돼 있다는 것이
// 곧 자기 목록의 활성 탭이라는 뜻이므로 목록의 활성 여부만 받으면 된다
const props = defineProps<{ term: number; active: boolean }>();

const host = ref<HTMLElement | null>(null);
let ro: ResizeObserver | null = null;

onMounted(() => {
  if (!host.value) return;
  attachTerminal(props.term, host.value);
  ro = new ResizeObserver(() => fitTerminal(props.term));
  ro.observe(host.value);
  void nextTick(() => {
    fitTerminal(props.term);
    // 탭 활성화·새 터미널은 바로 입력 가능해야 한다 — 활성 그룹일 때만 (여러 그룹의 터미널이
    // 동시에 마운트되면 마지막 것이 포커스를 뺏는다). monaco 용 포커스 요청은 여기서 소비한다
    if (props.active) {
      editors.pendingFocus = false;
      focusTerminal(props.term);
    }
  });
});

// 이미 마운트된 채 다시 활성화(Ctrl+`·탭 클릭) — remount 가 없으니 포커스 요청을 지켜본다.
// WHY: 활성 탭이 이 터미널일 때만 — 다른 탭으로 옮기는 요청(pre flush, 아직 언마운트 전)을
//      여기서 삼키면 monaco 가 포커스를 못 받는다
watch(
  () => editors.pendingFocus && props.active,
  (on) => {
    if (!on) return;
    editors.pendingFocus = false;
    focusTerminal(props.term);
  },
);

// 닫기 요청 상자 (ticket superlite-card-control) — `superlite card close` 가 걸어 둔 요청을 이 카드 영역 안에서만 묻는다.
// 거절·x 는 요청만 지우고 터미널로 포커스를 돌려준다
function answer(close: boolean): void {
  void answerCloseRequest(props.term, close);
  if (!close) focusTerminal(props.term);
}

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});
</script>

<template>
  <!-- 브라우저·웹뷰 기본 컨텍스트 메뉴 차단 (사용자 지시 2026-09-09) — 우클릭은 xterm 에 그대로 간다 -->
  <div class="terminal-wrap">
    <div ref="host" class="terminal-view" :style="{ background: TERMINAL_BACKGROUND }" @contextmenu.prevent />
    <div v-if="closeRequestOf(term) !== null" class="close-request" role="alertdialog" :title="closeRequestOf(term) ?? ''">
      <span class="codicon codicon-close close-x" title="거절" @click="answer(false)" />
      <div class="close-msg">이 Terminal card 닫기를 요청했습니다. 닫을까요?</div>
      <div class="close-actions">
        <button class="primary" @click="answer(true)">닫기</button>
        <button @click="answer(false)">거절</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.close-request {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 5;
  width: 260px;
  padding: 12px 12px 10px;
  box-sizing: border-box;
  font-size: 13px;
  background: var(--vscode-notifications-background, #252526);
  color: var(--vscode-notifications-foreground, #ccc);
  border: 1px solid var(--vscode-notifications-border, #454545);
  box-shadow: 0 0 8px 2px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
}
.close-x {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px;
  border-radius: 3px;
  cursor: pointer;
}
.close-x:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.close-msg {
  padding-right: 18px;
  line-height: 1.4;
}
.close-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
}
.close-actions button {
  font: inherit;
  padding: 2px 12px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #fff);
}
.close-actions button.primary {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
/* Windows Terminal 을 닮는다 — 검은 배경(terminalHost 의 Campbell 과 같은 값), 8px 패딩 */
.terminal-view {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px;
  box-sizing: border-box;
}
.terminal-view :deep(.term-attach) {
  position: relative;
  width: 100%;
  height: 100%;
}
/* 높이가 셀 배수가 아닐 때 하단 정렬 (VS Code·WT 공통) */
.terminal-view :deep(.xterm) {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
}
/* IME 조합 중 xterm 이 커서 칸 위에 띄우는 조합 텍스트 상자 (ticket ime-composition-window). 기본 배경
   #000 은 터미널 배경보다 어두워 상자 자체가 비치고, 좌표(cursorX × 셀 폭)가 DOM 행의 글리프 자리와
   서브픽셀로 어긋나 아래 칸 — claude 같은 TUI 가 그리는 역상 커서 — 이 위·왼쪽 가장자리에 점·선으로 샌다.
   배경색을 맞추고 box-shadow 로 1px 씩 더 덮는다 (레이아웃·textarea 크기 계산에는 영향 없음) */
.terminal-view :deep(.xterm .composition-view) {
  background: v-bind(TERMINAL_BACKGROUND);
  box-shadow: 0 0 0 1px v-bind(TERMINAL_BACKGROUND);
}
/* 스크롤 영역도 같은 배경 — xterm 기본(#000)이 비치지 않게 */
.terminal-view :deep(.xterm .xterm-viewport) {
  background: v-bind(TERMINAL_BACKGROUND) !important;
}
</style>
