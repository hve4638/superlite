// tmux.conf 문법 — monarch 토크나이저 + 언어 설정 (ticket config-editors). 토큰 이름은 테마의 공통 규칙
// (comment·keyword·string·number·variable·type.identifier·attribute.name)만 써서 테마에 언어별 규칙을 더하지 않는다.
import type { CustomLanguage } from './index';

/** 명령 이름 — tmux(1) 의 명령과 별칭. 줄 머리·';' 뒤·'{' 블록 안에서 keyword */
const COMMANDS = [
  'attach-session', 'attach', 'bind-key', 'bind', 'break-pane', 'breakp', 'capture-pane', 'capturep', 'choose-buffer',
  'choose-client', 'choose-tree', 'clear-history', 'clearhist', 'clock-mode', 'command-prompt', 'confirm-before', 'confirm',
  'copy-mode', 'delete-buffer', 'deleteb', 'detach-client', 'detach', 'display-menu', 'menu', 'display-message', 'display',
  'display-panes', 'displayp', 'display-popup', 'popup', 'find-window', 'findw', 'has-session', 'has', 'if-shell', 'if',
  'join-pane', 'joinp', 'kill-pane', 'killp', 'kill-server', 'kill-session', 'kill-window', 'killw', 'last-pane', 'lastp',
  'last-window', 'last', 'link-window', 'linkw', 'list-buffers', 'lsb', 'list-clients', 'lsc', 'list-commands', 'lscm',
  'list-keys', 'lsk', 'list-panes', 'lsp', 'list-sessions', 'ls', 'list-windows', 'lsw', 'load-buffer', 'loadb',
  'lock-client', 'lockc', 'lock-server', 'lock', 'lock-session', 'locks', 'move-pane', 'movep', 'move-window', 'movew',
  'new-session', 'new', 'new-window', 'neww', 'next-layout', 'nextl', 'next-window', 'next', 'paste-buffer', 'pasteb',
  'pipe-pane', 'pipep', 'previous-layout', 'prevl', 'previous-window', 'prev', 'refresh-client', 'refresh',
  'rename-session', 'rename', 'rename-window', 'renamew', 'resize-pane', 'resizep', 'resize-window', 'resizew',
  'respawn-pane', 'respawnp', 'respawn-window', 'respawnw', 'rotate-window', 'rotatew', 'run-shell', 'run',
  'save-buffer', 'saveb', 'select-layout', 'selectl', 'select-pane', 'selectp', 'select-window', 'selectw', 'send-keys',
  'send', 'send-prefix', 'server-access', 'set-buffer', 'setb', 'set-environment', 'setenv', 'set-hook', 'set-option',
  'set', 'set-window-option', 'setw', 'show-buffer', 'showb', 'show-environment', 'showenv', 'show-hooks', 'show-messages',
  'showmsgs', 'show-options', 'show', 'show-window-options', 'showw', 'source-file', 'source', 'split-window', 'splitw',
  'start-server', 'start', 'suspend-client', 'suspendc', 'swap-pane', 'swapp', 'swap-window', 'swapw', 'switch-client',
  'switchc', 'unbind-key', 'unbind', 'unlink-window', 'unlinkw', 'wait-for', 'wait',
];

export const tmux: CustomLanguage = {
  id: 'tmux',
  configuration: {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
    ],
  },
  monarch: {
    defaultToken: '',
    tokenPostfix: '.tmux',
    // 줄 끝을 토큰으로 받아야(includeLF) 인자 상태를 줄 끝에서 닫을 수 있다 — monarch 는 줄 끝에 닿으면 규칙 평가를
    // 멈추므로 /$/ 규칙은 실행되지 않았다 (editor-language-coverage 에서 발견)
    includeLF: true,
    commands: COMMANDS,
    tokenizer: {
      // 줄 머리 = 명령 자리. 명령 뒤는 인자 상태 — ';' 나 '{' 가 다시 명령 자리를 연다
      root: [
        [/\s+/, 'white'],
        [/#.*/, 'comment'],
        [/[{}]/, '@brackets'],
        [/;/, 'delimiter'],
        [/[a-zA-Z][\w-]*/, { cases: { '@commands': { token: 'keyword', next: '@args' }, '@default': { token: 'identifier', next: '@args' } } }],
        { include: '@value' },
      ],
      args: [
        [/[ \t]+/, 'white'],
        [/\\\n/, 'keyword.control'], // 줄 이어짐 — 줄 끝을 같이 삼켜 인자 상태를 유지
        [/\n/, 'white', '@pop'],
        [/#.*/, 'comment', '@pop'],
        [/;/, 'delimiter', '@pop'],
        [/\{/, '@brackets', '@pop'],
        [/\}/, '@brackets'],
        // 플래그: -g, -ga, -n, -T prefix …
        [/-[a-zA-Z]+\b/, 'attribute.name'],
        // 키 이름: C-b, M-x, MouseDown3Pane, Enter, F1 …
        [/\b(?:[CMS]-)+\S+/, 'type.identifier'],
        [/\b(?:Mouse(?:Down|Up|Drag|DragEnd)\d\w+|Wheel(?:Up|Down)\w*|DoubleClick\d\w+|TripleClick\d\w+|Enter|Escape|Space|Tab|BSpace|BTab|Up|Down|Left|Right|Home|End|PageUp|PageDown|IC|DC|F\d{1,2})\b/, 'type.identifier'],
        { include: '@value' },
      ],
      value: [
        [/"/, 'string', '@dstring'],
        [/'/, 'string', '@sstring'],
        [/#\{/, 'variable', '@format'],
        [/#\[[^\]]*\]/, 'variable'], // #[align=centre] 스타일 지시
        [/#[#hHDFIPSTW]/, 'variable'],
        [/\$\{?[\w]+\}?/, 'variable'],
        [/\b(?:on|off|yes|no|none|None|latest|largest|smallest|manual)\b/, 'keyword.control'],
        [/\b\d+(?:\.\d+)?%?\b/, 'number'],
        [/[\w.,:=+*/@|<>~-]+/, ''],
      ],
      dstring: [
        [/#\{/, 'variable', '@format'],
        [/#\[[^\]]*\]/, 'variable'],
        [/[^"#\\]+/, 'string'],
        [/\\./, 'string.escape'],
        [/#/, 'string'],
        [/"/, 'string', '@pop'],
      ],
      sstring: [
        [/[^']+/, 'string'],
        [/'/, 'string', '@pop'],
      ],
      // #{…} 포맷 — 중첩 허용
      format: [
        [/#\{/, 'variable', '@push'],
        [/\}/, 'variable', '@pop'],
        [/[^{}#]+/, 'variable'],
        [/#/, 'variable'],
      ],
    },
  },
};
