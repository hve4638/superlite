<script setup lang="ts">
import type { DotSpec } from '../../model/agent';
import type { TerminalInstance } from '../../model/terminal';

// 터미널 상태 배지 (ticket agent-hooks-status) — 탭·카드 행·사이드바 행·세션 탭이 같은 표식을 그린다.
// dot 은 model/agent 가 정한다 (사용자 결정 2026-09-14): 파랑 running·노랑 needsInput·초록 stopped(응답 마침, 안 봄)·회색
// idle(봄)·빨강 닫기 요청, exited 는 점 없음. 둘(a/b)이면 30도 기울인 경계로 반 갈라 그린다 (탭·세션 요약의 노랑/초록 혼합). 링·토스트 없음 (사용자 지시
// 2026-09-14). 바닥 신호는 별도 — 벨은 종 아이콘, 활동은 작은 흰 점
const props = defineProps<{ inst?: TerminalInstance; dot: DotSpec | null }>();
const COLOR: Record<DotSpec['a'], string> = {
  yellow: 'var(--vscode-charts-yellow, #e5c100)',
  green: 'var(--vscode-charts-green, #89d185)',
  red: 'var(--vscode-charts-red, #f14c4c)',
  blue: 'var(--vscode-charts-blue, #3794ff)',
  gray: 'var(--vscode-descriptionForeground, #8b949e)',
};
const LABEL: Record<DotSpec['a'], string> = { yellow: 'needs input', green: 'stopped (not seen)', red: 'close requested', blue: 'running', gray: 'idle' };
function style(d: DotSpec): Record<string, string> {
  // CSS 각도는 0deg 가 위 — 수평에서 30도 기울인 경계는 120deg
  const bg = d.b ? `linear-gradient(120deg, ${COLOR[d.a]} 50%, ${COLOR[d.b]} 50%)` : COLOR[d.a];
  return { background: bg, color: COLOR[d.a] };
}
function title(): string {
  const parts: string[] = [];
  if (props.inst?.bell) parts.push('bell');
  else if (props.inst?.activity) parts.push('activity');
  if (props.dot) parts.push(props.dot.b ? `${LABEL[props.dot.a]} / ${LABEL[props.dot.b]}` : LABEL[props.dot.a]);
  return parts.join(' · ');
}
</script>

<template>
  <span v-if="inst?.bell || inst?.activity || dot" class="term-badge" :title="title()">
    <span v-if="inst?.bell" class="codicon codicon-bell-dot bell" />
    <span v-else-if="inst?.activity" class="dot activity" />
    <span v-if="dot" class="dot" :class="[dot.a, { split: !!dot.b }]" :style="style(dot)" />
  </span>
</template>

<style scoped>
.term-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 4px;
  flex-shrink: 0;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-sizing: border-box;
}
.dot.activity {
  width: 5px;
  height: 5px;
  background: var(--vscode-foreground);
  opacity: 0.7;
}
.dot.blue {
  animation: term-badge-pulse 1.6s ease-in-out infinite;
}
.dot.gray {
  opacity: 0.5;
}
.bell {
  font-size: 12px;
  color: var(--vscode-charts-yellow, #cca700);
}
@keyframes term-badge-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
