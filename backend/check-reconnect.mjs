// 재접속 스모크 — 같은 session id 로 다시 붙으면 터미널이 살아 있고, 끊김 중 출력이
// 버퍼에서 flush 되며, 세션 grace 를 넘기면 회수된다.
//   cargo build --workspace 후: node backend/check-reconnect.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (30s)');
  process.exit(1);
}, 30000);

const dir = mkdtempSync(join(tmpdir(), 'sl-reconn-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);

const env = {
  ...process.env,
  SUPERLIGHT_SOCK: join(dir, 'daemon.sock'),
  SUPERLIGHT_HTTP: '127.0.0.1:18793',
  SUPERLIGHT_GRACE_SECS: '5', // 백엔드 제어 연결이 있는 한 안 죽는다 — 사후 정리용으로만 짧게
  SUPERLIGHT_SESSION_GRACE_SECS: '2', // reaper 주기 5s — 회수 확인은 최대 ~7s 대기
};
const bin = fileURLToPath(new URL('../target/debug/superlight-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** session 세션으로 접속 — termData 를 data 배열에 누적하는 헬퍼 한 벌 */
async function connect(session) {
  for (let i = 0; ; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:18793/ws?session=${session}`);
    const ok = await new Promise((res) => {
      ws.onopen = () => res(true);
      ws.onerror = () => res(false);
    });
    if (ok) {
      const data = [];
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.event === 'termData') data.push(m.data);
      };
      const send = (method, params) => ws.send(JSON.stringify({ method, params }));
      return { ws, data, send };
    }
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build --workspace 먼저');
    await sleep(100);
  }
}

try {
  // 1) 세션 s1: 터미널 만들고 동작 확인
  const c1 = await connect('s1');
  c1.send('createTerminal', { term: 1, cols: 80, rows: 24 });
  await sleep(700);
  c1.send('termWrite', { term: 1, data: 'echo first-$((1+1))\r' });
  await sleep(700);
  assert.ok(c1.data.join('').includes('first-2'), `연결1 echo: ${JSON.stringify(c1.data)}`);

  // 2) 끊김 중 출력을 만들 백그라운드 잡을 심고 즉시 끊는다
  c1.send('termWrite', { term: 1, data: '{ sleep 0.7; echo det-$((2+2)); } &\r' });
  await sleep(200);
  c1.ws.close();
  await sleep(1500); // 잡 출력(t+0.7s)은 detach 버퍼에 쌓인다

  // 3) 같은 세션으로 재접속 — 버퍼 flush + 같은 셸이 계속 응답해야 한다
  const c2 = await connect('s1');
  await sleep(500);
  assert.ok(c2.data.join('').includes('det-4'), `detach 버퍼 flush: ${JSON.stringify(c2.data)}`);
  c2.send('termWrite', { term: 1, data: 'echo again-$((1+2))\r' });
  await sleep(700);
  assert.ok(c2.data.join('').includes('again-3'), `재접속 후 echo: ${JSON.stringify(c2.data)}`);
  c2.ws.close();

  // 4) 세션 grace(2s) + reaper 주기(5s) 를 넘기면 터미널은 회수 — 새 attach 는 빈 세션
  await sleep(8000);
  const c3 = await connect('s1');
  c3.send('termWrite', { term: 1, data: 'echo zombie-$((3+3))\r' });
  await sleep(700);
  assert.ok(!c3.data.join('').includes('zombie-6'), `회수 후 유령 응답: ${JSON.stringify(c3.data)}`);
  // 같은 id 로 새 터미널은 만들 수 있어야 한다 (빈 세션의 정상 동작)
  c3.send('createTerminal', { term: 1, cols: 80, rows: 24 });
  await sleep(700);
  c3.send('termWrite', { term: 1, data: 'echo fresh-$((4+4))\r' });
  await sleep(700);
  assert.ok(c3.data.join('').includes('fresh-8'), `회수 후 새 터미널: ${JSON.stringify(c3.data)}`);
  c3.ws.close();

  console.log('reconnect check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
