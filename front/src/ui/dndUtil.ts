/** dragend 시점의 포인터가 이 창(뷰포트) 밖인가 — 창 밖 드롭(= 새 창으로 분리) 판정.
 *  WHY: HTML5 DnD 는 "밖에 놓았다"는 이벤트가 없다 — 출처의 dragend 에서 dropEffect 가
 *       none(아무 존도 안 받음)이고 좌표가 뷰포트 밖이면 그렇게 본다. 창 안 빈 곳에 놓은
 *       취소 드롭은 좌표가 안이라 구분된다 */
export function pointerOutside(e: DragEvent): boolean {
  return e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
}
