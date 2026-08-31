/**
 * 활성 세션 컨텍스트 — 페이지 하나가 세션(워크스페이스) 컨텍스트를 여럿 들 수 있고
 * (세션 탭), UI·커맨드는 활성 컨텍스트 하나만 본다. 세션 전환 = activeCtx 교체 —
 * shallowRef 라 shim 을 읽던 모든 effect 가 새 세션 상태로 재실행된다.
 * WHY: 모듈 순환을 끊는 leaf — 각 model 모듈의 shim 은 여기만 import 하고,
 *      세션 조립(session.ts)은 각 모듈의 팩토리를 import 한다.
 */
import { shallowRef } from '@vue/reactivity';
import type { SessionCtx } from './session';

export const activeCtx = shallowRef<SessionCtx | null>(null);

/** 활성 세션 — 부팅(host.ts 평가)이 첫 세션을 세운 뒤에만 유효하다 */
export function ctx(): SessionCtx {
  const c = activeCtx.value;
  if (!c) throw new Error('활성 세션이 없다 — model 호출이 host.ts 부팅보다 앞섰다');
  return c;
}

/**
 * 활성 세션의 객체를 종전 모듈 싱글턴 이름 그대로 노출하는 전달 프록시.
 * 접근마다 getter 를 거치므로 활성 세션 교체가 그대로 반영되고, getter 안의
 * activeCtx 읽기가 반응성 의존으로 잡혀 전환 시 구독 effect 가 재실행된다.
 */
export function viewOf<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_, key) {
      const target = get() as Record<PropertyKey, unknown>;
      const v = target[key];
      // 메서드는 실 객체에 바인딩 — WsBackend 처럼 this 를 쓰는 클래스 인스턴스 대비
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    set(_, key, value) {
      (get() as Record<PropertyKey, unknown>)[key] = value;
      return true;
    },
    has: (_, key) => key in get(),
    deleteProperty(_, key) {
      delete (get() as Record<PropertyKey, unknown>)[key];
      return true;
    },
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor(_, key) {
      const d = Reflect.getOwnPropertyDescriptor(get(), key);
      // 실 객체의 non-configurable 속성이 더미 target 과 충돌하지 않게
      return d ? { ...d, configurable: true } : undefined;
    },
  });
}
