import { MockBackend } from '../backend/mock';
import { WsBackend } from '../backend/ws';
import type { ThinBackend } from '../backend/types';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점.
//      ?ws → 백엔드 /ws (같은 오리진 — 개발은 vite 프록시, 프론트는 데몬 주소를 모른다).
//      기본은 mock — differential·기존 테스트 경로를 그대로 두기 위해.
const params = new URLSearchParams(location.search);
// 페이지 URL 의 ?tkn= 을 /ws 로 넘긴다 — 백엔드가 SUPERLIGHT_TOKEN 으로 떠 있으면 필수.
// tkn 이 있다는 것 자체가 실 백엔드 의도다 — ?ws 를 빼먹었다고 조용히 mock 이 되지 않게
const tkn = params.get('tkn');
// Tauri 앱은 자산 로드라 location 이 relay 가 아니다 — 주입된 endpoint 가 최우선.
// session id 도 함께 주입된다 — native 세션 레지스트리가 발급한 것만 relay 가 허용한다
const injected = (window as { __SUPERLIGHT_WS__?: string }).__SUPERLIGHT_WS__;
const injectedSession = (window as { __SUPERLIGHT_SESSION__?: string }).__SUPERLIGHT_SESSION__;
// 페이지 URL 의 ?folder= 를 /ws 로 넘긴다 — Fixed(bin) relay 가 이 절대 경로를 root 로 쓴다
// (웹 '폴더 열기' — VS Code web 의 ?folder= 상당)
const wsQuery = new URLSearchParams();
if (tkn !== null) wsQuery.set('tkn', tkn);
const folder = params.get('folder');
if (folder !== null) wsQuery.set('folder', folder);
const wsQs = wsQuery.toString();
export const backend: ThinBackend = injected
  ? new WsBackend(injected, injectedSession)
  : params.has('ws') || tkn !== null
    ? new WsBackend(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${wsQs ? `?${wsQs}` : ''}`,
      )
    : new MockBackend();

/**
 * 웹(브라우저) 모드 '폴더 열기' — 같은 페이지 URL 에서 ?folder= 만 바꾼 주소를 준다.
 * 새 페이지 로드 = 새 세션이다 (세션 전환의 브라우저 형태 — 브라우저 탭이 곧 대등한 창).
 * Tauri(주입 endpoint — root 결정권이 native)·mock 은 해당 없음 — null.
 */
export function openFolderUrl(root: string): string | null {
  if (injected || !(params.has('ws') || tkn !== null)) return null;
  const url = new URL(location.href);
  url.searchParams.set('folder', root);
  return url.toString();
}
