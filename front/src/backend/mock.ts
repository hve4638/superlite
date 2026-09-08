import type {
  DirEntry, FileContent, FileSearchResult, FileStat, GitLogItem, GitStatus, QuickOpenItem, QuickOpenResult, TerminalSession, ThinBackend, WorkspaceInfo, WriteResult,
} from './types';

// WHY: 이 픽스처는 tools/refspec/mock-workspace 와 파일/내용/git 상태가 1:1 이다.
//      레퍼런스(Code OSS)에 같은 폴더를 열어 두 구현을 differential 비교하기 위한 전제이므로,
//      한쪽을 바꾸면 반드시 다른 쪽도 같이 바꿔야 한다.

const FORMAT_TS_HEAD = `const UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return \`\${n.toFixed(1)} \${UNITS[i]}\`;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
`;

/** path → 쓰기 세대. mock 의 etag 원천 (미기록 = 0). */
const ETAGS = new Map<string, number>();

/** FILES 키(파일 경로)로는 표현 못 하는 빈 디렉토리 — createDir·rename 산물 */
const DIRS = new Set<string>();

/** 명시적(DIRS) + 암시적(FILES 키에서 유도) 디렉토리 존재 검사 */
function isDirPath(p: string): boolean {
  return DIRS.has(p) || Object.keys(FILES).some((f) => f.startsWith(`${p}/`));
}

const FILES: Record<string, string> = {
  'package.json': `{
  "name": "acme-server",
  "version": "1.2.0",
  "type": "module",
  "scripts": {
    "dev": "node --watch src/index.ts",
    "test": "node --test"
  }
}
`,
  'README.md': `# acme-server

Example HTTP API server used as a fixture workspace.

## Run

\`\`\`sh
npm run dev
\`\`\`

## Layout

- \`src/index.ts\` — entry point
- \`src/app.ts\` — request routing
- \`src/utils/format.ts\` — formatting helpers
`,
  '.gitignore': `node_modules/
dist/
`,
  'NOTES.md': `# Notes

Scratch notes for the fixture.
`,
  'docs/guide.md': `# Guide

## Configuration

Set \`PORT\` to change the listen port. Defaults to \`3000\`.

## Endpoints

| Path | Description |
| --- | --- |
| \`/health\` | Liveness probe |
| \`/stats\` | Memory statistics |
`,
  'src/index.ts': `import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  console.log(\`listening on :\${port}\`);
});
`,
  'src/app.ts': `import { formatDate, formatBytes } from './utils/format.ts';

interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: (req: Request) => Response;
}

const routes: Route[] = [
  {
    method: 'GET',
    path: '/health',
    handler: () => Response.json({ ok: true, at: formatDate(new Date()) }),
  },
  {
    method: 'GET',
    path: '/stats',
    handler: () => Response.json({ heap: formatBytes(process.memoryUsage().heapUsed) }),
  },
];

export function createApp() {
  return {
    listen(port: number, onReady?: () => void) {
      // A real server would bind here; the fixture only logs.
      void routes;
      void port;
      onReady?.();
    },
  };
}
`,
  'src/utils/format.ts': `${FORMAT_TS_HEAD}
export function formatPercent(v: number): string {
  return \`\${(v * 100).toFixed(1)}%\`;
}
`,
};

// HEAD 스냅샷 — 초기 커밋 시점의 추적 파일들. NOTES.md 는 untracked 라 제외,
// format.ts 는 워킹트리에 formatPercent 가 추가되기 전 내용이다.
/** 가짜 HEAD 해시 — 커밋마다 증가 (실 백엔드의 커밋 해시 역할) */
let headSerial = 0;
let HEAD: Record<string, string> = (() => {
  const head = { ...FILES };
  delete head['NOTES.md'];
  head['src/utils/format.ts'] = FORMAT_TS_HEAD;
  return head;
})();
/** 인덱스(스테이징 영역) — HEAD 에서 출발, stage/unstage 로 갱신, 커밋이 HEAD 로 승격 */
let INDEX: Record<string, string> = { ...HEAD };
const MOCK_LOG: GitLogItem[] = [
  { hash: 'mock-0', subject: 'initial', author: 'fixture', date: '2 days ago' },
];

function delay<T>(v: T): Promise<T> {
  // WHY: 실제 백엔드는 네트워크 왕복이 있다. 0ms resolve 로도 마이크로태스크 경계가 생겨,
  //      동기 가정으로 작성된 UI 코드를 개발 단계에서 걸러낸다.
  return Promise.resolve(v);
}

