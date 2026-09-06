// excludes 스모크 — 트리(files.exclude 기본값)와 검색·quickOpen 걷기(--hidden + 제외 글롭).
//   cargo build --workspace 후: node backend/relay/check-excludes.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'sl-excl-'));
// 부모 디렉토리의 gitignore 는 워크스페이스에 새면 안 된다 (VS Code useParentIgnoreFiles=false)
writeFileSync(join(dir, '.gitignore'), '*.ts\n');
const wsRoot = join(dir, 'root');
// 픽스처: VCS 메타 / dotfile / node_modules(중첩 포함) / gitignore 대상
mkdirSync(join(wsRoot, '.git'), { recursive: true });
writeFileSync(join(wsRoot, '.git/config'), 'needle git\n');
mkdirSync(join(wsRoot, '.github/workflows'), { recursive: true });
writeFileSync(join(wsRoot, '.github/workflows/ci.yml'), 'needle ci\n');
writeFileSync(join(wsRoot, '.env'), 'needle env\n');
writeFileSync(join(wsRoot, 'Thumbs.db'), 'x');
mkdirSync(join(wsRoot, 'node_modules/pkg'), { recursive: true });
writeFileSync(join(wsRoot, 'node_modules/pkg/index.js'), 'needle nm\n');
mkdirSync(join(wsRoot, 'sub/node_modules'), { recursive: true });
writeFileSync(join(wsRoot, 'sub/node_modules/dep.js'), 'needle nested nm\n');
mkdirSync(join(wsRoot, 'sub/.git'), { recursive: true });
writeFileSync(join(wsRoot, 'sub/.git/HEAD'), 'needle subgit\n');
mkdirSync(join(wsRoot, 'dist'));
writeFileSync(join(wsRoot, 'dist/out.js'), 'needle dist\n');
writeFileSync(join(wsRoot, '.gitignore'), 'dist/\n');
writeFileSync(join(wsRoot, 'app.ts'), 'needle app\n');

const env = {
  ...process.env,
  SUPERLITE_SOCK: join(dir, 'daemon.sock'),
  SUPERLITE_HTTP: '127.0.0.1:18799',
  SUPERLITE_GRACE_SECS: '2',
};
const bin = fileURLToPath(new URL('../../target/debug/superlite-backend', import.meta.url));
const backend = spawn(bin, [wsRoot], { env, stdio: 'ignore' });
backend.on('error', () => {}); // ENOENT 는 아래 접속 실패 assert 가 안내한다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; ; i++) {
    try {
      ws = new WebSocket('ws://127.0.0.1:18799/ws');
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

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === undefined) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.result);
  };
  const call = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // 트리: files.exclude 기본값만 숨김 — node_modules·dotfile 은 보인다
  const names = (await call('readDir', { path: '' })).map((e) => e.name);
  assert.ok(!names.includes('.git'), '트리에서 .git 숨김');
  assert.ok(!names.includes('Thumbs.db'), '트리에서 Thumbs.db 숨김');
  assert.ok(names.includes('node_modules'), '트리에 node_modules 보임 (VS Code 기본)');
  assert.ok(names.includes('.github'), '트리에 dotfile 디렉토리 보임');
  assert.ok(names.includes('.env'), '트리에 dotfile 보임');
  assert.ok(names.includes('dist'), '트리는 gitignore 를 안 따른다 (VS Code 동일)');

  // quickOpen (와이어 v12, 빈 패턴 = 목록 전체): dotfile 포함, .git/node_modules/gitignore 대상 제외
  const files = (await call('quickOpen', { pattern: '', fresh: true })).items.map((it) => it.path);
  assert.ok(files.includes('.env'), 'Quick Open 에 dotfile 포함');
  assert.ok(files.includes('.github/workflows/ci.yml'), 'Quick Open 에 숨김 디렉토리 하위 포함');
  assert.ok(!files.some((f) => f.startsWith('.git/')), 'Quick Open 에서 .git 제외');
  assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'Quick Open 에서 node_modules 제외');
  assert.ok(!files.some((f) => f.includes('sub/node_modules')), '중첩 node_modules 도 제외 (**/ 글롭)');
  assert.ok(!files.some((f) => f.includes('sub/.git')), '중첩 .git 도 제외');
  assert.ok(!files.some((f) => f.startsWith('dist/')), 'Quick Open 에서 gitignore 대상 제외');
  assert.ok(files.includes('app.ts'), '부모 디렉토리 gitignore(*.ts) 는 새지 않는다');

  // search: 같은 제외 규칙
  const hits = (await call('search', { query: 'needle', opts: {} })).map((f) => f.path);
  assert.ok(hits.includes('.env'), '검색이 dotfile 을 본다');
  assert.ok(hits.includes('app.ts'), '검색 기본 동작');
  assert.ok(!hits.some((f) => f.startsWith('.git/')), '검색에서 .git 제외');
  assert.ok(!hits.some((f) => f.startsWith('node_modules/')), '검색에서 node_modules 제외');
  assert.ok(!hits.some((f) => f.startsWith('dist/')), '검색에서 gitignore 대상 제외');

  console.log('excludes check: OK');
} finally {
  backend.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
