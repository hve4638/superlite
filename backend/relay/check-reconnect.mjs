// 재접속 스모크 — 같은 session id 로 다시 붙으면 터미널이 살아 있고, 끊김 중 출력이
// 버퍼에서 flush 되며, 백엔드(앱)가 죽어도 터미널 데몬(termd)이 터미널을 지켜 새 백엔드가
// 이어받는다 (ticket terminal-daemon-split). 터미널이 다 닫히면 termd 도 유휴 종료한다.
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
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_TERM_SOCK: join(dir, 'term.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18793',
  SUPERLITE_GRACE_SECS: '2', // 백엔드 제어 연결이 있는 한 안 죽는다 — 유휴 종료 확인용으로 짧게
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
let backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
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

  // 4) 백엔드(앱)가 죽어도 터미널은 산다 — 파일 데몬은 grace 뒤 물러나지만 termd 는 살아
  //    있는 터미널을 가진 세션이 있는 한 남는다. 새 백엔드가 같은 세션으로 붙으면 이어받는다
  backend.kill('SIGKILL');
  await sleep(4000);
  assert.ok(!existsSync(env.SUPERLITE_SOCK), '파일 데몬은 백엔드 사망 후 유휴 종료해야 한다');
  assert.ok(existsSync(env.SUPERLITE_TERM_SOCK), '터미널 데몬은 살아 있는 터미널이 있어 남아야 한다');
  backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
  backend.on('error', () => {});
  const c3 = await connect('s1');
  assert.strictEqual((await c3.attach).resumed, true, '새 백엔드의 attach 는 resumed=true (termd 세션)');
  await sleep(300);
  c3.send('termWrite', { term: 1, data: 'echo survive-$((3+3))\r' });
  await sleep(700);
  assert.ok(c3.data.join('').includes('survive-6'), `백엔드 교체 후 같은 셸: ${JSON.stringify(c3.data)}`);

  // 5) 터미널을 닫으면 세션이 비고, 백엔드까지 죽으면 termd 도 유휴 종료한다 (소켓 파일 제거가
  //    graceful 종료의 증거). 살아 있는 터미널이 termd 를 붙드는 조건의 반대편 검증이다
  c3.send('disposeTerminal', { term: 1 });
  await sleep(300);
  c3.ws.close();
  backend.kill();
  let gone = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (!existsSync(env.SUPERLITE_TERM_SOCK)) {
      gone = true;
      break;
    }
  }
  assert.ok(gone, '터미널 데몬이 유휴 종료하지 않았다 (터미널 0 인데 잔류)');

  console.log('reconnect check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
