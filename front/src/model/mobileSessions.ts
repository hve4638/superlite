import { effect } from '@vue/reactivity';
import { sessions } from './sessions';

/**
 * 모바일 셸의 열린 워크스페이스 기억 (ticket mobile-shell, 사용자 결정 2026-09-15) — 웹 세션 목록은 페이지 수명이라 새로고침·재시작이면
 * 서버 기본 root 하나로 돌아간다. 폰은 늘 같은 브라우저라 열어 둔 root 목록과 활성 root 를 localStorage 에 두고 host.ts 가 부팅
 * 세션을 그것으로 만든다 (탭·터미널은 workspaceState 가 root 별로 되살린다). 빈 세션(root null)·아직 root 를 모르는 부팅 세션('')은
 * 싣지 않는다. 데스크톱 웹은 자동 복원이 없다(app-empty-session) — 이 모듈은 모바일 진입(mobile.ts)만 부른다
 */
const KEY = 'superlite.mobile.sessions';
export type MobileSessions = { version: 1; roots: string[]; active: string | null };

export function loadMobileSessions(): MobileSessions | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '') as MobileSessions;
    if (p.version === 1 && Array.isArray(p.roots)) return p;
  } catch {
    // 없음·파싱 실패
  }
  return null;
}

/** 세션 목록·활성 변화를 따라가며 저장한다 (effect — sessions.list 의 root 와 activeId 를 읽는다) */
export function trackMobileSessions(): void {
  effect(() => {
    const roots = sessions.list.map((t) => t.root).filter((r): r is string => r !== null && r !== '');
    const active = sessions.list.find((t) => t.id === sessions.activeId)?.root ?? null;
    if (roots.length === 0) return; // 부팅 직후(root 미확정) — 지난 기억을 지우지 않는다
    const s: MobileSessions = { version: 1, roots, active: active !== '' ? active : null };
    localStorage.setItem(KEY, JSON.stringify(s));
  });
}
