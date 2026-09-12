// URL 열기 분기 규칙 스모크 (ticket user-settings) — model/urlRules.ts 의 urlTarget 을 표로 검증.
//   node front/check-urlrules.mjs   (Node 22 — .ts 는 타입 제거만으로 import 된다)
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const { urlTarget } = await import(fileURLToPath(new URL('./src/model/urlRules.ts', import.meta.url)));

const cases = [
  // [url, internal, external, expected]
  ['http://localhost:5173/', ['localhost', '[IP]'], [], 'internal'],
  ['http://127.0.0.1:8797/?ws', ['localhost', '[IP]'], [], 'internal'],
  ['http://[::1]:8080/', ['localhost', '[IP]'], [], 'internal'],
  ['https://github.com/', ['localhost', '[IP]'], [], 'external'],
  ['https://docs.google.com/x', ['google.com'], [], 'internal'],
  ['https://google.com.evil.io/', ['google.com'], [], 'external'],
  ['https://GOOGLE.com/', ['google.com'], [], 'internal'],
  // 더 구체적인 줄이 이긴다
  ['https://www.naver.com/', ['*'], ['naver.com'], 'external'],
  ['https://example.org/', ['*'], ['naver.com'], 'internal'],
  ['https://mail.google.com/', ['google.com'], ['*'], 'internal'],
  ['http://10.0.0.5/', ['localhost', '[IP]', 'google.com'], ['naver.com', '[DOMAIN]', '*'], 'internal'],
  ['https://google.com/', ['localhost', '[IP]', 'google.com'], ['naver.com', '[DOMAIN]', '*'], 'internal'],
  ['https://example.com/', ['localhost', '[IP]', 'google.com'], ['naver.com', '[DOMAIN]', '*'], 'external'],
  // 같은 구체성이면 내부
  ['https://a.com/', ['a.com'], ['a.com'], 'internal'],
  ['https://a.com/', ['*'], ['*'], 'internal'],
  // 빈 줄·주석·공백
  ['https://a.com/', ['', '# note', '  a.com  '], [], 'internal'],
  ['not a url', ['*'], [], 'external'],
  ['https://a.com/', [], [], 'external'],
];
for (const [url, internal, external, expected] of cases) {
  assert.strictEqual(urlTarget(url, internal, external), expected, `${url} internal=${internal} external=${external}`);
}
console.log(`ok (${cases.length} cases)`);
