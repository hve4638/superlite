/**
 * URL 탭의 뒤로/앞으로 장부 (ticket browser-tab-iframe) — 창 단위 모듈 상태.
 *
 * cross-origin iframe 의 이력은 부모 창의 공동 세션 이력(joint session history)에 쌓이고 부모의
 * history.back()/forward() 로만 움직인다. 그 이력에는 앱 페이지 자체의 항목도 있어 iframe 첫 로드 밑으로
 * 내려가면 앱 페이지가 떠난다 (조사 실측 about:blank). 그래서 iframe 항해로 생긴 항목만 여기서 센다 —
 * 한 창의 URL 탭 여럿이 같은 공동 이력을 공유하므로 항목마다 어느 탭의 것인지 적고, 꼭대기(현재 위치 바로
 * 아래)가 자기 항목일 때만 뒤로를, 바로 위가 자기 항목일 때만 앞으로를 허용한다.
 *
 * 항목 추가 판정은 iframe load 이벤트 + history.length 로 한다. load 는 항해마다 오지만 location.replace·
 * 리다이렉트는 항목을 만들지 않으므로 length 가 base+cur+1 로 늘었을 때만 push 한다. 같은 문서 항해
 * (pushState·해시)는 load 가 없어 세지 못한다 — 그만큼 적게 세어 뒤로가 일찍 꺼질 뿐 앱 페이지를 떠나지는
 * 않는다 (과소 계수는 안전, 과다 계수만 위험).
 */
import { reactive } from 'vue';

const nav = reactive({
  /** 공동 이력 중 URL 탭 항해로 생긴 항목의 소유 탭 id, 오래된 순 */
  stack: [] as string[],
  /** stack 중 현재 위치 이하로 적용된 항목 수 — stack[cur-1] 이 바로 아래(뒤로 대상), stack[cur] 이 앞으로 대상 */
  cur: 0,
  /** stack 이 비었을 때의 history.length — 앱 페이지 자체까지의 길이 */
  base: 0,
  /** 우리가 부른 back/forward 로 인한 load 를 새 항해로 세지 않기 위한 표식 (탭 id) */
  pending: null as string | null,
});

export function canGoBack(tabId: string): boolean {
  return nav.cur > 0 && nav.stack[nav.cur - 1] === tabId;
}
export function canGoForward(tabId: string): boolean {
  return nav.cur < nav.stack.length && nav.stack[nav.cur] === tabId;
}
export function goBack(tabId: string): void {
  if (!canGoBack(tabId)) return;
  nav.cur--;
  nav.pending = tabId;
  history.back();
}
export function goForward(tabId: string): void {
  if (!canGoForward(tabId)) return;
  nav.cur++;
  nav.pending = tabId;
  history.forward();
}

/** iframe load. first = 새로 만든 프레임 요소의 첫 로드 — 초기 항해는 항목을 만들지 않으므로(replace) 세지 않고,
 *  장부가 비어 있으면 그때의 history.length 를 base 로 삼는다. 그 외에는 우리 back/forward 의 결과면 표식만
 *  지우고, 새 항해로 항목이 늘었으면 앞으로 항목을 버리고 push */
export function onFrameLoad(tabId: string, first: boolean): void {
  if (first) {
    if (nav.stack.length === 0) nav.base = history.length;
    return;
  }
  if (nav.pending === tabId) {
    nav.pending = null;
    return;
  }
  if (history.length === nav.base + nav.cur + 1) {
    nav.stack.splice(nav.cur, Infinity, tabId);
    nav.cur = nav.stack.length;
  }
}

/** iframe 제거(탭 닫힘·새로고침으로 재생성) — 그 프레임의 항목은 공동 이력에서 빠지므로 장부에서도 뺀다 */
export function onFrameGone(tabId: string): void {
  let below = 0;
  for (let i = 0; i < nav.cur; i++) if (nav.stack[i] === tabId) below++;
  nav.stack = nav.stack.filter((id) => id !== tabId);
  nav.cur -= below;
  if (nav.pending === tabId) nav.pending = null;
}
