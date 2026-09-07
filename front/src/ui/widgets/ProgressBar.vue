<script setup lang="ts">
// VS Code 의 무한 진행선(progressbar.css infinite) — 2px 파란 막대가 영역 폭을 왼쪽→오른쪽으로
// 4초 주기로 흐른다. 항상 "제목 영역 바로 아래 본문" 의 첫 자식으로 두고, 부모는 position: relative —
// top: -2px 로 제목 영역의 아래 2px 에 겹친다 (part.css top: 33px / paneviewlet.css top: -2px 과 동일).
// 표시·숨김은 부모의 v-if 가 한다 (VS Code 도 done 시 페이드 없이 200ms 뒤 off)
</script>

<template>
  <div class="progress-line">
    <div class="progress-bit" />
  </div>
</template>

<style scoped>
.progress-line {
  position: absolute;
  left: 0;
  top: -2px;
  width: 100%;
  height: 2px;
  overflow: hidden; /* keep progress bit in bounds */
  z-index: 5;
  pointer-events: none;
}
.progress-bit {
  position: absolute;
  top: 0;
  left: 0;
  width: 2%;
  height: 2px;
  background: var(--vscode-progressBar-background);
  animation: progress-infinite 4s linear infinite;
  transform: translate3d(0, 0, 0);
}
/* 막대 폭이 컨테이너의 2% 라 translateX 는 그 배수 — 50% 지점 2500%(가운데, 3배 늘림), 끝 4900% */
@keyframes progress-infinite {
  from { transform: translateX(0%) scaleX(1); }
  50% { transform: translateX(2500%) scaleX(3); }
  to { transform: translateX(4900%) scaleX(1); }
}
</style>
