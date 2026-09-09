// etag 낙관적 충돌 검사 스모크 — writeFile 이 stale etag 를 거부하고, 내용 동일 탈출구와
// etag 생략(Overwrite) 이 통하는지 검증한다.
//   cargo build -p superlite-backend -p superlite-daemon 후: node backend/relay/check-etag.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-etag-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18797',
  SUPERLITE_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18797/ws');
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('connect'));
      });
      break;
    } catch {
      assert.ok(i < 50, '백엔드 기동 실패 (5초) — cargo build -p superlite-backend -p superlite-daemon 먼저?');
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

  // 신규 파일: etag 없이 생성 → etag 반환
  const w1 = await call('writeFile', { path: 'a.txt', content: 'one\n' });
  assert.match(w1.etag, /^\d+-\d+$/, '신규 쓰기 etag');

  // readFile 은 content+etag 를 함께 준다
  const r1 = await call('readFile', { path: 'a.txt' });
  assert.strictEqual(r1.content, 'one\n', 'readFile content');
  assert.strictEqual(r1.etag, w1.etag, 'readFile etag == 쓰기 etag');

  // stat: 내용 없이 같은 (mtime,size) etag — 정규 파일 전용
  const s1 = await call('stat', { path: 'a.txt' });
  assert.strictEqual(s1.etag, r1.etag, 'stat etag == readFile etag');
  await assert.rejects(call('stat', { path: 'no-such.txt' }), 'stat 부재 → 에러');
  mkdirSync(join(wsRoot, 'adir'));
  await assert.rejects(call('stat', { path: 'adir' }), /정규 파일/, 'stat 디렉토리 → 에러');

  // 최신 etag 를 든 정상 저장 → 성공 + 새 etag (크기가 달라 mtime 해상도와 무관)
  const w2 = await call('writeFile', { path: 'a.txt', content: 'two two\n', etag: r1.etag });
  assert.ok(w2.etag && w2.etag !== r1.etag, '정상 저장 → 새 etag');

  // 외부 변경 후 stale etag 저장 → conflict, 디스크는 그대로
  writeFileSync(join(wsRoot, 'a.txt'), 'external!\n'); // 크기가 달라 etag 확실히 변한다
  const w3 = await call('writeFile', { path: 'a.txt', content: 'mine\n', etag: w2.etag });
  assert.strictEqual(w3.conflict, true, 'stale etag → conflict');
  assert.strictEqual(readFileSync(join(wsRoot, 'a.txt'), 'utf8'), 'external!\n', 'conflict 시 미기록');

  // 탈출구: etag 는 stale 이지만 쓰려는 내용이 디스크와 동일 → 충돌 아님
  const w4 = await call('writeFile', { path: 'a.txt', content: 'external!\n', etag: w2.etag });
  assert.ok(w4.etag, '내용 동일 탈출구');

  // Overwrite: etag 생략 → 무조건 쓴다
  const w5 = await call('writeFile', { path: 'a.txt', content: 'mine\n' });
  assert.ok(w5.etag, 'etag 생략 → 덮어쓰기');
  assert.strictEqual(readFileSync(join(wsRoot, 'a.txt'), 'utf8'), 'mine\n', '덮어쓰기 반영');

  // 외부 삭제 후 stale etag 저장 → 파일을 되살린다 (VS Code 동일 — 저장은 성공해야 한다)
  rmSync(join(wsRoot, 'a.txt'));
  const w6 = await call('writeFile', { path: 'a.txt', content: 'revived\n', etag: w5.etag });
  assert.ok(w6.etag, '외부 삭제 후 저장 → 재생성');

  console.log('etag check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
