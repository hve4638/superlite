<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { editors } from '../../model/editors';
import { TERMINAL_BACKGROUND, attachTerminal, fitTerminal, focusTerminal } from './terminalHost';

// 터미널 탭의 본문 — xterm 은 terminalHost 의 바인딩이 소유하고 여기는 붙이고 크기를 맞출 뿐.
// 탭 전환·세션 전환으로 언마운트돼도 스크롤백은 바인딩에 그대로 남는다
const props = defineProps<{ term: number; groupId: number }>();

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
    if (isActiveTab()) {
      editors.pendingFocus = false;
      focusTerminal(props.term);
    }
  });
});

// 이미 마운트된 채 다시 활성화(Ctrl+`·탭 클릭) — remount 가 없으니 포커스 요청을 지켜본다.
// WHY: 활성 탭이 이 터미널일 때만 — 다른 탭으로 옮기는 요청(pre flush, 아직 언마운트 전)을
//      여기서 삼키면 monaco 가 포커스를 못 받는다
// 탭 id 문자열을 여기서 다시 조립하지 않는다 — id 규칙은 model/editors 의 것이라, 활성 탭 객체를 찾아 종류·term 으로 본다
const isActiveTab = () => {
  if (editors.activeGroupId !== props.groupId) return false;
  const g = editors.groups.find((g) => g.id === props.groupId);
  const t = g?.tabs.find((t) => t.id === g.activeTabId);
  return t?.kind === 'terminal' && t.term === props.term;
};
watch(
  () => editors.pendingFocus && isActiveTab(),
  (on) => {
    if (!on) return;
    editors.pendingFocus = false;
    focusTerminal(props.term);
  },
);

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});
</script>

<template>
  <!-- 브라우저·웹뷰 기본 컨텍스트 메뉴 차단 (사용자 지시 2026-09-09) — 우클릭은 xterm 에 그대로 간다 -->
  <div ref="host" class="terminal-view" :style="{ background: TERMINAL_BACKGROUND }" @contextmenu.prevent />
</template>

<style scoped>
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
/* 스크롤 영역도 같은 배경 — xterm 기본(#000)이 비치지 않게 */
.terminal-view :deep(.xterm .xterm-viewport) {
  background: v-bind(TERMINAL_BACKGROUND) !important;
}
</style>
