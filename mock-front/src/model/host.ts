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
export const backend: ThinBackend = params.has('ws') || tkn !== null
  ? new WsBackend(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${
        tkn !== null ? `?tkn=${encodeURIComponent(tkn)}` : ''
      }`,
    )
  : new MockBackend();
