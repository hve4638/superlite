// 원격 termd 스모크 — sshd 없이 가짜 ssh(PATH 앞 스크립트가 원격 명령을 격리 HOME/XDG 로 로컬
// 실행)로 relay 의 원격 경로(probe → 헬퍼 배치 → --pipe 헬퍼의 두 소켓 분기·합류)를 돌린다.
//   cargo build --workspace 후: node backend/relay/check-termd-remote.mjs
// 검증: 원격 터미널 생성·echo, 백엔드(앱) 사망 후 원격 termd 생존(파일 데몬은 유휴 종료),
// 새 백엔드가 같은 세션으로 붙어 같은 셸을 이어받음, 터미널을 닫으면 termd 유휴 종료.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (60s)');
  process.exit(1);
}, 60000);

const dir = mkdtempSync(join(tmpdir(), 'sl-rterm-'));
const fakeHome = join(dir, 'home');
const fakeRun = join(dir, 'run');
const wsRoot = join(dir, 'root');
for (const d of [fakeHome, fakeRun, wsRoot, join(dir, 'bin')]) mkdirSync(d);
// 가짜 ssh — `-o X` 쌍을 건너뛰고 host 다음 인자(명령)를 sh -c 로. relay 의 env 는 지우고
// HOME/XDG 를 격리해 "원격" 데몬 쌍이 이 폴더 밑에 뜬다
writeFileSync(
  join(dir, 'bin', 'ssh'),
  `#!/bin/bash
set -o pipefail
while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; -*) shift;; *) break;; esac; done
shift # host
unset SUPERLITE_SOCK SUPERLITE_TERM_SOCK SUPERLITE_DAEMON_BIN SUPERLITE_HTTP SUPERLITE_DIST
export HOME=${fakeHome} XDG_RUNTIME_DIR=${fakeRun} SUPERLITE_GRACE_SECS=2
exec sh -c "$*"
`,
);
chmodSync(join(dir, 'bin', 'ssh'), 0o755);
const env = {
  ...process.env,
  PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
  HOME: fakeHome, // relay 의 ~/.ssh/config·remote.json 도 격리
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_TERM_SOCK: join(dir, 'term.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18787',
  SUPERLITE_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const startBackend = () => {
  const b = spawn(bin, [wsRoot], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  b.on('error', () => {});
  return b;
};
let backend = startBackend();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remoteSocks = () => (existsSync(fakeRun) ? readdirSync(fakeRun, { recursive: true }).map((f) => f.split('/').pop()).filter((f) => f.endsWith('.sock')) : []);

async function connect(session) {
  for (let i = 0; ; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:18787/ws?session=${session}&folder=ssh://fakehost${wsRoot}`);
    const ok = await new Promise((res) => {
      ws.onopen = () => res(true);
      ws.onerror = () => res(false);
    });
    if (ok) {
      const data = [];
      let attachRes;
      const attach = new Promise((r) => (attachRes = r));
      let closed;
      const close = new Promise((r) => (closed = r));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 0) attachRes(m.result ?? { error: m.error });
        if (m.event === 'termData') data.push(m.data);
      };
      ws.onclose = (ev) => closed(ev);
      const send = (method, params) => ws.send(JSON.stringify({ method, params }));
      return { ws, data, send, attach, close };
    }
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build --workspace 먼저');
    await sleep(100);
  }
}

try {
  // 1) 원격 세션 — 헬퍼 업로드·데몬 쌍 기동·attach 접기(id 0 응답 하나)
  const c1 = await connect('r1');
  const a1 = await Promise.race([c1.attach, c1.close.then((ev) => ({ error: `close ${ev.code} ${ev.reason}` }))]);
  assert.strictEqual(a1.resumed, false, `첫 attach: ${JSON.stringify(a1)}`);
  c1.send('createTerminal', { term: 1, cols: 80, rows: 24 });
  await sleep(700);
  c1.send('termWrite', { term: 1, data: 'echo remote-$((1+1))\r' });
  await sleep(700);
  assert.ok(c1.data.join('').includes('remote-2'), `원격 echo: ${JSON.stringify(c1.data)}`);
  assert.ok(remoteSocks().some((f) => f.startsWith('term-')), `원격 termd 소켓: ${remoteSocks()}`);
  assert.ok(remoteSocks().some((f) => f.startsWith('daemon-')), `원격 파일 데몬 소켓: ${remoteSocks()}`);
  // 파일 데몬 메서드도 같은 WS 로 (분기 확인)
  const wsResp = await new Promise((res) => {
    const prev = c1.ws.onmessage;
    c1.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 7) res(m);
      else prev(ev);
    };
    c1.ws.send(JSON.stringify({ id: 7, method: 'workspace', params: {} }));
  });
  assert.ok(wsResp.result?.rootPath, `workspace 응답: ${JSON.stringify(wsResp)}`);
  c1.ws.close();

  // 2) 백엔드(앱) 사망 — 원격 파일 데몬은 grace 뒤 종료, 원격 termd 는 터미널을 쥐고 생존
  backend.kill('SIGKILL');
  await sleep(4500);
  assert.ok(!remoteSocks().some((f) => f.startsWith('daemon-')), `원격 파일 데몬 유휴 종료: ${remoteSocks()}`);
  assert.ok(remoteSocks().some((f) => f.startsWith('term-')), `원격 termd 생존: ${remoteSocks()}`);

  // 3) 새 백엔드가 같은 세션으로 — 같은 셸 이어받기
  backend = startBackend();
  const c2 = await connect('r1');
  const a2 = await Promise.race([c2.attach, c2.close.then((ev) => ({ error: `close ${ev.code} ${ev.reason}` }))]);
  assert.strictEqual(a2.resumed, true, `재접속 attach: ${JSON.stringify(a2)}`);
  await sleep(300);
  c2.send('termWrite', { term: 1, data: 'echo back-$((2+2))\r' });
  await sleep(700);
  assert.ok(c2.data.join('').includes('back-4'), `백엔드 교체 후 원격 echo: ${JSON.stringify(c2.data)}`);

  // 4) 터미널 닫기 → 원격 termd 도 유휴 종료
  c2.send('disposeTerminal', { term: 1 });
  await sleep(300);
  c2.ws.close();
  backend.kill();
  let gone = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (!remoteSocks().some((f) => f.startsWith('term-'))) {
      gone = true;
      break;
    }
  }
  assert.ok(gone, `원격 termd 가 유휴 종료하지 않았다: ${remoteSocks()}`);
  console.log('termd-remote check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
