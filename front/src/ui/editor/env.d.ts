/// <reference types="vite/client" />

// monaco 내부 모듈 — 폰트 실측 캐시 영속화(monaco.ts)용. 패키지가 타입을 배포하지
// 않아 여기서 최소 표면만 선언한다 (exports map 'monaco-editor/*' → 'esm/vs/*.js').
declare module 'monaco-editor/editor/browser/config/fontMeasurements' {
  export const FontMeasurements: {
    _writeToCache(targetWindow: Window, item: unknown, value: unknown): void;
    _ensureCache(targetWindow: Window): { getValues(): { isTrusted: boolean }[] };
  };
}
declare module 'monaco-editor/editor/common/config/fontInfo' {
  export class FontInfo {
    constructor(opts: unknown, isTrusted: boolean);
  }
  export const SERIALIZED_FONT_INFO_VERSION: number;
}
// 내장 markdown monarch 정의 — 제목 토큰 교체(monaco.ts)용
declare module 'monaco-editor/languages/definitions/markdown/markdown' {
  import type { languages } from 'monaco-editor';
  export const language: languages.IMonarchLanguage;
  export const conf: languages.LanguageConfiguration;
}
