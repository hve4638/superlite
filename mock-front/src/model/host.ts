import { MockBackend } from '../backend/mock';
import type { ThinBackend } from '../backend/types';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점. Rust core 가 준비되면 여기만 바꾼다.
export const backend: ThinBackend = new MockBackend();
