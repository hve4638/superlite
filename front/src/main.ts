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
import { hasAnyDirty, initSessions } from './model/sessions';

setupCommands();
installKeybindings(window);
initOsDrop();
initSessions();

// WHY: Ctrl+W 등 브라우저 예약 키는 페이지가 가로챌 수 없다 — 미저장 변경이 있으면
//      탭이 닫히기 직전의 확인 대화상자가 마지막 안전망이다. 배경 세션 탭의 dirty 도 지킨다
window.addEventListener('beforeunload', (e) => {
  if (hasAnyDirty()) e.preventDefault();
});

// WHY: 초기 로드(트리·git status)를 기다리지 않고 바로 마운트한다 — 큰 워크스페이스는
//      첫 readDir/listFiles 가 수 초라, 기다리면 그동안 배경색만 보인다. 로드 중임은
//      탐색기의 진행 막대(files.loading)가 알린다 (VS Code 도 셸 먼저, 뷰별 progress)
createApp(Workbench).mount('#app');
