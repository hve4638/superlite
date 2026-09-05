// 재접속 스모크 — 같은 session id 로 다시 붙으면 터미널이 살아 있고, 끊김 중 출력이
// 버퍼에서 flush 되며, 세션 grace 를 넘기면 회수된다.
//   cargo build --workspace 후: node backend/relay/check-reconnect.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (45s)');
  process.exit(1);
}, 45000);

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
const bin = fileURLToPath(new URL('../../target/debug/superlight-backend', import.meta.url));
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
      let attachRes;
      // id 0 = 백엔드가 대신 보낸 attach 응답 — resumed 로 세션 회수 여부를 알 수 있다
      const attach = new Promise((r) => (attachRes = r));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 0) attachRes(m.result);
        if (m.event === 'termData') data.push(m.data);
      };
      const send = (method, params) => ws.send(JSON.stringify({ method, params }));
      return { ws, data, send, attach };
    }
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build --workspace 먼저');
    await sleep(100);
  }
}

try {
  // 1) 세션 s1: 터미널 만들고 동작 확인
  const c1 = await connect('s1');
  assert.strictEqual((await c1.attach).resumed, false, '첫 attach 는 resumed=false');
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
  assert.strictEqual((await c2.attach).resumed, true, '재접속 attach 는 resumed=true');
  await sleep(500);
  assert.ok(c2.data.join('').includes('det-4'), `detach 버퍼 flush: ${JSON.stringify(c2.data)}`);
  c2.send('termWrite', { term: 1, data: 'echo again-$((1+2))\r' });
  await sleep(700);
  assert.ok(c2.data.join('').includes('again-3'), `재접속 후 echo: ${JSON.stringify(c2.data)}`);
  c2.ws.close();

  // 4) 세션 grace(2s) + reaper 주기(5s) 를 넘기면 터미널은 회수 — 새 attach 는 빈 세션.
  //    resumed=false 가 프론트의 "세션 잃음" 신호다 (죽은 터미널 정리 근거)
  await sleep(8000);
  const c3 = await connect('s1');
  assert.strictEqual((await c3.attach).resumed, false, '회수 후 attach 는 resumed=false');
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

  // 5) 유휴 종료: 백엔드가 죽고 세션까지 회수되면 데몬은 자진 종료한다 (소켓 파일 제거가
  //    graceful 종료의 증거). detach 세션이 있는 동안은 안 죽는 조건의 반대편 검증이다.
  backend.kill();
  const sock = env.SUPERLIGHT_SOCK;
  let gone = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (!existsSync(sock)) {
      gone = true;
      break;
    }
  }
  assert.ok(gone, '데몬이 유휴 종료하지 않았다 (세션 회수 후에도 잔류)');

  console.log('reconnect check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
