/**
 * 셸 선택 (ticket mobile-shell) — 뷰포트 폭이 아니라 명시적 진입 경로로 가른다 (decision/mobile.md).
 * `/mobile`(relay 라우트) 또는 `/mobile.html`(vite dev·자산 직접 로드)이면 모바일 전용 셸(ui/mobile, 진입 mobile.html), 그 밖은
 * 데스크톱 워크벤치. host.ts 가 이 값으로 워크스페이스 상태 저장·복원을 끌지 정한다. 후속 mobile-apk(Tauri Android)도 같은 경로로 들어온다
 */
export const mobileShell: boolean = /^\/mobile(\.html|\/)?$/.test(location.pathname);