export class MockBackend implements ThinBackend {
  workspace(): Promise<WorkspaceInfo> {
    return delay({ name: 'mock-workspace', rootPath: '/workspace/mock-workspace' });
  }

  readDir(path: string): Promise<DirEntry[]> {
    const prefix = path === '' ? '' : `${path}/`;
    const seen = new Map<string, DirEntry>();
    for (const file of Object.keys(FILES)) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        seen.set(rest, { name: rest, path: file, kind: 'file' });
      } else {
        const dir = rest.slice(0, slash);
        seen.set(dir, { name: dir, path: `${prefix}${dir}`, kind: 'directory' });
      }
    }
    for (const d of DIRS) {
      if (d === path || !d.startsWith(prefix)) continue;
      const seg = d.slice(prefix.length).split('/')[0];
      if (!seen.has(seg)) seen.set(seg, { name: seg, path: `${prefix}${seg}`, kind: 'directory' });
    }
    return delay([...seen.values()]);
  }

  readFile(path: string, opts?: { maxBytes?: number; encoding?: 'base64'; offset?: number }): Promise<FileContent> {
    const content = FILES[path];
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
    const etag = String(ETAGS.get(path) ?? 0);
    // 범위 읽기 (hex 뷰어 청크) — 문자열 바이트를 잘라 base64 로
    if (opts?.offset !== undefined) {
      const bytes = new TextEncoder().encode(content).slice(opts.offset, opts.offset + (opts.maxBytes ?? Infinity));
      return delay({ content: btoa(String.fromCharCode(...bytes)), etag });
    }
    if (opts?.maxBytes !== undefined && content.length > opts.maxBytes) {
      return delay({ unopenable: { kind: 'large', size: content.length }, etag });
    }
    // mock 트리엔 이미지가 없다 — 계약 대칭으로 텍스트를 base64 인코딩만 해서 돌려준다
    if (opts?.encoding === 'base64') {
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
      return delay({ content: b64, etag });
    }
    return delay({ content, etag });
  }

  stat(path: string): Promise<FileStat> {
    if (!(path in FILES)) return Promise.reject(new Error(`ENOENT: ${path}`));
    return delay({ etag: String(ETAGS.get(path) ?? 0), size: new TextEncoder().encode(FILES[path]).length });
  }

  // ponytail: mock 엔 외부 쓰기 주체가 없어 충돌이 생길 수 없다 — 검사 생략, etag 만 굴린다.
  // encoding(base64)도 무시하고 그대로 저장 — mock 파일 맵은 문자열뿐이고 읽는 쪽도 에디터뿐이다
  writeFile(path: string, content: string, _etag?: string, _encoding?: 'base64', append?: boolean): Promise<WriteResult> {
    FILES[path] = append ? (FILES[path] ?? '') + content : content;
    const v = (ETAGS.get(path) ?? 0) + 1;
    ETAGS.set(path, v);
    return delay({ etag: String(v) });
  }

  createFile(path: string): Promise<void> {
    if (path in FILES || isDirPath(path)) return Promise.reject(new Error(`이미 존재: ${path}`));
    FILES[path] = '';
    ETAGS.set(path, (ETAGS.get(path) ?? 0) + 1);
    return delay(undefined);
  }

  createDir(path: string): Promise<void> {
    // 배타적 생성 (데몬 계약과 동일 — undo 의 전제 보호)
    if (path in FILES || isDirPath(path)) return Promise.reject(new Error(`이미 존재: ${path}`));
    DIRS.add(path);
    return delay(undefined);
  }

  rename(from: string, to: string): Promise<void> {
    if (to in FILES || isDirPath(to)) return Promise.reject(new Error(`이미 존재: ${to}`));
    if (!isDirPath(from) && !(from in FILES)) return Promise.reject(new Error(`ENOENT: ${from}`));
    const move = (p: string) => (p === from ? to : `${to}${p.slice(from.length)}`);
    for (const f of Object.keys(FILES)) {
      if (f !== from && !f.startsWith(`${from}/`)) continue;
      FILES[move(f)] = FILES[f];
      delete FILES[f];
      const v = ETAGS.get(f);
      if (v !== undefined) {
        ETAGS.set(move(f), v);
        ETAGS.delete(f);
      }
    }
    for (const d of [...DIRS]) {
      if (d !== from && !d.startsWith(`${from}/`)) continue;
      DIRS.delete(d);
      DIRS.add(move(d));
    }
    return delay(undefined);
  }

  delete(path: string): Promise<void> {
    // 없는 경로는 에러 (데몬의 symlink_metadata 실패와 동일 계약)
    if (!(path in FILES) && !isDirPath(path)) return Promise.reject(new Error(`ENOENT: ${path}`));
    for (const f of Object.keys(FILES)) {
      if (f !== path && !f.startsWith(`${path}/`)) continue;
      delete FILES[f];
      ETAGS.delete(f);
    }
    for (const d of [...DIRS]) {
      if (d === path || d.startsWith(`${path}/`)) DIRS.delete(d);
    }
    return delay(undefined);
  }

  quickOpen(pattern: string): Promise<QuickOpenResult> {
    // 데몬 quick_open 과 같은 규칙 — 파일명 subsequence 우선, 실패 시 전체 경로(하이라이트 없음)
    const q = pattern.toLowerCase();
    const sub = (target: string): number[] | null => {
      const t = target.toLowerCase();
      const idx: number[] = [];
      let ti = 0;
      for (const ch of q) {
        ti = t.indexOf(ch, ti);
        if (ti < 0) return null;
        idx.push(ti);
        ti += 1;
      }
      return idx;
    };
    const byName: QuickOpenItem[] = [];
    const byPath: QuickOpenItem[] = [];
    for (const path of Object.keys(FILES).sort()) {
      const hl = sub(path.slice(path.lastIndexOf('/') + 1));
      if (hl) byName.push({ path, highlights: hl });
      else if (sub(path)) byPath.push({ path, highlights: [] });
    }
    return delay({ items: [...byName, ...byPath], limitHit: false });
  }

  search(query: string, opts?: { caseSensitive?: boolean }): Promise<FileSearchResult[]> {
    if (!query) return delay([]);
    const needle = opts?.caseSensitive ? query : query.toLowerCase();
    const results: FileSearchResult[] = [];
    for (const [path, content] of Object.entries(FILES)) {
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const hay = opts?.caseSensitive ? lines[i] : lines[i].toLowerCase();
        const ranges: [number, number][] = [];
        let at = hay.indexOf(needle);
        while (at !== -1) {
          ranges.push([at, at + needle.length]);
          at = hay.indexOf(needle, at + needle.length);
        }
        if (ranges.length) matches.push({ line: i, lineText: lines[i], ranges });
      }
      if (matches.length) results.push({ path, matches });
    }
    return delay(results);
  }

  // ponytail: mock 의 저장소는 루트 하나 — repo 인자는 받기만 하고 무시한다
  gitRepos(): Promise<string[]> {
    return delay(['']);
  }

  gitStatus(_repo: string): Promise<GitStatus> {
    // 실제 git 처럼 세 스냅샷을 비교한다 — HEAD vs INDEX 가 staged, INDEX vs FILES 가 unstaged
    const changes: GitStatus['changes'] = [];
    const diff = (from: Record<string, string>, to: Record<string, string>, staged: boolean) => {
      for (const path of Object.keys(to)) {
        if (!(path in from)) changes.push({ path, kind: staged ? 'added' : 'untracked', staged });
        else if (to[path] !== from[path]) changes.push({ path, kind: 'modified', staged });
      }
      for (const path of Object.keys(from)) {
        if (!(path in to)) changes.push({ path, kind: 'deleted', staged });
      }
    };
    diff(HEAD, INDEX, true);
    diff(INDEX, FILES, false);
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return delay({ branch: 'main', head: `mock-${headSerial}`, dirty: changes.length > 0, changes });
  }

  gitOriginalContent(_repo: string, path: string): Promise<string> {
    return delay(HEAD[path] ?? '');
  }

  gitCommit(_repo: string, message: string): Promise<void> {
    HEAD = { ...INDEX };
    headSerial += 1;
    MOCK_LOG.unshift({ hash: `mock-${headSerial}`, subject: message, author: 'you', date: 'now' });
    return delay(undefined);
  }

  gitStage(_repo: string, paths: string[]): Promise<void> {
    for (const p of paths) {
      if (p in FILES) INDEX[p] = FILES[p];
      else delete INDEX[p];
    }
    return delay(undefined);
  }

  gitUnstage(_repo: string, paths: string[]): Promise<void> {
    for (const p of paths) {
      if (p in HEAD) INDEX[p] = HEAD[p];
      else delete INDEX[p];
    }
    return delay(undefined);
  }

  gitDiscard(_repo: string, paths: string[], untracked: string[]): Promise<void> {
    for (const p of paths) {
      if (p in INDEX) FILES[p] = INDEX[p];
      else delete FILES[p];
    }
    for (const p of untracked) delete FILES[p];
    return delay(undefined);
  }

  gitLog(_repo: string, limit: number): Promise<GitLogItem[]> {
    return delay(MOCK_LOG.slice(0, limit));
  }

  gitBranches(_repo: string): Promise<string[]> {
    return delay(['main', 'feature/mock']);
  }

  gitCheckout(_repo: string, _branch: string): Promise<void> {
    // ponytail: mock 의 브랜치 전환은 no-op — 목록(gitBranches)은 둘을 돌려주지만 파일 상태는 하나뿐
    return delay(undefined);
  }

  // ponytail: mock 에는 원격이 없다 — 동기화는 지연 후 no-op (askpass 통로도 없다)
  gitFetch(_repo: string): Promise<void> {
    return delay(undefined);
  }
  gitPull(_repo: string): Promise<void> {
    return delay(undefined);
  }
  gitPush(_repo: string): Promise<void> {
    return delay(undefined);
  }

  createTerminal(cols: number, rows: number): TerminalSession {
    return new MockPty(cols, rows);
  }
}

