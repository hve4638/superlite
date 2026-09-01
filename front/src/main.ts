import { createApp } from 'vue';
import '@vscode/codicons/dist/codicon.css';
import './theme/tokens.css';
import './theme/base.css';
// WHY: 부팅 세션 생성(활성 컨텍스트)이 UI 모듈 평가보다 앞서야 한다 — TerminalPane 등이
//      모듈 평가 시점에 활성 세션의 스토어를 읽는다. import 순서가 곧 평가 순서다.
import './model/host';
import Workbench from './ui/Workbench.vue';
import { installKeybindings, setupCommands } from './model/commands';
import { initOsDrop } from './model/osdrop';
import { bootReady, hasAnyDirty, initSessions } from './model/sessions';

setupCommands();
installKeybindings(window);
initOsDrop();
initSessions();

// WHY: Ctrl+W 등 브라우저 예약 키는 페이지가 가로챌 수 없다 — 미저장 변경이 있으면
//      탭이 닫히기 직전의 확인 대화상자가 마지막 안전망이다. 배경 세션 탭의 dirty 도 지킨다
window.addEventListener('beforeunload', (e) => {
  if (hasAnyDirty()) e.preventDefault();
});

// 부팅 세션들의 초기 데이터 로드 후 마운트 — 부팅 시 빈 셸이 깜빡이는 것을 피한다
await bootReady();

createApp(Workbench).mount('#app');
