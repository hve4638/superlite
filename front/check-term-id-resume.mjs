// 같은 세션 id 로 재접속(창 새로고침 = 데몬 세션 resume)한 뒤의 term id 충돌 방지 (와이어 v22, ticket
// multi-client-terminal-crosstalk): attach 응답 terms 로 살아 있는 id 를 알리고, 겹치는 createTerminal 은
// 조용히 옛 PTY 에 묶는 대신 termExit 로 거부한다. 수정 전에는 겹친 번호의 입력이 다른 tmux 세션으로 들어갔다. relay 를 미리 띄우고 URL 을 준다:
//   node front/check-term-id-resume.mjs ws://127.0.0.1:8797 /tmp/mctc-root /tmp/mctc-tmux.sock
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const [base, root, tmuxSock] = process.argv.slice(2);
if (!base || !root || !tmuxSock) {
  console.error('usage: check-term-id-resume.mjs <ws-base> <root> <tmux-sock>');
  process.exit(2);
}
const session = `resume-${Date.now()}`;
const url = `${base}/ws?folder=${encodeURIComponent(root)}&session=${session}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = setTimeout(() => {
  console.error('timeout (30s)');
  process.exit(1);
}, 30000);

/** 연결 하나 — 텍스트 프레임을 JSON 으로 모으고 조건 대기를 제공한다 */
function connect() {
  const ws = new WebSocket(url);
  const log = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    log.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  const wait = (pred, ms = 8000) =>
    new Promise((resolve, reject) => {
      const hit = log.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error('wait timeout'));
      }, ms);
    });
  const send = (o) => ws.send(JSON.stringify(o));
  const opened = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error(`ws error ${e.message ?? ''}`));
  });
  return { ws, log, wait, send, opened };
}

const attached = (c) => c.wait((m) => m.id === 0 && m.result);
const tmuxOf = (c, term) => c.wait((m) => m.event === 'termTmux' && m.term === term).then((m) => m.id);
const capture = (id) => execFileSync('tmux', ['-S', tmuxSock, 'capture-pane', '-p', '-t', id], { encoding: 'utf8' });

// 1) 첫 연결 — 터미널 1·2 (tmux 세션 A·B)
const c1 = connect();
await c1.opened;
const a1 = await attached(c1);
console.log('attach#1 resumed =', a1.result.resumed, 'mode =', a1.result.terminal?.mode);
c1.send({ method: 'createTerminal', params: { term: 1, cols: 80, rows: 24 } });
const A = await tmuxOf(c1, 1);
c1.send({ method: 'createTerminal', params: { term: 2, cols: 80, rows: 24 } });
const B = await tmuxOf(c1, 2);
console.log('term1 ->', A, ' term2 ->', B);
await sleep(800);

// 2) 새로고침 흉내 — 연결만 끊는다 (세션 grace 안). 옛 PTY 1·2 는 데몬에 남는다
c1.ws.close();
await sleep(500);

// 3) 같은 세션 id 로 재접속 — 프론트 카운터는 1 부터. 저장된 순서가 B, A 였다고 치자
const c2 = connect();
await c2.opened;
const a2 = await attached(c2);
console.log('attach#2 resumed =', a2.result.resumed, 'terms =', JSON.stringify(a2.result.terms));
// 와이어 v22: 살아 있는 id 목록이 와야 프론트가 카운터를 그 위로 올릴 수 있다
assert.deepStrictEqual(a2.result.terms, [1, 2], 'attach 응답 terms');
// (a) 프론트가 카운터를 올린 경우 — 겹치지 않는 번호로 B 에 붙고 입력은 B 로
const fresh = Math.max(...a2.result.terms) + 1;
c2.send({ method: 'createTerminal', params: { term: fresh, cols: 80, rows: 24, attach: B } });
const attachedB = await tmuxOf(c2, fresh);
assert.strictEqual(attachedB, B, 'fresh id 가 B 에 붙는다');
const marker = `XTALK${Date.now()}`;
c2.send({ method: 'termWrite', params: { term: fresh, data: `echo ${marker}\n` } });
await sleep(1200);
const inA = capture(A).includes(marker);
const inB = capture(B).includes(marker);
console.log(`term ${fresh} 입력 "${marker}" — A 에 있음: ${inA}, B 에 있음: ${inB}`);
assert.ok(inB && !inA, '입력이 B 로만 간다');
// (b) 겹치는 번호를 굳이 보내면 — 조용히 옛 PTY 에 묶이지 않고 그 탭에 termExit(code 없음)로 드러난다
c2.send({ method: 'createTerminal', params: { term: 1, cols: 80, rows: 24, attach: B } });
const exit = await c2.wait((m) => m.event === 'termExit' && m.term === 1);
assert.strictEqual(exit.code, undefined, 'termExit 에 code 없음');
const notice = c2.log.find((m) => m.event === 'termData' && m.term === 1 && String(m.data).includes('id 충돌'));
assert.ok(notice, '충돌 안내 출력');
const marker2 = `XTALK2-${Date.now()}`;
c2.send({ method: 'termWrite', params: { term: 1, data: `echo ${marker2}\n` } });
await sleep(1200);
console.log(`옛 term 1 은 그대로 A 에 붙어 있다 (A 에 있음: ${capture(A).includes(marker2)})`);
c2.ws.close();

// (c) 실제 WsBackend(ws.ts) — 같은 session id 로 두 번째 인스턴스를 만들면 attach 응답 terms 로 카운터를 올려
//     새 터미널이 3 부터 발급된다 (Node 22 는 .ts 를 타입 제거만으로 import 한다)
const { WsBackend } = await import(new URL('./src/backend/ws.ts', import.meta.url));
const sid2 = `resume-front-${Date.now()}`;
const wsBase = `${base}/ws?folder=${encodeURIComponent(root)}`;
const modeOnce = (b) => new Promise((r) => b.onTerminalMode(() => r()));
const b1 = new WsBackend(wsBase, sid2);
await modeOnce(b1);
const t1 = b1.createTerminal(80, 24);
const t2 = b1.createTerminal(80, 24);
assert.deepStrictEqual([t1.id, t2.id], [1, 2]);
await new Promise((r) => t2.onTmux(() => r()));
b1.dispose();
await sleep(500);
const b2 = new WsBackend(wsBase, sid2);
await modeOnce(b2);
const t3 = b2.createTerminal(80, 24);
console.log('두 번째 WsBackend 의 첫 터미널 id =', t3.id);
assert.strictEqual(t3.id, 3, 'WsBackend 가 살아 있는 id 위로 카운터를 올린다');
await new Promise((r) => t3.onTmux(() => r()));
b2.dispose();
clearTimeout(deadline);
console.log('ok');
