// 수명 스모크 — 데몬 자동 기동(tmux 방식)과 유휴 자진 종료를 검증한다.
//   cargo build --workspace 후: node backend/check-lifecycle.mjs
// 개발 중 인스턴스와 부딪히지 않게 소켓·포트를 전용으로 띄운다.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-check-'));
const sock = join(dir, 'daemon.sock');
const env = {
  ...process.env,
  SUPERLIGHT_SOCK: sock, // 데몬은 백엔드의 자식 — env 를 물려받아 같은 소켓을 쓴다
  SUPERLIGHT_HTTP: '127.0.0.1:18795',
  SUPERLIGHT_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlight-backend', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const backend = spawn(bin, [root], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1) 백엔드가 데몬을 자동 기동하고 중계 왕복이 된다
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18795/ws');
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = () => rej(new Error('connect'));
      });
      break;
    } catch {
      assert.ok(i < 50, '백엔드 기동 실패 (5초) — cargo build --workspace 먼저?');
      await sleep(100);
    }
  }
  const resp = await new Promise((res, rej) => {
    // attach 응답(id 0)이 먼저 중계될 수 있다 — 프론트처럼 자기 id 만 취한다
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) res(m);
    };
    ws.send(JSON.stringify({ id: 1, method: 'workspace', params: {} }));
    setTimeout(() => rej(new Error('workspace 응답 없음')), 3000);
  });
  assert.ok(resp.result.rootPath.length > 0, 'workspace via 중계');
  assert.ok(existsSync(sock), '데몬 소켓 존재');
  ws.close();

  // 2) 백엔드가 죽으면(연결 0) 데몬이 grace(2초) 뒤 소켓을 지우고 자진 종료한다
  backend.kill('SIGKILL');
  await sleep(6000);
  assert.ok(!existsSync(sock), '데몬 유휴 자진 종료 — 소켓이 남아 있다');
  console.log('lifecycle check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
