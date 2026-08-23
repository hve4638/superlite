// flow control 스모크 — ack 없이는 데몬이 고수위(100k 자)에서 출력 읽기를 멈추고,
// ack 를 보내면 재개돼 끝까지 흘러나온다.
//   cargo build --workspace 후: node backend/check-flow.mjs
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

const dir = mkdtempSync(join(tmpdir(), 'sl-flow-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);

const env = {
  ...process.env,
  SUPERLIGHT_SOCK: join(dir, 'daemon.sock'),
  SUPERLIGHT_HTTP: '127.0.0.1:18792',
  SUPERLIGHT_GRACE_SECS: '5',
};
const bin = fileURLToPath(new URL('../target/debug/superlight-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; ; i++) {
  ws = new WebSocket('ws://127.0.0.1:18792/ws');
  const ok = await new Promise((res) => {
    ws.onopen = () => res(true);
    ws.onerror = () => res(false);
  });
  if (ok) break;
  assert.ok(i < 50, '백엔드 기동 실패 — cargo build --workspace 먼저');
  await sleep(100);
}

let received = 0;
let acking = false;
const chunks = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.event !== 'termData') return;
  received += m.data.length;
  chunks.push(m.data);
  if (acking) send('termAck', { term: 1, chars: m.data.length });
};
const send = (method, params) => ws.send(JSON.stringify({ method, params }));

try {
  send('createTerminal', { term: 1, cols: 80, rows: 24 });
  await sleep(700);
  received = 0;
  chunks.length = 0;

  // 400k 자 출력 + 종료 마커 — ack 를 안 보내므로 고수위에서 막혀야 한다
  send('termWrite', { term: 1, data: "yes | head -c 400000; echo DONE-$((7+7))\r" });
  await sleep(3000);
  const stalled = received;
  // 고수위 100k + 마지막 청크 + 반향/프롬프트 여유 — 400k 근처면 배압이 없는 것이다
  assert.ok(stalled < 200000, `ack 없이 ${stalled}자 수신 — 배압이 안 걸렸다`);
  assert.ok(!chunks.join('').includes('DONE-14'), 'ack 없이 끝까지 흘렀다');
  await sleep(1000);
  assert.ok(received - stalled < 5000, `정지 후에도 계속 흘러나온다 (${received - stalled}자)`);

  // ack 를 시작하면 재개돼 끝까지 나와야 한다 (밀린 만큼 일괄 ack 후 청크별 ack)
  acking = true;
  send('termAck', { term: 1, chars: received });
  for (let i = 0; i < 100 && !chunks.join('').includes('DONE-14'); i++) await sleep(100);
  assert.ok(chunks.join('').includes('DONE-14'), `ack 후에도 미완료 (${received}자)`);
  assert.ok(received >= 400000, `수신량 부족: ${received}`);

  console.log('flow check: OK');
} finally {
  clearTimeout(deadline);
  ws.close();
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
