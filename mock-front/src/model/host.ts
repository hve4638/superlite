import { MockBackend } from '../backend/mock';
import { WsBackend } from '../backend/ws';
import type { ThinBackend } from '../backend/types';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점.
//      ?ws → 백엔드 /ws (같은 오리진 — 개발은 vite 프록시, 프론트는 데몬 주소를 모른다).
//      기본은 mock — differential·기존 테스트 경로를 그대로 두기 위해.
export const backend: ThinBackend = new URLSearchParams(location.search).has('ws')
  ? new WsBackend(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  : new MockBackend();
