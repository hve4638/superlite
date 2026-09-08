// WsBackend 재연결 스모크 (ticket relay-conn-fixes) — relay 없이 가짜 WS 서버로 close 코드별 동작을 잰다.
// 영구 실패(4403·4502) 뒤에도 요청은 큐에 남고 reconnect() 로 다시 열리면 전송된다 (ws.itir 계약).
// 급단절(코드 없는 close) 은 진행 중 요청만 실패시키고 1초 뒤 자동 재연결 — 큐는 그때 나간다.
//   node front/check-ws.mjs   (Node 22 — .ts 는 타입 제거만으로 import 된다)
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const deadline = setTimeout(() => {
  console.error('check timeout (20s)');
  process.exit(1);
}, 20000);

// Node(undici) 의 WebSocket 은 핸드셰이크 실패에 error 만 내고 close 를 안 낸다 — 브라우저는 error 뒤
// close(1006) 이 따라온다. ws.ts 는 onclose 만 보므로 브라우저 순서를 흉내 낸다
const NodeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NodeWebSocket {
  constructor(...args) {
    super(...args);
    let closed = false;
    this.addEventListener('close', () => (closed = true));
    this.addEventListener('error', () => setTimeout(() => {
      if (closed) return;
      closed = true;
      this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '', wasClean: false }));
    }, 0));
  }
};

const { WsBackend } = await import(fileURLToPath(new URL('./src/backend/ws.ts', import.meta.url)));

// ---- 최소 WS 서버: upgrade 수락, 텍스트 프레임 수신·송신, close 프레임 — 이 검사에 필요한 만큼만
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, payload]);
}
function parseFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f;
    const masked = (buf[i + 1] & 0x80) !== 0;
    let len = buf[i + 1] & 0x7f;
    let j = i + 2;
    if (len === 126) { len = buf.readUInt16BE(j); j += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(j)); j += 8; }
    const mask = masked ? buf.subarray(j, j + 4) : null;
    if (masked) j += 4;
    if (j + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(j, j + len));
    if (mask) for (let k = 0; k < len; k++) payload[k] ^= mask[k & 3];
    out.push({ opcode, payload });
    i = j + len;
  }
  return { frames: out, rest: buf.subarray(i) };
}

