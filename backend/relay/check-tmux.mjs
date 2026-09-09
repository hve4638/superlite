// 내장 tmux 스모크 (ticket term-list-reconnect) — 데몬이 PTY 안에서 tmux 클라이언트를 띄우고, 터미널이
// 앱(백엔드)·데몬 사망을 넘어 tmux 서버에 살아남으며, 새 세션이 listTerminals 로 찾아 attach 하면 같은
// 셸이고, 탭 닫기(disposeTerminal)는 detach 일 뿐이며, killTerminal 이 세션을 끝낸다. tmux 서버는 전용
// 소켓(SUPERLITE_TMUX_SOCK)이라 이 머신의 사용자 tmux 서버를 건드리지 않는다 — 정리는 세션 kill 로만
// (exit-empty 로 서버가 스스로 내려간다).
//   cargo build -p superlite-backend -p superlite-daemon 후: node backend/relay/check-tmux.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (60s)');
  process.exit(1);
}, 60000);

const dir = mkdtempSync(join(tmpdir(), 'sl-tmux-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_TMUX_SOCK: join(dir, 'tmux.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18789',
  SUPERLITE_GRACE_SECS: '2',
  SUPERLITE_SESSION_GRACE_SECS: '2', // detach 세션(터미널)을 빨리 회수 — 데몬 유휴 종료 확인용
  HOME: dir, // 캐시(base.conf)·conf 도 격리
};
delete env.SUPERLITE_TMUX;
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const startBackend = () => {
  const b = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
  b.on('error', () => {});
  return b;
};
let backend = startBackend();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(session) {
  for (let i = 0; ; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:18789/ws?session=${session}`);
    const ok = await new Promise((res) => {
      ws.onopen = () => res(true);
      ws.onerror = () => res(false);
    });
    if (ok) {
      const data = [];
      const tmux = new Map(); // term → {id,name} | {error}
      let attachRes;
      const attach = new Promise((r) => (attachRes = r));
      const pending = new Map();
      let nextId = 1;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 0) attachRes(m.result);
        else if (m.id !== undefined && pending.has(m.id)) {
          const { res, rej } = pending.get(m.id);
          pending.delete(m.id);
          m.error !== undefined ? rej(new Error(m.error)) : res(m.result);
        }
        if (m.event === 'termData') data.push(m.data);
        if (m.event === 'termTmux') tmux.set(m.term, m);
      };
      const send = (method, params) => ws.send(JSON.stringify({ method, params }));
      const call = (method, params) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      return { ws, data, tmux, send, call, attach };
    }
    assert.ok(i < 50, '백엔드 기동 실패 — cargo build -p superlite-backend -p superlite-daemon 먼저');
    await sleep(100);
  }
}
const text = (c) => c.data.join('');
// tmux 서버 생존 여부 — 소켓 파일은 서버 종료 후에도 남으므로(tmux 는 unlink 하지 않는다) `ls`
// 의 종료 코드로 판정한다. 동봉 tmux 는 데몬 옆(daemon/tmux-<os>-<arch> 규칙 → target/debug)
import { execFileSync } from 'node:child_process';
const TMUX_BIN = fileURLToPath(new URL('../../target/debug/tmux-linux-x86_64', import.meta.url));
function serverUp() {
  try { execFileSync(TMUX_BIN, ['-S', env.SUPERLITE_TMUX_SOCK, 'ls'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

try {
  // 1) attach 응답의 terminal.mode 는 tmux, 새 터미널은 termTmux 로 세션 id 를 알린다
  const c1 = await connect('s1');
  const a1 = await c1.attach;
  assert.strictEqual(a1.terminal?.mode, 'tmux', `terminal mode: ${JSON.stringify(a1)}`);
  c1.send('createTerminal', { term: 1, cols: 80, rows: 24 });
  await sleep(1200);
  const t1 = c1.tmux.get(1);
  assert.ok(t1 && typeof t1.id === 'string' && t1.id.startsWith('$'), `termTmux: ${JSON.stringify(t1)}`);
  assert.strictEqual(t1.name, 'root-1', `세션 이름 (폴더명-번호): ${t1.name}`);
  // 로그인 셸 + 환경변수 — SUPERLITE_TMUX_SOCKET 은 있고 TMUX 는 없다
  c1.send('termWrite', { term: 1, data: 'export MARK=alive-$((1+1)); echo T=${TMUX:-none} S=${SUPERLITE_TMUX_SOCKET##*/} W=$SUPERLITE_TMUX_WORKSPACE_PATH\r' });
  await sleep(900);
  assert.ok(text(c1).includes('T=none'), `TMUX 제거: ${JSON.stringify(c1.data)}`);
  assert.ok(text(c1).includes('S=tmux.sock'), `SUPERLITE_TMUX_SOCKET: ${JSON.stringify(c1.data)}`);
  assert.ok(text(c1).includes(`W=${wsRoot}`), `워크스페이스 환경변수: ${JSON.stringify(c1.data)}`);
  // 목록 — 이 워크스페이스 것 하나, attached 1
  const l1 = await c1.call('listTerminals', {});
  assert.strictEqual(l1.length, 1, `목록: ${JSON.stringify(l1)}`);
  assert.strictEqual(l1[0].id, t1.id);
  assert.strictEqual(l1[0].root, wsRoot);
  assert.strictEqual(l1[0].attached, 1);

  // 2) 탭 닫기(disposeTerminal) = detach — 세션은 남고 attached 0
  c1.send('disposeTerminal', { term: 1 });
  await sleep(600);
  const l2 = await c1.call('listTerminals', {});
  assert.deepStrictEqual(l2.map((t) => [t.id, t.attached]), [[t1.id, 0]], `detach 후 목록: ${JSON.stringify(l2)}`);
  c1.ws.close();

  // 3) 백엔드 사망 → 데몬 유휴 종료 → tmux 서버는 산다. 새 백엔드·새 세션이 목록에서 찾아 attach —
  //    같은 셸(MARK 유지)이고 스크롤백(이전 출력)이 화면에 다시 그려진다
  backend.kill('SIGKILL');
  await sleep(4000);
  assert.ok(!existsSync(env.SUPERLITE_SOCK), '파일 데몬은 백엔드 사망 후 유휴 종료해야 한다');
  assert.ok(serverUp(), 'tmux 서버는 백엔드 사망을 넘어 살아야 한다');
  backend = startBackend();
  const c2 = await connect('s2');
  await c2.attach;
  const l3 = await c2.call('listTerminals', {});
  assert.strictEqual(l3.length, 1, `재기동 후 목록: ${JSON.stringify(l3)}`);
  c2.send('createTerminal', { term: 7, cols: 80, rows: 24, attach: l3[0].id });
  await sleep(1200);
  assert.strictEqual(c2.tmux.get(7)?.id, t1.id, `attach termTmux: ${JSON.stringify(c2.tmux.get(7))}`);
  assert.ok(text(c2).includes('T=none'), `스크롤백 재생 (이전 출력): ${JSON.stringify(c2.data)}`);
  c2.send('termWrite', { term: 7, data: 'echo back-$MARK\r' });
  await sleep(900);
  assert.ok(text(c2).includes('back-alive-2'), `같은 셸 (환경변수 유지): ${JSON.stringify(c2.data)}`);
  // 같은 세션을 두 번째 탭으로 — 다중 attach, attached 2
  c2.send('createTerminal', { term: 8, cols: 80, rows: 24, attach: t1.id });
  await sleep(900);
  assert.strictEqual((await c2.call('listTerminals', {}))[0].attached, 2, '다중 attach');
  // 이름 바꾸기
  await c2.call('renameTerminal', { id: t1.id, name: 'build' });
  assert.strictEqual((await c2.call('listTerminals', {}))[0].name, 'build');

  // 4) 클라이언트 tmux.conf 적용 — 문법 오류는 에러가 아니라 메시지로 온다
  const bad = await c2.call('tmuxConf', { content: 'set -g no-such-option 1\n' });
  assert.ok(typeof bad.message === 'string' && bad.message.length > 0, `conf 오류 메시지: ${JSON.stringify(bad)}`);
  const good = await c2.call('tmuxConf', { content: 'set -g history-limit 1234\n' });
  assert.strictEqual(good.message, '', `conf 정상: ${JSON.stringify(good)}`);

  // 5) killTerminal — 세션 종료, 두 클라이언트 PTY 도 끝난다(termExit), 목록이 빈다
  await c2.call('killTerminal', { id: t1.id });
  await sleep(800);
  assert.deepStrictEqual(await c2.call('listTerminals', {}), [], 'kill 후 목록');
  c2.ws.close();
  backend.kill();
  // 세션 0 → tmux 서버 자진 종료 (exit-empty)
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (!serverUp()) { gone = true; break; }
  }
  assert.ok(gone, 'tmux 서버가 세션 0 에서 내려가지 않았다 (exit-empty)');
  console.log('tmux check: OK');
} finally {
  clearTimeout(deadline);
  backend.kill();
  // 남은 세션이 있으면 그것만 정리 (전용 소켓 — 사용자 서버와 무관). kill-server 는 쓰지 않는다
  if (existsSync(env.SUPERLITE_TMUX_SOCK)) {
    const { execSync } = await import('node:child_process');
    try { execSync(`tmux -S "${env.SUPERLITE_TMUX_SOCK}" kill-session -a; tmux -S "${env.SUPERLITE_TMUX_SOCK}" kill-session`, { stdio: 'ignore' }); } catch {}
  }
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
