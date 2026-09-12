// 터미널 경로 후보 파서 검증 (ticket terminal-path-links) — `node --test front/test/` (Node 22 타입 스트리핑).
// src 밖이라 vue-tsc 빌드 대상이 아니다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLinks } from '../src/ui/editor/terminalLinkParsing.ts';

const paths = (line: string, os: 'unix' | 'windows' = 'unix'): string[] => detectLinks(line, os).map((l) => l.path);

test('ticket 예시 — 절대·상대·점 접두', () => {
  assert.deepEqual(paths('cat /root/.bashrc'), ['/root/.bashrc']);
  assert.deepEqual(paths('ls ./build/dev-minor/'), ['./build/dev-minor/']);
  assert.deepEqual(paths('built build/dev-minor/Superlite-Dev_0.2.6_x64-setup.exe'), [
    'build/dev-minor/Superlite-Dev_0.2.6_x64-setup.exe',
  ]);
  assert.deepEqual(paths('~/x and ../y/z'), ['~/x', '../y/z']);
});

test('구분자 없는 낱말은 후보가 아니다 (사용자 결정 2026-09-12) — ./ 를 붙이면 잡힌다', () => {
  assert.deepEqual(paths('build src README.md itir.toml'), []);
  assert.deepEqual(paths('cat ./itir.toml'), ['./itir.toml']);
});

test('줄·컬럼 접미', () => {
  const l = detectLinks('error: src/main.rs:12:5: expected', 'unix').find((x) => x.row !== undefined);
  assert.equal(l.path, 'src/main.rs');
  assert.equal(l.row, 12);
  assert.equal(l.col, 5);
  assert.equal(l.text, 'src/main.rs:12:5');
  const m = detectLinks('  at foo (lib/a.ts:3:4)', 'unix').find((x) => x.row !== undefined);
  assert.equal(m.path, 'lib/a.ts');
  assert.equal(m.row, 3);
  const n = detectLinks('"foo.py", line 7', 'unix').find((x) => x.row !== undefined);
  assert.equal(n.path, 'foo.py');
  assert.equal(n.row, 7);
});

test('프롬프트 안의 cwd 도 후보다 (제외는 후속) — 붙은 `$` 는 resolver 가 벗긴다', () => {
  assert.deepEqual(paths('user@host:~/proj$ ls'), ['~/proj$']);
});

test('공백·따옴표·괄호 경계에서 끊긴다', () => {
  assert.deepEqual(paths("open '/tmp/a b' then \"/tmp/c\" (/tmp/d)"), ['/tmp/a', '/tmp/c', '/tmp/d']);
  assert.deepEqual(paths('see <https://x.y/z> and /var/log;'), ['/var/log']);
});

test('Windows 경로', () => {
  assert.deepEqual(paths('C:\\a\\b and .\\c\\d.txt', 'windows'), ['C:\\a\\b', '.\\c\\d.txt']);
  assert.deepEqual(paths('build\\dev-minor\\x.exe', 'windows'), ['build\\dev-minor\\x.exe']);
  const l = detectLinks('C:\\src\\main.rs(12,5): error', 'windows').find((x) => x.row !== undefined);
  assert.equal(l.path, 'C:\\src\\main.rs');
  assert.equal(l.row, 12);
  assert.equal(l.col, 5);
});

test('접미 링크와 겹치는 경로 후보는 하나만', () => {
  const links = detectLinks('src/a.ts:1:2 src/b.ts', 'unix');
  assert.deepEqual(links.map((l) => l.text), ['src/a.ts:1:2', 'src/b.ts']);
  const l2 = detectLinks('error: src/main.rs:12:5: expected', 'unix');
  assert.deepEqual(l2.map((l) => l.text), ['src/main.rs:12:5']);
});

test('index 는 줄 안 오프셋', () => {
  const l = detectLinks('xx /a/b yy', 'unix').find((x) => x.path === '/a/b');
  assert.equal(l.index, 3);
});