let nextMockPtyId = 1;

/** 아주 작은 가짜 셸 — 프롬프트/echo/몇 개 명령만. 터미널 UI 개발용. */
class MockPty implements TerminalSession {
  // mock 은 세션 유실이 없어 대조에 쓰일 일은 없다 — 계약 충족용 유일 식별자
  readonly id = nextMockPtyId++;
  private cb: ((data: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  /** exit 이후 — 프롬프트·입력 처리를 멈춘다 (죽은 셸) */
  private exited = false;
  private buf = '';
  /** buf 내 커서 위치 (0..buf.length) */
  private pos = 0;
  private history: string[] = [];
  /** -1 = 새 줄 편집 중, 그 외 = history 인덱스 */
  private histIdx = -1;
  /** 히스토리 탐색 진입 시점의 편집 중이던 줄 */
  private savedBuf = '';
  private cwd = '~/mock-workspace';
  /** 터미널 폭 — 줄바꿈된 입력의 커서 계산에 필요 (resize 로 갱신) */
  private cols: number;
  /** 청크 경계에서 잘린 미완결 ESC 시퀀스 조각 */
  private pendingEsc = '';

  constructor(cols: number, _rows: number) {
    this.cols = Math.max(2, cols);
    queueMicrotask(() => this.prompt());
  }

  private out(s: string) {
    this.cb?.(s);
  }

  private prompt() {
    this.out(`\x1b[01;32muser@superlite\x1b[00m:\x1b[01;34m${this.cwd}\x1b[00m$ `);
  }

  private run(cmd: string) {
    const [name, ...args] = cmd.trim().split(/\s+/);
    switch (name) {
      case '':
        break;
      case 'ls':
        this.out('NOTES.md  README.md  \x1b[01;34mdocs\x1b[0m  package.json  \x1b[01;34msrc\x1b[0m\r\n');
        break;
      case 'pwd':
        this.out('/home/user/mock-workspace\r\n');
        break;
      case 'echo':
        this.out(`${args.join(' ')}\r\n`);
        break;
      case 'clear':
        this.out('\x1b[2J\x1b[H');
        break;
      case 'exit':
        this.exited = true;
        // WHY: 마이크로태스크로 미뤄서 xterm onData 디스패치 중에 구독자가 xterm 을
        //      dispose 하는 재진입을 피한다 (생성자 prompt 와 같은 패턴)
        queueMicrotask(() => this.exitCb?.(Number(args[0]) || 0));
        break;
      default:
        this.out(`bash: ${name}: command not found\r\n`);
    }
  }

  // ── 라인 편집 (readline 근사) ──
  // WHY: xterm 은 Home/End/화살표를 이스케이프 시퀀스(\x1b[D 등)로 보낸다.
  //      파싱하지 않으면 ESC 만 버려지고 "[D" 가 입력으로 새어 들어간다.

  /** 프롬프트의 표시 길이 (ANSI 색 제외) — 커서 절대 위치 계산의 기준 */
  private promptLen(): number {
    return `user@superlite:${this.cwd}$ `.length;
  }

  /**
   * 커서를 buf 위치 fromP → toP 로 이동. 입력이 줄바꿈된 경우까지 처리한다.
   * WHY: CUB/CUF(\x1b[D/C)는 행 경계를 넘지 못한다 — 절대 행/열을 계산해
   *      행 이동(A/B) + \r + 열 이동(C)으로 움직여야 긴 명령에서 화면이 안 깨진다.
   *      (한 줄이 정확히 cols 에서 끝나는 pending-wrap 경계의 1행 오차는 허용)
   */
  private cursorMove(fromP: number, toP: number) {
    if (fromP === toP) return;
    const base = this.promptLen();
    const fromRow = Math.floor((base + fromP) / this.cols);
    const toRow = Math.floor((base + toP) / this.cols);
    const toCol = (base + toP) % this.cols;
    if (toRow < fromRow) this.out(`\x1b[${fromRow - toRow}A`);
    else if (toRow > fromRow) this.out(`\x1b[${toRow - fromRow}B`);
    this.out('\r');
    if (toCol > 0) this.out(`\x1b[${toCol}C`);
  }

  private insert(ch: string) {
    this.buf = this.buf.slice(0, this.pos) + ch + this.buf.slice(this.pos);
    const tail = this.buf.slice(this.pos);
    this.out(tail); // 출력 후 커서는 buf 끝
    this.pos += 1;
    this.cursorMove(this.buf.length, this.pos);
  }

  private backspace() {
    if (this.pos === 0) return;
    this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos);
    this.cursorMove(this.pos, this.pos - 1);
    this.pos -= 1;
    const tail = this.buf.slice(this.pos);
    this.out(`${tail} `); // 지워진 마지막 칸 덮기 — 커서는 len+1
    this.cursorMove(this.buf.length + 1, this.pos);
  }

  private deleteForward() {
    if (this.pos >= this.buf.length) return;
    this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1);
    const tail = this.buf.slice(this.pos);
    this.out(`${tail} `);
    this.cursorMove(this.buf.length + 1, this.pos);
  }

