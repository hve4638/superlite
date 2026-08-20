import { MockBackend } from '../backend/mock';
import { WsBackend } from '../backend/ws';
import type { ThinBackend } from '../backend/types';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점.
//      ?ws → 로컬 데몬(8794). 기본은 mock — differential·기존 테스트 경로를 그대로 두기 위해.
export const backend: ThinBackend = new URLSearchParams(location.search).has('ws')
  ? new WsBackend(`ws://${location.hostname}:8794`)
  : new MockBackend();
