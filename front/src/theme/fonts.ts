// 에디터·터미널 폰트 기본값의 단일 소스.
// WHY: 값은 VS Code(Linux) 기본값 그대로다 — 레퍼런스 소스
//      fontInfo.ts (DEFAULT_LINUX_FONT_FAMILY, fontSize 14, lineHeight 자동 = round(1.35*14)=19),
//      terminal.ts (DEFAULT_LINE_HEIGHT: Linux 1.1), terminalConfiguration.ts (fontSize 14).
//      터미널 fontFamily 기본값은 editor.fontFamily 를 따른다 (VS Code 동일).

export const MONO_FONT_FAMILY = "'Droid Sans Mono', monospace";

export const EDITOR_FONT_SIZE = 14;

export const TERMINAL_FONT_SIZE = 14;
export const TERMINAL_LINE_HEIGHT = 1.1;
