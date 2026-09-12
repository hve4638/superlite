// Makefile 문법 — monarch 토크나이저 + 언어 설정 (ticket editor-language-coverage). monaco 에 내장이 없어 둔다.
// 탭으로 시작하는 줄은 레시피(셸) — 그 안은 $(VAR)·$@ 같은 변수만 variable 로 칠하고 나머지는 두며, 앞의
// @·-·+ 접두는 keyword.control. 그 밖의 줄: 지시어(include·ifeq·define…) keyword.control, 변수 대입의 이름
// attribute.name, 타깃(':' 앞) type.identifier, 줄 이어짐 백슬래시 keyword.control.
import type { CustomLanguage } from './index';

const DIRECTIVES = [
  'include', '-include', 'sinclude', 'ifeq', 'ifneq', 'ifdef', 'ifndef', 'else', 'endif', 'define', 'endef',
  'export', 'unexport', 'override', 'private', 'vpath', 'undefine',
];

export const makefile: CustomLanguage = {
  id: 'makefile',
  configuration: {
    comments: { lineComment: '#' },
    brackets: [['(', ')'], ['{', '}']],
    autoClosingPairs: [{ open: '(', close: ')' }, { open: '{', close: '}' }],
  },
  monarch: {
    defaultToken: '',
    tokenPostfix: '.makefile',
    // 줄 끝을 토큰으로 받아야(includeLF) 레시피 상태를 줄 끝에서 닫을 수 있다 — monarch 는 줄 끝에 닿으면
    // 규칙 평가를 멈추므로 /$/ 규칙은 실행되지 않는다
    includeLF: true,
    directives: DIRECTIVES,
    tokenizer: {
      root: [
        // 레시피 줄 — 탭 뒤 @/-/+ 접두
        [/(^\t)([@+-]*)/, ['white', { token: 'keyword.control', next: '@recipe' }]],
        [/[ \t\n]+/, 'white'],
        [/#.*/, 'comment'],
        // 변수 대입 — 이름 뒤에 = := ::= += ?= !=
        [/^[ \t]*[A-Za-z_][\w.-]*(?=\s*(?::{1,2}|[+?!])?=)/, 'attribute.name'],
        // 타깃 — ':' 앞 (':=' 대입은 제외). 여러 타깃·%.o·$(OBJS) 포함
        [/^[^\t\s#=:][^#=:\n]*(?=:(?!=))/, 'type.identifier'],
        [/^-?[a-z]+(?=\s)/, { cases: { '@directives': 'keyword.control', '@default': '' } }],
        { include: '@common' },
      ],
      recipe: [
        [/\n/, 'white', '@pop'],
        [/[^$\\\n]+/, ''],
        { include: '@common' },
      ],
      common: [
        [/\\(?=\n)/, 'keyword.control'], // 줄 이어짐
        [/\$[({]/, 'variable', '@paren'],
        [/\$[@<^?*%+|$]/, 'variable'],
        [/[:=]/, 'delimiter'],
        [/[^\s$\\:=#]+/, ''],
        [/./, ''],
      ],
      // $(…) — 함수 호출은 중첩된다. 안은 통째로 variable
      paren: [
        [/\$[({]/, 'variable', '@push'],
        [/[)}]/, 'variable', '@pop'],
        [/[^$(){}\n]+/, 'variable'],
        [/\n/, 'variable', '@popall'],
        [/./, 'variable'],
      ],
    },
  },
};
