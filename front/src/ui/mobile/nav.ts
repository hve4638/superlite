import { reactive } from 'vue';

/**
 * 모바일 셸 화면 이동 — 하단 탭 다섯(Workspace·파일·세션·Git·Editor)을 번갈아 보인다. 파일·세션·Git 은 데스크톱 사이드바 뷰릿에
 * 해당하고 Editor 는 편집기 영역(열린 탭 전부), Workspace 는 데스크톱 세션 탭 줄(열린 워크스페이스 전환·추가·닫기, 사용자 결정
 * 2026-09-15)이다. 사이드바 탭·Workspace 에서 무엇을 고르면 goTo('editor') 로 넘어간다 (사용자 결정 2026-09-14).
 * 탭 전환마다 history 에 항목을 쌓아 Android 뒤로가기 제스처·APK 의 뒤로 버튼이 앱을 닫는 대신 직전 탭으로 돌아간다
 */
export type Tab = 'files' | 'sessions' | 'scm' | 'editor' | 'workspace';

export const nav = reactive({ tab: 'sessions' as Tab });

export function goTo(tab: Tab): void {
  if (nav.tab === tab) return;
  nav.tab = tab;
  history.pushState({ tab }, '');
}

history.replaceState({ tab: nav.tab }, '');
window.addEventListener('popstate', (e) => {
  const tab = (e.state as { tab?: Tab } | null)?.tab;
  if (tab) nav.tab = tab;
});
