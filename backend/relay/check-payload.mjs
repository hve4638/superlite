// 바이너리 payload 프레임(와이어 v6) 스모크 — 대형 readFile 이 WS 바이너리 프레임
// (4B BE 헤더 길이 + 헤더 JSON + 본문)으로 오고, 텍스트는 deflate-raw 해제·이미지는
// 원본 바이트가 그대로 복원되는지, 소형은 종전 JSON 텍스트 프레임인지 검증한다.
//   cargo build --workspace 후: node backend/relay/check-payload.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'sl-payload-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_TERM_SOCK: join(dir, 'term.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18788',
  SUPERLITE_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18788/ws');
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
  ws.binaryType = 'arraybuffer';

  let nextId = 1;
  const pending = new Map();
  // 프레임 종류까지 검증한다 — resolve 값에 frame: 'text' | 'binary' 를 실어 준다
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const view = new DataView(ev.data);
      const hlen = view.getUint32(0);
      const header = JSON.parse(Buffer.from(ev.data, 4, hlen).toString('utf8'));
      const body = Buffer.from(ev.data, 4 + hlen);
      const p = pending.get(header.id);
      if (!p) return;
      pending.delete(header.id);
      p.resolve({ frame: 'binary', result: header.result, body });
      return;
    }
    const m = JSON.parse(ev.data);
    if (m.id === undefined) return;
    const p = pending.get(m.id);
    if (!p) return; // attach(id 0) 응답이 섞일 수 있다
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve({ frame: 'text', result: m.result });
  };
  const call = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // 대형 텍스트 (~20KB, 반복 내용) → binary 프레임 + deflate-raw, 해제하면 원문
  const bigText = 'the quick brown fox jumps over the lazy dog\n'.repeat(500);
  writeFileSync(join(wsRoot, 'big.txt'), bigText);
  const bt = await call('readFile', { path: 'big.txt' });
  assert.strictEqual(bt.frame, 'binary', '대형 텍스트 → 바이너리 프레임');
  assert.deepStrictEqual(bt.result.payload, { enc: 'deflate-raw', type: 'text' }, '텍스트 payload 명세');
  assert.ok(bt.body.length < bigText.length / 2, `압축이 실효적이다 (${bt.body.length}B < 원문 절반)`);
  assert.strictEqual(inflateRawSync(bt.body).toString('utf8'), bigText, '해제 결과 == 원문');
  const st = statSync(join(wsRoot, 'big.txt'));
  assert.strictEqual(bt.result.etag, `${Math.trunc(st.mtimeMs)}-${st.size}`, '헤더 etag == stat');

  // 대형 이진 + encoding=base64 → binary 프레임 + raw 원본 바이트 (base64 부풀림 없음)
  const bigBin = Buffer.alloc(8192);
  for (let i = 0; i < bigBin.length; i++) bigBin[i] = (i * 7 + 13) & 0xff;
  writeFileSync(join(wsRoot, 'big.bin'), bigBin);
  const bb = await call('readFile', { path: 'big.bin', encoding: 'base64' });
  assert.strictEqual(bb.frame, 'binary', '대형 base64 → 바이너리 프레임');
  assert.deepStrictEqual(bb.result.payload, { enc: 'raw', type: 'base64' }, 'base64 payload 명세');
  assert.ok(bb.body.equals(bigBin), 'raw 본문 == 원본 바이트');

  // 소형 텍스트·소형 base64 는 종전 JSON 텍스트 프레임 그대로
  writeFileSync(join(wsRoot, 'small.txt'), 'hello\n');
  const smt = await call('readFile', { path: 'small.txt' });
  assert.strictEqual(smt.frame, 'text', '소형 텍스트 → JSON 프레임');
  assert.strictEqual(smt.result.content, 'hello\n', '소형 텍스트 content');
  const smb = await call('readFile', { path: 'small.txt', encoding: 'base64' });
  assert.strictEqual(smb.frame, 'text', '소형 base64 → JSON 프레임');
  assert.strictEqual(Buffer.from(smb.result.content, 'base64').toString('utf8'), 'hello\n', '소형 base64 content');

  // 비 payload 경로(unopenable·에러)는 영향이 없어야 한다
  writeFileSync(join(wsRoot, 'bin.dat'), Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0x00, 0x80]));
  const un = await call('readFile', { path: 'bin.dat' });
  assert.strictEqual(un.frame, 'text', 'unopenable → JSON 프레임');
  assert.deepStrictEqual(un.result.unopenable, { kind: 'binary' }, 'unopenable 유지');
  await assert.rejects(call('readFile', { path: 'no-such.txt' }), '부재 → 에러 유지');

  // 대형 payload 와 일반 응답이 섞여도 각자 id 로 풀린다 (writer 이중 채널 교차)
  const [x1, x2, x3] = await Promise.all([
    call('readFile', { path: 'big.txt' }),
    call('stat', { path: 'small.txt' }),
    call('readFile', { path: 'big.bin', encoding: 'base64' }),
  ]);
  assert.strictEqual(x1.frame, 'binary');
  assert.strictEqual(x2.frame, 'text');
  assert.ok(x3.body.equals(bigBin), '동시 요청 교차에도 본문 무결');

  console.log('payload check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
