// /tmux-conf 교차 오리진 스모크 (ticket relay-conn-fixes) — Tauri 앱은 프론트 오리진(tauri.localhost)과
// relay 가 달라 PUT 앞에 브라우저가 OPTIONS preflight 를 보낸다. relay 가 이를 2xx + allow-methods 로
// 받아야 저장이 된다 (종전 405 → "Failed to fetch"). 브라우저 없이 preflight 요청을 그대로 보내 헤더를
// 확인하고, PUT → GET 왕복으로 파일 저장까지 본다. 앱과 같이 토큰 모드로 띄운다.
//   cargo build -p superlite-backend -p superlite-daemon 후: node backend/relay/check-tmux-conf.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (20s)');
  process.exit(1);
}, 20000);

const dir = mkdtempSync(join(tmpdir(), 'sl-tmuxconf-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const TOKEN = 'check-secret-3';
const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18788',
  SUPERLITE_GRACE_SECS: '2',
  SUPERLITE_PASSWORD: TOKEN,
  HOME: dir, // config_dir 격리 — 이 머신의 tmux.conf 를 건드리지 않는다
  XDG_CONFIG_HOME: join(dir, 'config'),
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = 'http://127.0.0.1:18788/tmux-conf';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const ORIGIN = 'http://tauri.localhost';

try {
  for (let i = 0; ; i++) {
    const ok = await fetch('http://127.0.0.1:18788/version', { headers: AUTH }).then((r) => r.ok, () => false);
    if (ok) break;
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build -p superlite-backend -p superlite-daemon 먼저');
    await sleep(100);
  }

  // 1) preflight — 브라우저가 PUT 앞에 보내는 것과 같은 요청. 2xx + PUT 허용 + 오리진 허용
  const pre = await fetch(url, {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
  });
  assert.ok(pre.status >= 200 && pre.status < 300, `preflight status ${pre.status} (종전 405)`);
  assert.ok(/\bPUT\b/.test(pre.headers.get('access-control-allow-methods') ?? ''), `allow-methods: ${pre.headers.get('access-control-allow-methods')}`);
  assert.ok(/content-type/i.test(pre.headers.get('access-control-allow-headers') ?? ''), `allow-headers: ${pre.headers.get('access-control-allow-headers')}`);
  assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*', 'allow-origin');

  // 2) PUT → 파일 → GET 왕복 (교차 오리진 헤더 그대로)
  const body = 'set -g mouse on\n# check\n';
  const put = await fetch(url, { method: 'PUT', headers: { origin: ORIGIN, ...AUTH }, body });
  assert.strictEqual(put.status, 204, `PUT status ${put.status}`);
  assert.strictEqual(put.headers.get('access-control-allow-origin'), '*', 'PUT 응답 allow-origin');
  const got = await fetch(url, { headers: { origin: ORIGIN, ...AUTH } });
  assert.strictEqual(await got.text(), body, 'GET 이 PUT 본문을 돌려준다');

  // 3) 토큰 없는 PUT 은 여전히 403 — preflight 응답이 권한을 넓히지 않는다
  const noTkn = await fetch('http://127.0.0.1:18788/tmux-conf', { method: 'PUT', headers: { origin: ORIGIN }, body: 'x' });
  assert.strictEqual(noTkn.status, 403, `토큰 없는 PUT ${noTkn.status}`);

  console.log('tmux-conf check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
