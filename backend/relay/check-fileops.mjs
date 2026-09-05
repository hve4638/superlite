// 파일 조작 스모크 — createFile(배타·중첩)/createDir/rename(대상 보호)/delete(파일·디렉토리).
//   cargo build --workspace 후: node backend/relay/check-fileops.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-fileops-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const env = {
  ...process.env,
  SUPERLIGHT_SOCK: join(dir, 'daemon.sock'),
  SUPERLIGHT_HTTP: '127.0.0.1:18798',
  SUPERLIGHT_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlight-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18798/ws');
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

  // createFile: 중첩 경로 — 중간 디렉토리 자동 생성, 빈 파일
  await call('createFile', { path: 'a/b/new.txt' });
  assert.strictEqual(readFileSync(join(wsRoot, 'a/b/new.txt'), 'utf8'), '', '중첩 생성');

  // createFile: 이미 존재 → 에러, 내용 보존
  writeFileSync(join(wsRoot, 'a/b/new.txt'), 'keep me\n');
  await assert.rejects(call('createFile', { path: 'a/b/new.txt' }), '존재 시 에러');
  assert.strictEqual(readFileSync(join(wsRoot, 'a/b/new.txt'), 'utf8'), 'keep me\n', '기존 내용 보호');

  // createDir: 중간 디렉토리는 자동, 대상 자체는 배타적 (이미 있으면 에러 — undo 전제 보호)
  await call('createDir', { path: 'd/e' });
  assert.ok(existsSync(join(wsRoot, 'd/e')), 'createDir');
  await assert.rejects(call('createDir', { path: 'd/e' }), '배타적 생성 — 재호출 에러');

  // rename: 성공 + 원본 소멸
  await call('rename', { from: 'a/b/new.txt', to: 'a/b/renamed.txt' });
  assert.ok(!existsSync(join(wsRoot, 'a/b/new.txt')), 'rename 원본 소멸');
  assert.strictEqual(readFileSync(join(wsRoot, 'a/b/renamed.txt'), 'utf8'), 'keep me\n', 'rename 내용 유지');

  // readFile maxBytes: 초과 파일은 읽지 않고 unopenable(large) — 에러가 아니다 (undo 캡처 상한)
  const rBig = await call('readFile', { path: 'a/b/renamed.txt', maxBytes: 4 });
  assert.strictEqual(rBig.unopenable?.kind, 'large', 'maxBytes 초과 → unopenable large');
  const rOk = await call('readFile', { path: 'a/b/renamed.txt', maxBytes: 1000 });
  assert.strictEqual(rOk.content, 'keep me\n', 'maxBytes 이내 → 정상');

  // rename: 대상 존재 → 에러, 양쪽 보존
  writeFileSync(join(wsRoot, 'other.txt'), 'other\n');
  await assert.rejects(call('rename', { from: 'a/b/renamed.txt', to: 'other.txt' }), '대상 존재 시 에러');
  assert.strictEqual(readFileSync(join(wsRoot, 'other.txt'), 'utf8'), 'other\n', '대상 보호');

  // delete: 파일
  await call('delete', { path: 'other.txt' });
  assert.ok(!existsSync(join(wsRoot, 'other.txt')), '파일 삭제');

  // delete: 디렉토리 재귀
  await call('delete', { path: 'a' });
  assert.ok(!existsSync(join(wsRoot, 'a')), '디렉토리 재귀 삭제');

  // 경로 이탈 방어 (safe_join 관문 확인 — rename 은 from/to 둘 다)
  await assert.rejects(call('createFile', { path: '../escape.txt' }), 'createFile 이탈 차단');
  await assert.rejects(call('rename', { from: 'd', to: '../d' }), 'rename to 이탈 차단');

  // 빈 경로 = 루트 — 파괴적 메서드는 명시적 거부
  await assert.rejects(call('delete', { path: '' }), '루트 삭제 차단');
  await assert.rejects(call('rename', { from: '', to: 'x' }), '루트 rename 차단');

  console.log('fileops check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
