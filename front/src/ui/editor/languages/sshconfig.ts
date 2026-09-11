// ssh_config(5) 문법 — monarch 토크나이저 + 언어 설정 (ticket config-editors). Host/Match 블록 머리는
// keyword.control, 그 외 키워드는 keyword (대소문자 무관), 패턴의 * ? ! 는 type.identifier.
import type { CustomLanguage } from './index';

const BLOCKS = ['host', 'match'];
const KEYWORDS = [
  'addkeystoagent', 'addressfamily', 'batchmode', 'bindaddress', 'bindinterface', 'canonicaldomains',
  'canonicalizefallbacklocal', 'canonicalizehostname', 'canonicalizemaxdots', 'canonicalizepermittedcnames',
  'casignaturealgorithms', 'certificatefile', 'checkhostip', 'ciphers', 'clearallforwardings', 'compression',
  'connectionattempts', 'connecttimeout', 'controlmaster', 'controlpath', 'controlpersist', 'dynamicforward',
  'enableescapecommandline', 'enablesshkeysign', 'escapechar', 'exitonforwardfailure', 'fingerprinthash', 'forkafterauthentication',
  'forwardagent', 'forwardx11', 'forwardx11timeout', 'forwardx11trusted', 'gatewayports', 'globalknownhostsfile',
  'gssapiauthentication', 'gssapidelegatecredentials', 'hashknownhosts', 'hostbasedacceptedalgorithms',
  'hostbasedauthentication', 'hostkeyalgorithms', 'hostkeyalias', 'hostname', 'identitiesonly', 'identityagent',
  'identityfile', 'ignoreunknown', 'include', 'ipqos', 'kbdinteractiveauthentication', 'kbdinteractivedevices',
  'kexalgorithms', 'knownhostscommand', 'localcommand', 'localforward', 'loglevel', 'logverbose', 'macs',
  'nohostauthenticationforlocalhost', 'numberofpasswordprompts', 'passwordauthentication', 'permitlocalcommand',
  'permitremoteopen', 'pkcs11provider', 'port', 'preferredauthentications', 'proxycommand', 'proxyjump',
  'proxyusefdpass', 'pubkeyacceptedalgorithms', 'pubkeyauthentication', 'rekeylimit', 'remotecommand',
  'remoteforward', 'requesttty', 'requiredrsasize', 'revokedhostkeys', 'securitykeyprovider', 'sendenv',
  'serveralivecountmax', 'serveraliveinterval', 'sessiontype', 'setenv', 'stdinnull', 'streamlocalbindmask',
  'streamlocalbindunlink', 'stricthostkeychecking', 'syslogfacility', 'tag', 'tcpkeepalive', 'tunnel', 'tunneldevice',
  'updatehostkeys', 'user', 'userknownhostsfile', 'verifyhostkeydns', 'visualhostkey', 'xauthlocation',
];

export const sshConfig: CustomLanguage = {
  id: 'ssh_config',
  configuration: {
    comments: { lineComment: '#' },
    autoClosingPairs: [{ open: '"', close: '"', notIn: ['string'] }],
  },
  monarch: {
    defaultToken: '',
    tokenPostfix: '.ssh',
    ignoreCase: true,
    blocks: BLOCKS,
    keywords: KEYWORDS,
    tokenizer: {
      root: [
        [/\s+/, 'white'],
        [/#.*$/, 'comment'],
        // 키워드는 줄 머리 — 뒤는 값 상태 ('=' 구분도 허용)
        [/[a-zA-Z]\w*/, { cases: { '@blocks': { token: 'keyword.control', next: '@pattern' }, '@keywords': { token: 'keyword', next: '@value' }, '@default': { token: 'identifier', next: '@value' } } }],
      ],
      // Host/Match 의 패턴 — 와일드카드·부정
      pattern: [
        [/[ \t=]+/, 'white'],
        [/$/, '', '@pop'],
        [/#.*$/, 'comment', '@pop'],
        [/[*?!]/, 'type.identifier'],
        [/"[^"]*"/, 'string'],
        [/\b(?:all|canonical|final|exec|localnetwork|host|originalhost|tagged|user|localuser)\b/, 'keyword'],
        [/[^\s*?!"#]+/, 'type.identifier'],
      ],
      value: [
        [/[ \t=]+/, 'white'],
        [/$/, '', '@pop'],
        [/#.*$/, 'comment', '@pop'],
        [/"[^"]*"/, 'string'],
        [/%[%dhikLlnprTu]/, 'variable'],
        [/~\/?/, 'variable'],
        [/\b(?:yes|no|ask|auto|autoask|none|confirm|force)\b/, 'keyword.control'],
        [/\b\d+\b/, 'number'],
        [/[^\s#"%~]+/, ''],
      ],
    },
  },
};