  /** 현재 입력 줄을 s 로 교체해 다시 그린다 (히스토리 탐색용) */
  private setLine(s: string) {
    this.cursorMove(this.pos, 0);
    // WHY: \x1b[K 는 현재 행만 지운다 — 여러 행에 걸친 입력은 화면 끝까지(\x1b[J) 지워야 한다
    this.out('\x1b[J');
    this.buf = s;
    this.pos = s.length;
    this.out(s);
  }

  /** 단어 시작으로 (Ctrl+Left) */
  private wordLeft(): number {
    let p = this.pos;
    while (p > 0 && this.buf[p - 1] === ' ') p -= 1;
    while (p > 0 && this.buf[p - 1] !== ' ') p -= 1;
    return p;
  }

  /** 다음 단어 끝으로 (Ctrl+Right) */
  private wordRight(): number {
    let p = this.pos;
    while (p < this.buf.length && this.buf[p] === ' ') p += 1;
    while (p < this.buf.length && this.buf[p] !== ' ') p += 1;
    return p;
  }

  private historyUp() {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.savedBuf = this.buf;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx -= 1;
    } else {
      return;
    }
    this.setLine(this.history[this.histIdx]);
  }

  private historyDown() {
    if (this.histIdx === -1) return;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx += 1;
      this.setLine(this.history[this.histIdx]);
    } else {
      this.histIdx = -1;
      this.setLine(this.savedBuf);
    }
  }

  private enter() {
    this.cursorMove(this.pos, this.buf.length); // 출력이 입력 끝 다음 줄에서 시작하도록
    this.out('\r\n');
    const cmd = this.buf;
    if (cmd.trim()) this.history.push(cmd);
    this.buf = '';
    this.pos = 0;
    this.histIdx = -1;
    this.run(cmd);
    if (!this.exited) this.prompt();
  }

  private interrupt() {
    this.cursorMove(this.pos, this.buf.length);
    this.out('^C\r\n');
    this.buf = '';
    this.pos = 0;
    this.histIdx = -1;
    this.prompt();
  }

  /**
   * ESC 시퀀스 파싱: 소비 길이와 액션 키를 돌려준다. 모르는 시퀀스는 조용히 소비.
   * 청크 끝에서 시퀀스가 잘리면 kind 'incomplete' (len 0) — 호출자가 나머지를 보관한다.
   */
  private parseEsc(data: string, i: number): { len: number; kind: string | null } {
    const next = data[i + 1];
    if (next === undefined) return { len: 0, kind: 'incomplete' };
    if (next === '[') {
      // CSI: \x1b[ <params> <final @-~>
      let j = i + 2;
      while (j < data.length && !(data[j] >= '@' && data[j] <= '~')) j += 1;
      if (j >= data.length) return { len: 0, kind: 'incomplete' };
      const params = data.slice(i + 2, j);
      const final = data[j];
      const len = j - i + 1;
      const ctrl = params.endsWith(';5');
      if (final === 'A') return { len, kind: 'up' };
      if (final === 'B') return { len, kind: 'down' };
      if (final === 'C') return { len, kind: ctrl ? 'word-right' : 'right' };
      if (final === 'D') return { len, kind: ctrl ? 'word-left' : 'left' };
      if (final === 'H') return { len, kind: 'home' };
      if (final === 'F') return { len, kind: 'end' };
      if (final === '~') {
        if (params === '1' || params === '7') return { len, kind: 'home' };
        if (params === '4' || params === '8') return { len, kind: 'end' };
        if (params === '3') return { len, kind: 'delete' };
      }
      return { len, kind: null };
    }
    if (next === 'O') {
      // SS3 (application 모드 Home/End/화살표)
      if (i + 2 >= data.length) return { len: 0, kind: 'incomplete' };
      const final = data[i + 2];
      const map: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
      return { len: 3, kind: map[final] ?? null };
    }
    return { len: 1, kind: null };
  }

  write(data: string): void {
    // WHY: 스트리밍 전송(실백엔드)에서는 ESC 시퀀스가 청크 경계에서 잘릴 수 있다 —
    //      잘린 조각을 보관했다가 다음 청크 앞에 붙여 "[D" 누수를 막는다.
    if (this.pendingEsc) {
      data = this.pendingEsc + data;
      this.pendingEsc = '';
    }
    let i = 0;
    let lastWasCR = false;
    while (i < data.length) {
      if (this.exited) return; // 같은 청크 뒤쪽 입력("exit\rls\r")이 죽은 셸에서 돌지 않게
      const ch = data[i];
      if (ch === '\x1b') {
        const { len, kind } = this.parseEsc(data, i);
        if (kind === 'incomplete') {
          this.pendingEsc = data.slice(i);
          return;
        }
        i += len;
        switch (kind) {
          case 'left':
            if (this.pos > 0) { this.cursorMove(this.pos, this.pos - 1); this.pos -= 1; }
            break;
          case 'right':
            if (this.pos < this.buf.length) { this.cursorMove(this.pos, this.pos + 1); this.pos += 1; }
            break;
          case 'word-left': {
            const p = this.wordLeft();
            this.cursorMove(this.pos, p);
            this.pos = p;
            break;
          }
          case 'word-right': {
            const p = this.wordRight();
            this.cursorMove(this.pos, p);
            this.pos = p;
            break;
          }
          case 'home':
            this.cursorMove(this.pos, 0);
            this.pos = 0;
            break;
          case 'end':
            this.cursorMove(this.pos, this.buf.length);
            this.pos = this.buf.length;
            break;
          case 'delete':
            this.deleteForward();
            break;
          case 'up':
            this.historyUp();
            break;
          case 'down':
            this.historyDown();
            break;
        }
        lastWasCR = false;
        continue;
      }
      i += 1;
      if (ch === '\r') {
        this.enter();
        lastWasCR = true;
        continue;
      }
      if (ch === '\n') {
        // Ctrl+J 단독은 제출, \r\n 페어의 \n 은 무시
        if (!lastWasCR) this.enter();
        lastWasCR = false;
        continue;
      }
      lastWasCR = false;
      if (ch === '\x7f') this.backspace();
      else if (ch === '\x03') this.interrupt();
      else if (ch === '\x0c') {
        // Ctrl+L: 화면 클리어 후 현재 입력 줄 유지
        this.out('\x1b[2J\x1b[H');
        this.prompt();
        this.out(this.buf);
        this.cursorMove(this.buf.length, this.pos);
      } else if (ch >= ' ') this.insert(ch);
    }
  }

  onData(cb: (data: string) => void): void {
    this.cb = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }

  resize(cols: number): void {
    this.cols = Math.max(2, cols);
  }

  dispose(): void {
    this.cb = null;
    this.exitCb = null;
  }
}
