// HTML 미리보기 스크롤 위치 (ticket tab-switch-view-reload) — 창 단위 모듈 상태. 세션 탭 전환은 본문을 통째로
// 재마운트해 iframe 이 다시 로드되므로, 위치를 컴포넌트 밖에 두고 새 프레임의 load 때 되돌린다.
// 키는 세션 id + path — preview 탭 id(preview:<path>)는 세션 사이에서 겹칠 수 있다.
// ponytail: 세션을 닫으면 그 세션의 항목이 남는다 (좌표 두 개라 무시)

const positions = new Map<string, [number, number]>();

const keyOf = (session: string, path: string) => `${session}\n${path}`;

export function previewScrollOf(session: string, path: string): [number, number] | undefined {
  return positions.get(keyOf(session, path));
}

export function setPreviewScroll(session: string, path: string, pos: [number, number]): void {
  positions.set(keyOf(session, path), pos);
}

export function forgetPreviewScroll(session: string, path: string): void {
  positions.delete(keyOf(session, path));
}
