// /ws 연결 토큰 스모크 — SUPERLIGHT_TOKEN 설정 시 ?tkn= 불일치는 403, 일치는 정상 동작.
//   cargo build --workspace 후: node backend/check-auth.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-auth-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
writeFileSync(join(wsRoot, 'a.txt'), 'hello\n');

const TOKEN = 'check-secret-1';
const env = {
  ...process.env,
  SUPERLIGHT_SOCK: join(dir, 'daemon.sock'),
  SUPERLIGHT_HTTP: '127.0.0.1:18794',
  SUPERLIGHT_GRACE_SECS: '2',
  SUPERLIGHT_TOKEN: TOKEN,
};
const bin = fileURLToPath(new URL('../target/debug/superlight-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {}); // ENOENT 는 아래 접속 실패 assert 가 안내한다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 연결 시도 → 'open' | 'rejected' */
function tryConnect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve({ ws, outcome: 'open' });
    ws.onerror = () => resolve({ ws, outcome: 'rejected' });
  });
}

try {
  // 기동 대기 — 올바른 토큰으로 열릴 때까지
  let good;
  for (let i = 0; ; i++) {
    good = await tryConnect(`ws://127.0.0.1:18794/ws?tkn=${TOKEN}`);
    if (good.outcome === 'open') break;
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build --workspace 먼저');
    await sleep(100);
  }

  // 토큰 없음 / 오답은 거부돼야 한다 (403 은 WS 에서 onerror 로 온다)
  assert.strictEqual((await tryConnect('ws://127.0.0.1:18794/ws')).outcome, 'rejected', '무토큰 거부');
  assert.strictEqual(
    (await tryConnect(`ws://127.0.0.1:18794/ws?tkn=wrong`)).outcome,
    'rejected',
    '오답 토큰 거부',
  );

  // 올바른 토큰 연결은 실제로 동작해야 한다 (관문만 열리고 중계가 죽는 회귀 방지)
  const result = await new Promise((resolve, reject) => {
    good.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) (m.error ? reject(new Error(m.error)) : resolve(m.result));
    };
    good.ws.send(JSON.stringify({ id: 1, method: 'readFile', params: { path: 'a.txt' } }));
  });
  assert.strictEqual(result.content, 'hello\n', 'readFile via token');
  good.ws.close();

  console.log('auth check: OK');
} finally {
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
