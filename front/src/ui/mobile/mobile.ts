// 모바일 셸 진입 (ticket mobile-shell) — mobile.html 의 스크립트 (index.html/main.ts 와 별개의 vite 진입, relay 가 /mobile 로 서빙).
// WHY: 부팅 세션 생성(활성 컨텍스트)이 UI 모듈 평가보다 앞서야 한다 — termHost 의 최상위 워처가 활성 세션의
//      터미널 목록을 읽는다. import 순서가 곧 평가 순서다 (main.ts 와 같은 규칙)
import '@vscode/codicons/dist/codicon.css';
import '../../theme/tokens.css';
import '../../theme/accent.css';
import '../../theme/base.css';
import '../../model/host';
import { createApp } from 'vue';
import App from './App.vue';
import { hasAnyDirty } from '../../model/sessions';
import { initRecents } from '../../model/recents';
import { trackMobileSessions } from '../../model/mobileSessions';
import { flushAllWorkspaces } from '../../model/workspaceState';

// 미저장 편집이 있으면 탭 닫기·새로고침 직전 확인 (main.ts 와 같다). 워크스페이스 상태(탭·터미널 자리)는 즉시 저장 — 디바운스 중이던
// 변경이 새로고침에 사라지지 않게
window.addEventListener('beforeunload', (e) => {
  if (hasAnyDirty()) e.preventDefault();
  void flushAllWorkspaces();
});

initRecents(); // 최근 폴더(웹은 localStorage) — 워크스페이스 추가 화면이 읽는다
trackMobileSessions(); // 열린 워크스페이스 목록·활성 기억 — 다음 부팅(host.ts)이 그대로 연다
// 홈 화면 설치 조건용 서비스 워커(public/sw.js, 캐시 없음) — 비보안 출처(http 사설 IP)는 등록이 거부되므로 조용히 넘어간다
navigator.serviceWorker?.register('/sw.js').catch(() => {});
createApp(App).mount('#app');
