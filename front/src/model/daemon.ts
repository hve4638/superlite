/**
 * 문제 데몬 강제 정리 확인 — 원격 접속이 '데몬 기동' 단계에서 실패하면(락은 쥔 채 소켓에
 * 응답하지 않는 좀비가 전형) 사용자에게 강제 정리를 묻는다. 자동으로 정리하지 않는다 —
 * 강제 종료는 명시적 승인 하에서만 (사용자 결정 2026-09-04). 실행(백엔드 /daemon/clean
 * 호출·재접속)은 조립 지점 host.ts 의 confirmDaemonClean 이 맡는다 — 여기는 상태만
 * (watch → daemon → host 순환 import 회피).
 */
import { shallowReactive } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';

// WHY: shallowReactive — reactive 는 pending 의 백엔드 객체를 Proxy 로 감싸 세션의 백엔드와
//      === 비교(rootOfBackend)가 깨진다 (실측: host 를 못 찾아 로컬 정리로 떨어졌다)
export const daemonClean = shallowReactive({
  /** 확인 대기 중인 실패 세션의 백엔드 — null 이면 대화상자 없음 */
  pending: null as ThinBackend | null,
  /** 정리 요청이 백엔드에 나가 있는 동안 (대화상자는 닫힌 뒤) */
  busy: false,
});

/** 확인 대화상자 열기 — 이미 하나가 떠 있으면 나중 것은 무시 (모달 하나) */
export function promptDaemonClean(backend: ThinBackend): void {
  if (daemonClean.pending !== null || daemonClean.busy) return;
  daemonClean.pending = backend;
}

export function cancelDaemonClean(): void {
  daemonClean.pending = null;
}
