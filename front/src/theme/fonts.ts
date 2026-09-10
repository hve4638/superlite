// 에디터·터미널 폰트 기본값의 단일 소스.
// WHY: 값은 VS Code(Linux) 기본값 그대로다 — 레퍼런스 소스
//      fontInfo.ts (DEFAULT_LINUX_FONT_FAMILY, fontSize 14, lineHeight 자동 = round(1.35*14)=19),
//      terminal.ts (DEFAULT_LINE_HEIGHT: Linux 1.1), terminalConfiguration.ts (fontSize 14).
//      터미널 fontFamily 기본값은 editor.fontFamily 를 따른다 (VS Code 동일).

// Consolas 는 Windows 쪽 고정폭(라틴), 그 뒤 한글은 동봉 'Superlite Hangul'(D2Coding 한글 서브셋, base.css
// @font-face — unicode-range 라 한글에만 걸린다. 사용자 결정 2026-09-10: 영문 Consolas + 한글 D2Coding),
// 없으면 맑은 고딕. 순서가 뒤집히면 라틴까지 비례폭으로 렌더링되므로 고정폭이 먼저 온다.
export const MONO_FONT_FAMILY =
  "'Droid Sans Mono', Consolas, 'Superlite Hangul', 'Malgun Gothic', '맑은 고딕', monospace";

export const EDITOR_FONT_SIZE = 14;

// 터미널은 Windows Terminal 기본값을 따른다 (사용자 방향 2026-09-07, terminal-usability):
// Cascadia Mono 12pt(=16px), 줄 높이 1.2. 시스템본(Windows 10/11 은 Terminal 과 함께 설치)을
// 먼저 잡고, 없으면 동봉본 'Cascadia Mono Bundled'(base.css @font-face, OFL) — 어느 기기에서든
// 같은 글꼴이 나온다. 한글은 Cascadia 에 없어 맑은 고딕 폴백이 받는다
export const TERMINAL_FONT_FAMILY =
  "'Cascadia Mono', 'Cascadia Code', 'Cascadia Mono Bundled', Consolas, 'Droid Sans Mono', 'Malgun Gothic', '맑은 고딕', monospace";
export const TERMINAL_FONT_SIZE = 16;
export const TERMINAL_LINE_HEIGHT = 1.2;
