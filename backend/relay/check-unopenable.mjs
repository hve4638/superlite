// readFile unopenable 스모크 — 크기 초과(기본 상한·maxBytes)·이진(비 UTF-8)이 에러 대신
// 구조화된 사유(unopenable)로 오고, 텍스트·실제 실패(부재)는 종전대로인지 검증한다.
//   cargo build --workspace 후: node backend/check-unopenable.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-unopenable-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const env = {
  ...process.env,
  SUPERLIGHT_SOCK: join(dir, 'daemon.sock'),
  SUPERLIGHT_HTTP: '127.0.0.1:18790',
  SUPERLIGHT_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlight-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18790/ws');
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('connect'));
      });
      break;
    } catch {
      assert.ok(i < 50, '백엔드 기동 실패 (5초) — cargo build --workspace 먼저?');
      await sleep(100);
    }
  }

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === undefined) return;
    const p = pending.get(m.id);
    if (!p) return; // 백엔드가 자체 발급한 id 의 응답(attach)이 섞일 수 있다
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.result);
  };
  const call = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // 텍스트 파일은 종전대로 content+etag
  writeFileSync(join(wsRoot, 'text.txt'), 'hello\n');
  const t = await call('readFile', { path: 'text.txt' });
  assert.strictEqual(t.content, 'hello\n', '텍스트 content');
  assert.strictEqual(t.unopenable, undefined, '텍스트에 unopenable 없음');

  // 이진(비 UTF-8) → unopenable binary + etag (에러 아님)
  writeFileSync(join(wsRoot, 'bin.dat'), Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0x00, 0x80]));
  const b = await call('readFile', { path: 'bin.dat' });
  assert.deepStrictEqual(b.unopenable, { kind: 'binary' }, '이진 → unopenable binary');
  assert.strictEqual(b.content, undefined, '이진에 content 없음');
  const s = await call('stat', { path: 'bin.dat' });
  assert.strictEqual(b.etag, s.etag, '이진 etag == stat etag');

  // maxBytes(호출측 상한) 초과 → unopenable large + 실측 크기 (에러 아님)
  const l = await call('readFile', { path: 'text.txt', maxBytes: 3 });
  assert.deepStrictEqual(l.unopenable, { kind: 'large', size: 6 }, 'maxBytes 초과 → large+실측 크기');

  // 기본 상한(50MB) 초과 — maxBytes 없이도 걸린다. 내용은 유효 UTF-8 이어도 크기가 우선
  writeFileSync(join(wsRoot, 'huge.txt'), Buffer.alloc(50 * 1024 * 1024 + 1, 0x61));
  const h = await call('readFile', { path: 'huge.txt' });
  assert.strictEqual(h.unopenable?.kind, 'large', '기본 상한 초과 → large');
  assert.strictEqual(h.unopenable?.size, 50 * 1024 * 1024 + 1, 'large 실측 크기');

  // 범위 읽기(와이어 v11) — 기본 상한 초과 파일도 offset+maxBytes 로 잘라 온다, EOF 넘으면 짧게
  const r = await call('readFile', { path: 'huge.txt', encoding: 'base64', offset: 50 * 1024 * 1024 - 2, maxBytes: 16 });
  assert.strictEqual(Buffer.from(r.content, 'base64').toString('latin1'), 'aaa', '범위 읽기 — EOF 앞 3바이트');
  const r0 = await call('readFile', { path: 'bin.dat', encoding: 'base64', offset: 2, maxBytes: 2 });
  assert.deepStrictEqual([...Buffer.from(r0.content, 'base64')], [0xff, 0xfe], '범위 읽기 — 중간 2바이트');
  await assert.rejects(call('readFile', { path: 'bin.dat', offset: 0 }), 'offset 은 base64 전용');
  assert.strictEqual((await call('stat', { path: 'huge.txt' })).size, 50 * 1024 * 1024 + 1, 'stat size');

  // 실제 실패(부재)는 여전히 에러
  await assert.rejects(call('readFile', { path: 'no-such.txt' }), '부재 → 에러');

  console.log('unopenable check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
