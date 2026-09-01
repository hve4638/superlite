// 계약 스모크 (프론트 WS → 백엔드 → 데몬 전 구간) — 백엔드가 repo 루트를 서빙 중일 때:
//   cargo run -p superlight-backend   (데몬은 자동 기동)
//   node backend/check.mjs
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';

const deadline = setTimeout(() => {
  console.error('check timeout (15s) — 데몬이 응답하지 않는다');
  process.exit(1);
}, 15000);

const ws = new WebSocket(process.env.SUPERLIGHT_WS ?? 'ws://127.0.0.1:8795/ws');
let nextId = 1;
const pending = new Map();
const termData = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.event === 'termData') {
    termData.push(m.data);
    return;
  }
  if (m.event) return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error !== undefined) p.reject(new Error(m.error));
  else p.resolve(m.result);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const send = (method, params) => ws.send(JSON.stringify({ method, params }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('백엔드 미기동 — cargo run -p superlight-backend 먼저'));
});

const info = await call('workspace');
assert.ok(info.name.length > 0 && info.rootPath.startsWith('/'), 'workspace');

const entries = await call('readDir', { path: '' });
assert.ok(entries.some((e) => e.name === 'front' && e.kind === 'directory'), 'readDir');

const pkg = await call('readFile', { path: 'front/package.json' });
assert.ok(pkg.content.includes('"code-superlight"'), 'readFile content');
assert.match(pkg.etag, /^\d+-\d+$/, 'readFile etag');

await assert.rejects(call('readFile', { path: '../etc/passwd' }), /이탈/, 'safe_join');

const files = await call('listFiles');
assert.ok(files.includes('front/src/main.ts'), 'listFiles');

const hits = await call('search', { query: 'ThinBackend', opts: {} });
assert.ok(hits.some((f) => f.path === 'front/src/backend/types.ts'), 'search');

// 바이트→UTF-16 오프셋 변환 검증: 한글이 매치 앞에 있는 라인에서 slice 가 쿼리와 일치해야 한다
const seam = await call('search', { query: 'seam', opts: {} });
const km = seam.flatMap((f) => f.matches).find((m) => /[가-힣]/.test(m.lineText));
assert.ok(km, 'search korean-line match');
const [ks, ke] = km.ranges[0];
assert.strictEqual(km.lineText.slice(ks, ke).toLowerCase(), 'seam', 'search utf16 ranges');
// 이 파일 자신이 매치되지 않도록 쪼갠다
const none = await call('search', { query: 'zzz-no-such-' + 'string-zzz', opts: {} });
assert.deepStrictEqual(none, [], 'search empty');

const st = await call('gitStatus');
assert.ok(typeof st.branch === 'string' && Array.isArray(st.changes), 'gitStatus');
assert.match(st.head, /^([0-9a-f]{40}|[0-9a-f]{64})$/, 'gitStatus head 해시'); // sha1 | sha256 repo

const orig = await call('gitOriginalContent', { path: 'front/package.json' });
assert.ok(orig.includes('"code-superlight"'), 'gitOriginalContent');

// WHY: 추적 중인 폴더에 써야 한다 — untracked 폴더 안이면 git 이 폴더로 뭉쳐 보고한다
await call('writeFile', { path: 'front/.check-tmp', content: 'x' });
const st2 = await call('gitStatus');
rmSync(new URL('../../front/.check-tmp', import.meta.url)); // assert 실패해도 잔여물 없게 먼저 삭제
assert.ok(
  st2.changes.some((c) => c.path === 'front/.check-tmp' && c.kind === 'untracked'),
  'writeFile → untracked',
);

await assert.rejects(call('writeFile', { path: 'front/.check-tmp' }), /content/, 'writeFile no content');

// base64 이진 쓰기 (클립보드 이미지 저장 와이어) — 디코드된 바이트가 그대로 디스크에 남아야 한다
const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
await call('writeFile', {
  path: 'front/.check-tmp-bin',
  content: Buffer.from(pngMagic).toString('base64'),
  encoding: 'base64',
});
const bin = readFileSync(new URL('../../front/.check-tmp-bin', import.meta.url));
rmSync(new URL('../../front/.check-tmp-bin', import.meta.url));
assert.deepStrictEqual([...bin], pngMagic, 'writeFile base64 bytes');
await assert.rejects(
  call('writeFile', { path: 'front/.check-tmp', content: 'x', encoding: 'hex' }),
  /encoding/,
  'writeFile unknown encoding',
);

send('createTerminal', { term: 1, cols: 80, rows: 24 });
await sleep(700);
send('termWrite', { term: 1, data: 'echo sl-$((20+3))\r' });
await sleep(700);
assert.ok(termData.join('').includes('sl-23'), `terminal echo: ${JSON.stringify(termData)}`);
send('disposeTerminal', { term: 1 });

console.log('contract check: OK');
clearTimeout(deadline);
ws.close();