/** 접속마다 policy(n) 이 정한 대로: {close:{code,reason}} 이면 열자마자 닫고, 아니면 attach 응답 후 요청을 에코 */
const state = { conns: 0, received: [] };
let policy = () => null;
const sockets = new Set();
const server = createServer();
server.on('upgrade', (req, sock) => {
  const n = ++state.conns;
  const p = policy(n);
  // reject: 101 전에 끊는다 — 브라우저 기준 onopen 없이 onerror + close 1006
  if (p?.reject) {
    sock.destroy();
    return;
  }
  sockets.add(sock);
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => {}); // 정리 중 닫힌 소켓에 쓰는 EPIPE
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  const sendJson = (o) => sock.write(frame(1, Buffer.from(JSON.stringify(o))));
  const sendClose = (code, reason) => sock.write(frame(8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)])));
  if (p?.close) {
    sendClose(p.close.code, p.close.reason ?? '');
  } else {
    sendJson({ id: 0, result: { resumed: n > 1 } });
  }
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    const { frames, rest } = parseFrames(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 8) { sock.end(); return; }
      if (f.opcode !== 1) continue;
      const m = JSON.parse(f.payload.toString());
      state.received.push({ conn: n, ...m });
      if (typeof m.id === 'number') sendJson({ id: m.id, result: { echo: m.method } });
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `ws://127.0.0.1:${server.address().port}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** promise 의 현재 상태 — 미해결 판정용 */
const settled = (p) => Promise.race([p.then(() => 'resolved', () => 'rejected'), sleep(50).then(() => 'pending')]);

const backends = [];
try {
  // ---- 1) 4502(접속 실패) 뒤 요청 → 큐에 남아 reconnect() 후 전송되어 응답을 받는다
  policy = (n) => (n === 1 ? { close: { code: 4502, reason: 'ssh 실패' } } : null);
  const b1 = new WsBackend(url, 's1');
  backends.push(b1);
  const conn1 = [];
  b1.onConnection((ok, err) => conn1.push([ok, err]));
  await sleep(300);
  assert.deepStrictEqual(conn1, [[false, 'ssh 실패']], `4502 통보: ${JSON.stringify(conn1)}`);
  const req1 = b1.workspace();
  await sleep(100);
  assert.strictEqual(await settled(req1), 'pending', '영구 실패 뒤 요청은 실패 통보 없이 대기해야 한다');
  assert.strictEqual(state.received.length, 0, '닫힌 소켓으로 보내지 않는다');
  b1.reconnect();
  const res1 = await Promise.race([req1, sleep(1500).then(() => 'timeout')]);
  assert.deepStrictEqual(res1, { echo: 'workspace' }, `4502 → reconnect 뒤 큐 전송: ${JSON.stringify(res1)} (received=${JSON.stringify(state.received)})`);
  assert.deepStrictEqual(conn1.at(-1), [true, undefined], '재접속 성공 통보');

  // ---- 2) 4403(미등록 세션) 도 같다
  state.conns = 0;
  state.received.length = 0;
  policy = (n) => (n === 1 ? { close: { code: 4403, reason: 'unknown session' } } : null);
  const b2 = new WsBackend(url, 's2');
  backends.push(b2);
  await sleep(300);
  const req2 = b2.stat('/x');
  await sleep(100);
  assert.strictEqual(await settled(req2), 'pending', '4403 뒤 요청 대기');
  b2.reconnect();
  const res2 = await Promise.race([req2, sleep(1500).then(() => 'timeout')]);
  assert.deepStrictEqual(res2, { echo: 'stat' }, `4403 → reconnect 뒤 큐 전송: ${JSON.stringify(res2)}`);

  // ---- 3) 영구 실패 → reconnect 가 다시 급단절(1006) 로 실패해도 미전송 큐는 살아남고,
  //         다음 자동 재연결(1초) 때 나간다. 종전에는 낡은 opened=true 로 큐까지 실패 처리됐다
  state.conns = 0;
  state.received.length = 0;
  policy = (n) => (n === 1 ? { close: { code: 4502, reason: 'x' } } : n === 2 ? { reject: true } : null);
  const b3 = new WsBackend(url, 's3');
  backends.push(b3);
  const conn3 = [];
  b3.onConnection((ok, err) => conn3.push([ok, err]));
  await sleep(300);
  const req3 = b3.workspace();
  // 2번째 접속은 upgrade 전에 거부 → 1006 — 큐(req3)는 아직 미전송이라 살아 있어야 한다
  b3.reconnect();
  await sleep(300);
  assert.strictEqual(await settled(req3), 'pending', `급단절 뒤 미전송 큐가 실패 처리됐다 (received=${JSON.stringify(state.received)})`);
  const res3 = await Promise.race([req3, sleep(2500).then(() => 'timeout')]);
  assert.deepStrictEqual(res3, { echo: 'workspace' }, `자동 재연결 뒤 큐 전송: ${JSON.stringify(res3)} conns=${state.conns} received=${JSON.stringify(state.received)} conn3=${JSON.stringify(conn3)}`);

  // ---- 4) 열린 연결의 급단절 — 진행 중 요청만 실패, 이후 요청은 큐 → 자동 재연결 뒤 전송 (기존 계약 회귀)
  state.conns = 0;
  state.received.length = 0;
  policy = () => null;
  const b4 = new WsBackend(url, 's4');
  backends.push(b4);
  await sleep(200);
  assert.deepStrictEqual(await b4.workspace(), { echo: 'workspace' }, '정상 요청');
  const req4 = b4.stat('/after');
  await sleep(50);
  assert.strictEqual(await settled(req4), 'resolved', '정상 요청 2');
  // 서버가 임의로 끊는다 (코드 없는 close)
  for (const s of sockets) s.destroy();
  await sleep(200);
  const req5 = b4.readDir('/q');
  assert.strictEqual(await settled(req5), 'pending', '끊김 중 요청은 큐에');
  const res5 = await Promise.race([req5, sleep(2500).then(() => 'timeout')]);
  assert.deepStrictEqual(res5, { echo: 'readDir' }, `재연결 뒤 큐 전송: ${JSON.stringify(res5)}`);

  console.log('ws check: OK');
} finally {
  clearTimeout(deadline);
  for (const b of backends) b.dispose();
  server.close();
  for (const s of sockets) s.destroy();
}
