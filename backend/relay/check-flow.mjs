// flow control 스모크 — ack 없이는 데몬이 고수위(100k 자)에서 출력 읽기를 멈추고,
// ack 를 보내면 재개돼 끝까지 흘러나온다.
//   cargo build -p superlite-backend -p superlite-daemon 후: node backend/relay/check-flow.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (60s)');
  process.exit(1);
}, 60000);

const dir = mkdtempSync(join(tmpdir(), 'sl-flow-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);

const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18792',
  SUPERLITE_GRACE_SECS: '5',
  SUPERLITE_TMUX: '0', // raw PTY 의미(배압·detach 버퍼)를 재는 검사 — 내장 tmux 는 check-tmux.mjs 가 따로 본다
  SHELL: '/bin/bash', // 개발자 셸(배너가 긴 zsh 등)에 좌우되지 않게 고정
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let received = 0;
let acking = false;
const chunks = [];
/** 터미널별 termInputAck 누계 — 데몬이 셸에 쓴 입력량 통지 (입력 배압의 반쪽) */
const inputAcked = new Map();
const send = (method, params) => ws.send(JSON.stringify({ method, params }));

try {
  // 기동 대기도 try 안 — 실패 시 finally 가 백엔드·임시 디렉터리를 정리해야 한다
  for (let i = 0; ; i++) {
    ws = new WebSocket('ws://127.0.0.1:18792/ws');
    const ok = await new Promise((res) => {
      ws.onopen = () => res(true);
      ws.onerror = () => res(false);
    });
    if (ok) break;
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build -p superlite-backend -p superlite-daemon 먼저');
    await sleep(100);
  }
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.event === 'termInputAck') {
      inputAcked.set(m.term, (inputAcked.get(m.term) ?? 0) + m.chars);
      return;
    }
    if (m.event !== 'termData') return;
    received += m.data.length;
    chunks.push(m.data);
    if (acking) send('termAck', { term: m.term, chars: m.data.length });
  };

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

  // ack 를 시작하면 재개돼 끝까지 나와야 한다. 일괄 ack 는 넉넉한 상수로 — received 는
  // 리셋 전(배너·프롬프트) 몫이 빠져 있어 정확값이 아니다 (데몬 쪽은 saturating 이라 안전)
  acking = true;
  send('termAck', { term: 1, chars: 1000000 });
  for (let i = 0; i < 100 && !chunks.join('').includes('DONE-14'); i++) await sleep(100);
  assert.ok(chunks.join('').includes('DONE-14'), `ack 후에도 미완료 (${received}자)`);
  assert.ok(received >= 400000, `수신량 부족: ${received}`);

  // 데드락 회귀: termWrite 는 read 루프를 막으면 안 된다 — cat 이 출력 배압으로 막힌
  // 상태에서도 대량 붙여넣기(300k, pty 입력 큐 초과)와 termAck 이 계속 처리돼야 한다.
  // (termWrite 가 read 루프에서 직접 pty 에 쓰면 여기서 데몬 연결이 영구 정지한다)
  send('createTerminal', { term: 2, cols: 80, rows: 24 });
  await sleep(700);
  send('termWrite', { term: 2, data: 'cat\r' });
  await sleep(300);
  // 줄 단위 페이로드 — canonical 모드는 4096자 넘는 한 줄을 버린다 (마커 유실 방지)
  send('termWrite', { term: 2, data: ('x'.repeat(70) + '\r').repeat(4000) + 'PASTE-END-MARK\r' });
  // 에코+cat 출력 어느 쪽이든 마커가 나와야 한다 (80컬럼 줄바꿈이 끼어들 수 있어 제거 후 검색)
  const flat = () => chunks.join('').replace(/[\r\n]/g, '');
  for (let i = 0; i < 150 && !flat().includes('PASTE-END-MARK'); i++) await sleep(100);
  assert.ok(flat().includes('PASTE-END-MARK'), `대량 붙여넣기 미도달 (${received}자) — termWrite 데드락?`);

  // 입력 소화 통지 — term 2 로 보낸 입력 전량이 termInputAck 로 되돌아와야
  // 프론트 입력 배압 창이 회복된다 (전부 ASCII 라 length == UTF-16 수)
  const wantInput = 'cat\r'.length + (('x'.repeat(70) + '\r').repeat(4000) + 'PASTE-END-MARK\r').length;
  for (let i = 0; i < 100 && (inputAcked.get(2) ?? 0) < wantInput; i++) await sleep(100);
  assert.equal(inputAcked.get(2) ?? 0, wantInput, 'termInputAck 누계가 전송 입력량과 일치해야 한다');
  send('disposeTerminal', { term: 2 });

  console.log('flow check: OK');
} finally {
  clearTimeout(deadline);
  ws?.close();
  backend.kill();
  rmSync(dir, { recursive: true, force: true });
}
