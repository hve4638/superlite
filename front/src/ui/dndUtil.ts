/** dragend 시점의 포인터가 이 창(뷰포트) 밖인가 — 창 밖 드롭(= 새 창으로 분리) 판정.
 *  WHY: HTML5 DnD 는 "밖에 놓았다"는 이벤트가 없다 — 출처의 dragend 에서 dropEffect 가
 *       none(아무 존도 안 받음)이고 좌표가 뷰포트 밖이면 그렇게 본다. 창 안 빈 곳에 놓은
 *       취소 드롭은 좌표가 안이라 구분된다 */
export function pointerOutside(e: DragEvent): boolean {
  return e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
}

/** 탭 위 dragover 의 삽입 지점 — 포인터가 탭의 왼쪽 절반이면 그 탭 앞(i), 오른쪽 절반이면 뒤(i+1).
 *  세션 탭(TitleBar)과 편집기 탭(TabBar)이 같은 규칙 (VS Code 동일) */
export function insertIndexAt(e: DragEvent, i: number): number {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientX < rect.left + rect.width / 2 ? i : i + 1;
}

/** 탭을 창 밖에 놓아 새 창으로 분리할 때, 새 창의 탭(35px 스트립)이 포인터 아래 오도록 창을
 *  왼쪽 위로 당기는 오프셋 (screen 좌표). 세션 탭·편집기 탭 공통 */
export const DETACH_DX = 100;
export const DETACH_DY = 17;
