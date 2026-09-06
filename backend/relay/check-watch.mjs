// 감시 스모크 — 외부 파일 변경이 fsChanges 이벤트로 프론트까지 푸시되는지 검증한다.
//   cargo build --workspace 후: node backend/relay/check-watch.mjs
// 워크스페이스는 임시 디렉터리 — create/change/delete 와 .git 심층 필터를 확인한다.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-watch-'));
const wsRoot = join(dir, 'root');
mkdirSync(wsRoot);
const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18796',
  SUPERLITE_GRACE_SECS: '2', // 체크 종료 후 데몬이 오래 남지 않게
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18796/ws');
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

  // fsChanges 를 path → kind 로 누적. 배치·순서에 의존하지 않는다.
  const seen = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.event === 'fsChanges') for (const c of m.changes) seen.set(c.path, c.kind);
  };
  // attach(워처 시작)는 WS 연결 시 백엔드가 보낸다 — 워처가 서기까지 잠깐 대기
  await sleep(500);

  const expect = async (path, kind, label) => {
    for (let i = 0; i < 30; i++) {
      if (seen.get(path) === kind) return;
      await sleep(100);
    }
    assert.fail(`${label}: ${path} → ${JSON.stringify([...seen])}`);
  };

  writeFileSync(join(wsRoot, 'a.txt'), 'one\n');
  await expect('a.txt', 'create', '생성 이벤트');

  seen.clear();
  writeFileSync(join(wsRoot, 'a.txt'), 'two\n');
  await expect('a.txt', 'change', '수정 이벤트');

  seen.clear();
  rmSync(join(wsRoot, 'a.txt'));
  await expect('a.txt', 'delete', '삭제 이벤트');

  // .git 은 1단계만 통과 — objects 심층 churn 은 걸러진다
  seen.clear();
  mkdirSync(join(wsRoot, '.git/objects/ab'), { recursive: true });
  // 새 디렉터리에 watch 가 등록되기 전에 쓰면 이벤트를 놓친다 (inotify 고유 한계 —
  // 실사용은 창 포커스 전체 리프레시가 안전망). 여기선 등록 시간을 주고 쓴다.
  await sleep(300);
  writeFileSync(join(wsRoot, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(wsRoot, '.git/objects/ab/cdef'), 'x');
  await expect('.git/HEAD', 'create', '.git 1단계 이벤트');
  await sleep(500); // 심층 이벤트가 있다면 이미 도착했을 시간
  assert.ok(![...seen.keys()].some((p) => p.startsWith('.git/objects/ab')), '.git 심층 필터');

  // 심링크는 따라가지 않는다 — 루트 밖 파일이 루트 상대 경로로 새면 attach 봉쇄가 무의미해진다
  mkdirSync(join(dir, 'outside'));
  symlinkSync(join(dir, 'outside'), join(wsRoot, 'link'));
  await sleep(300);
  seen.clear();
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'x');
  await sleep(500);
  assert.ok(![...seen.keys()].some((p) => p.startsWith('link/')), '심링크 미추적');

  console.log('watch check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
