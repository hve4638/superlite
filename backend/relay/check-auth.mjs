// 접속 인증 스모크 (ticket web-remote-access) — SUPERLITE_PASSWORD 설정 시:
//   무인증·오답·?tkn= 쿼리(단독 bin 은 거부)는 403, Authorization: Bearer 와 /auth/login 이 심은 쿠키는 정상 동작.
//   /auth 는 인증 여부를 204/401 로, /auth/login 은 오답 403·정답 204+Set-Cookie. attach 의 grace(와이어 v26)도 여기서.
//   cargo build -p superlite-backend -p superlite-daemon 후: node backend/relay/check-auth.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (40s)');
  process.exit(1);
}, 40000);

const dir = mkdtempSync(join(tmpdir(), 'sl-auth-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
writeFileSync(join(wsRoot, 'a.txt'), 'hello\n');

const TOKEN = 'check-secret-1';
const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18794',
  SUPERLITE_GRACE_SECS: '2',
  SUPERLITE_SESSION_GRACE_SECS: '1',
  SUPERLITE_PASSWORD: TOKEN,
};
const BEARER = { authorization: `Bearer ${TOKEN}` };
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {}); // ENOENT 는 아래 접속 실패 assert 가 안내한다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 연결 시도 → 'open' | 'rejected'. headers 는 Node 22+ WebSocket 의 undici 옵션 */
function tryConnect(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    ws.onopen = () => resolve({ ws, outcome: 'open' });
    ws.onerror = () => resolve({ ws, outcome: 'rejected' });
  });
}

try {
  // 기동 대기 — 올바른 토큰으로 열릴 때까지
  let good;
  for (let i = 0; ; i++) {
    good = await tryConnect('ws://127.0.0.1:18794/ws', BEARER);
    if (good.outcome === 'open') break;
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build -p superlite-backend -p superlite-daemon 먼저');
    await sleep(100);
  }

  // 토큰 없음 / 오답은 거부돼야 한다 (403 은 WS 에서 onerror 로 온다).
  // 오답은 정답과 같은 길이 — 길이 가드가 아니라 XOR 비교 루프 자체를 태운다
  assert.strictEqual((await tryConnect('ws://127.0.0.1:18794/ws')).outcome, 'rejected', '무인증 거부');
  assert.strictEqual(
    (await tryConnect('ws://127.0.0.1:18794/ws', { authorization: 'Bearer check-secret-2' })).outcome,
    'rejected',
    '오답 거부',
  );
  // 단독 bin 은 ?tkn= 쿼리를 받지 않는다 — 비밀이 URL·북마크에 남던 경로 (Tauri 앱의 Registry 모드만 허용)
  assert.strictEqual((await tryConnect(`ws://127.0.0.1:18794/ws?tkn=${TOKEN}`)).outcome, 'rejected', '쿼리 토큰 거부');

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

  // relay 자체 HTTP(/version)도 같은 인증 — 오답 403, 정답은 버전 JSON (release-versioning)
  assert.strictEqual(
    (await fetch('http://127.0.0.1:18794/version', { headers: { authorization: 'Bearer check-secret-2' } })).status,
    403,
    '/version 오답 거부',
  );
  const ver = await (await fetch('http://127.0.0.1:18794/version', { headers: BEARER })).json();
  assert.ok(/^\d+\.\d+\.\d+$/.test(ver.version) && typeof ver.daemonBuild === 'string', '/version 응답 형태');

  // 브라우저 경로: /auth 401 → /auth/login 오답 403, 정답 204 + 쿠키 → 쿠키로 /auth 204·/ws 연결
  assert.strictEqual((await fetch('http://127.0.0.1:18794/auth')).status, 401, '/auth 무인증 401');
  assert.strictEqual((await fetch('http://127.0.0.1:18794/auth', { headers: BEARER })).status, 204, '/auth Bearer 204');
  assert.strictEqual(
    (await fetch('http://127.0.0.1:18794/auth/login', { method: 'POST', body: 'check-secret-2' })).status,
    403,
    '/auth/login 오답 403',
  );
  const loginRes = await fetch('http://127.0.0.1:18794/auth/login', { method: 'POST', body: TOKEN });
  assert.strictEqual(loginRes.status, 204, '/auth/login 정답 204');
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  assert.ok(/^superlite_auth=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/.test(setCookie), `쿠키 형태: ${setCookie}`);
  const COOKIE = { cookie: setCookie.split(';')[0] };
  assert.strictEqual((await fetch('http://127.0.0.1:18794/auth', { headers: COOKIE })).status, 204, '/auth 쿠키 204');
  assert.strictEqual((await fetch('http://127.0.0.1:18794/auth', { headers: { cookie: 'superlite_auth=deadbeef' } })).status, 401, '/auth 오답 쿠키 401');
  const viaCookie = await tryConnect('ws://127.0.0.1:18794/ws', COOKIE);
  assert.strictEqual(viaCookie.outcome, 'open', '/ws 쿠키 연결');
  viaCookie.ws.close();

  // 세션 grace (와이어 v26): 단독 bin 은 attach 에 grace 를 실어 데몬 기본(300)이 아니라 자기 값으로 회수되게 한다.
  // 데몬 기본 대신 1초로 띄웠으니 세션 연결을 끊고 잠시 뒤 재접속하면 resumed=false 여야 한다
  {
    const attachOf = (headers) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://127.0.0.1:18794/ws?session=grace-check', { headers });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id === 0) (m.error ? reject(new Error(m.error)) : resolve({ ws, resumed: m.result.resumed }));
        };
        ws.onerror = () => reject(new Error('연결 실패'));
      });
    const first = await attachOf(BEARER);
    assert.strictEqual(first.resumed, false, '첫 attach');
    first.ws.close();
    await sleep(300);
    const second = await attachOf(BEARER);
    assert.strictEqual(second.resumed, true, 'grace 안 재접속은 resumed');
    second.ws.close();
    await sleep(7000); // grace 1초 + reaper 주기 5초
    const third = await attachOf(BEARER);
    assert.strictEqual(third.resumed, false, 'grace 뒤 재접속은 회수됨');
    third.ws.close();
  }

  // 계약의 나머지 절반: 비밀번호 미설정이면 무인증 연결이 여전히 붙고 /auth 도 204 (로컬 기본 회귀 방지)
  const envNoToken = { ...env, SUPERLITE_HTTP: '127.0.0.1:18791' };
  delete envNoToken.SUPERLITE_PASSWORD;
  const backend2 = spawn(bin, [wsRoot], { env: envNoToken, stdio: 'ignore' });
  backend2.on('error', () => {});
  try {
    let open;
    for (let i = 0; ; i++) {
      open = await tryConnect('ws://127.0.0.1:18791/ws');
      if (open.outcome === 'open') break;
      assert.ok(i < 50, '무토큰 백엔드 기동 실패');
      await sleep(100);
    }
    open.ws.close();
    assert.strictEqual((await fetch('http://127.0.0.1:18791/auth')).status, 204, '무인증 /auth 204');
  } finally {
    backend2.kill();
  }

  console.log('auth check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
