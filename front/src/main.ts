import { createApp } from 'vue';
import '@vscode/codicons/dist/codicon.css';
import './theme/tokens.css';
import './theme/accent.css';
import './theme/base.css';
// WHY: 부팅 세션 생성(활성 컨텍스트)이 UI 모듈 평가보다 앞서야 한다 — ui/editor/terminalHost 의
//      최상위(setTerminalSerializer 등록·allTerminals 워처)가 모듈 평가 시점에 활성 세션의 스토어를
//      읽는다. import 순서가 곧 평가 순서다.
import './model/host';
import Workbench from './ui/Workbench.vue';
import { installKeybindings, setupCommands } from './model/commands';
import { inApp } from './model/window';
import { initOsDrop } from './model/osdrop';
import { initRecents } from './model/recents';
import { hasAnyDirty, initSessions } from './model/sessions';
import { flushAllWorkspaces } from './model/workspaceState';
import { loadSettings } from './model/settings';

setupCommands();
// 사용자 설정(ticket user-settings) — 도착 전까지는 코드 기본값으로 동작한다
void loadSettings();
installKeybindings(window);
initOsDrop();
initSessions();
initRecents();

// WHY: Ctrl+W 등 브라우저 예약 키는 페이지가 가로챌 수 없다 — 미저장 변경이 있으면
//      탭이 닫히기 직전의 확인 대화상자가 마지막 안전망이다. 배경 세션 탭의 dirty 도 지킨다
window.addEventListener('beforeunload', (e) => {
  if (hasAnyDirty()) e.preventDefault();
  // 워크스페이스 상태 마지막 저장 — 웹(localStorage)은 동기로 끝나고, 앱은 닿는 데까지 (디바운스 보완)
  void flushAllWorkspaces();
});

// WHY: 앱에서는 WebView2 기본 컨텍스트 메뉴(뒤로·새로고침·검사)를 어디서도 띄우지 않는다 (VS Code 동일).
//      자체 메뉴를 여는 자리는 각자 .prevent 하므로 영향 없고, 웹은 개발·디버깅용으로 브라우저 메뉴를 둔다.
//      일반 input·textarea 는 예외 — 붙여넣기 메뉴가 필요하다 (사용자 결정 2026-09-12, ticket app-contextmenu-suppress).
//      Monaco·xterm 은 contenteditable/textarea 를 숨겨 쓰지만 자체 메뉴 자리에서 이미 .prevent 한다
if (inApp) {
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    e.preventDefault();
  });
}

// WHY: 초기 로드(트리·git status)를 기다리지 않고 바로 마운트한다 — 큰 워크스페이스는
//      첫 readDir 가 수 초라, 기다리면 그동안 배경색만 보인다. 로드 중임은
//      탐색기의 진행 막대(files.loading)가 알린다 (VS Code 도 셸 먼저, 뷰별 progress)
createApp(Workbench).mount('#app');
