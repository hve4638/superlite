<script setup lang="ts">
import { onMounted, ref } from 'vue';

// 전체화면 토글 (사용자 결정 2026-09-14) — 브라우저 탭에서 주소창·탭 스트립 자리를 되찾는다. 설치(PWA·APK)가 아니라 Fullscreen API 라
// 그 탭 안에서만이고 뒤로가기·알림 창으로 풀린다. 모든 화면의 헤더 오른쪽 끝에 둔다 — 터미널 안에서 풀렸을 때 나갔다 들어오지 않게.
// 홈 화면에 설치된 앱(standalone — mobile.webmanifest)은 처음부터 주소창이 없어 버튼을 그리지 않는다 (2026-09-15)
const installed = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
const on = ref(document.fullscreenElement !== null);
onMounted(() => document.addEventListener('fullscreenchange', () => (on.value = document.fullscreenElement !== null)));
function toggle(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
</script>

<template>
  <button v-if="!installed" class="m-icon-btn" :title="on ? 'Exit fullscreen' : 'Fullscreen'" @click="toggle">
    <span class="codicon" :class="on ? 'codicon-screen-normal' : 'codicon-screen-full'" />
  </button>
</template>
