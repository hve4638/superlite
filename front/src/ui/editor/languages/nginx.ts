// nginx 설정 문법 — monarch 토크나이저 + 언어 설정 (ticket editor-language-coverage). monaco 에 내장이 없어 둔다.
// 지시어 자리(줄 머리·';'·'{'·'}' 뒤)의 낱말은 keyword, 블록을 여는 지시어(http·server·location…)는
// keyword.control, $변수 variable, on/off keyword.control, 숫자(단위 접미 포함) number, 따옴표 문자열 string.
// 지시어는 ';' 나 '{' 까지 여러 줄에 걸칠 수 있어 줄 끝에서 인자 상태를 닫지 않는다.
import type { CustomLanguage } from './index';

const BLOCKS = ['events', 'http', 'server', 'location', 'upstream', 'if', 'map', 'geo', 'types', 'limit_except', 'stream', 'mail', 'split_clients', 'match'];

export const nginx: CustomLanguage = {
  id: 'nginx',
  configuration: {
    comments: { lineComment: '#' },
    brackets: [['{', '}']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
    ],
  },
  monarch: {
    defaultToken: '',
    tokenPostfix: '.nginx',
    blocks: BLOCKS,
    tokenizer: {
      root: [
        [/\s+/, 'white'],
        [/#.*$/, 'comment'],
        [/[{}]/, '@brackets'],
        [/;/, 'delimiter'],
        [/[a-zA-Z_][\w.-]*/, { cases: { '@blocks': { token: 'keyword.control', next: '@args' }, '@default': { token: 'keyword', next: '@args' } } }],
      ],
      args: [
        [/\s+/, 'white'],
        [/#.*$/, 'comment'],
        [/;/, 'delimiter', '@pop'],
        [/[{}]/, '@brackets', '@pop'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/'(?:[^'\\]|\\.)*'/, 'string'],
        [/\$\{?\w+\}?/, 'variable'],
        [/\b(?:on|off)\b/, 'keyword.control'],
        [/\b\d+(?:\.\d+)?[kKmMgGsShHdDwWyY]?\b/, 'number'],
        // location 수식어 (= ~ ~* ^~)
        [/(?:\^~|~\*|~|=)(?=\s)/, 'delimiter'],
        [/[^\s;{}#"'$]+/, ''],
      ],
    },
  },
};
