// TOML 문법 — monarch 토크나이저 + 언어 설정 (ticket editor-language-coverage). monaco 에 내장이 없어 둔다.
// 테이블 머리([table]·[[array]]) type.identifier, 키 attribute.name, 문자열(기본·리터럴·여러 줄) string,
// 숫자·날짜 number, true/false keyword.control — 토큰 이름은 테마의 공통 규칙만 쓴다.
import type { CustomLanguage } from './index';

export const toml: CustomLanguage = {
  id: 'toml',
  configuration: {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
    ],
  },
  monarch: {
    defaultToken: '',
    tokenPostfix: '.toml',
    tokenizer: {
      root: [
        [/\s+/, 'white'],
        [/#.*$/, 'comment'],
        // 테이블 머리 — 줄에 머리만 있을 때 (여러 줄 배열 안의 [1, 2] 줄과 구분)
        [/^\s*\[\[?[^\]]*\]\]?(?=\s*(?:#|$))/, 'type.identifier'],
        [/"""/, 'string', '@mlBasic'],
        [/'''/, 'string', '@mlLiteral'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        // 날짜·시각 (RFC 3339 / 지역 날짜·시각) — 숫자보다 먼저
        [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/, 'number'],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, 'number'],
        [/[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|inf|nan|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d[\d_]*)?)\b/, 'number'],
        [/\b(?:true|false)\b/, 'keyword.control'],
        // 키 — '=' 또는 점(점 구분 키)이 뒤따르는 낱말
        [/[A-Za-z0-9_-]+(?=\s*[.=])/, 'attribute.name'],
        [/[{}[\]]/, '@brackets'],
        [/[=,.]/, 'delimiter'],
        [/[A-Za-z0-9_-]+/, ''],
      ],
      mlBasic: [
        [/"""/, 'string', '@pop'],
        [/\\./, 'string.escape'],
        [/[^"\\]+/, 'string'],
        [/"/, 'string'],
      ],
      mlLiteral: [
        [/'''/, 'string', '@pop'],
        [/[^']+/, 'string'],
        [/'/, 'string'],
      ],
    },
  },
};
