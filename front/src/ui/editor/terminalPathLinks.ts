import type { IBufferLine, ILink, Terminal } from '@xterm/xterm';
import { detectLinks, type LinkOs, type ParsedLink } from './terminalLinkParsing';
import type { TerminalInstance } from '../../model/terminal';
import type { SessionCtx } from '../../model/session';
import { allSessionCtxs, rootOfBackend } from '../../model/sessions';
import { isAbsPath, toWorkspacePath } from '../../model/files';
import { showViewlet } from '../../model/workbench';

// 터미널 경로 링크 (ticket terminal-path-links) — 호버한 줄의 경로 후보(terminalLinkParsing)를 그 터미널의
// cwd(데몬 termCwd, 와이어 v21) 기준으로 절대 경로로 풀고 데몬 stat(dir:true) 으로 실존하는 것만 링크로
// 만든다. 조작은 URL 링크와 같다 — Ctrl 을 누른 동안만 밑줄, 커서 모양 불변, Ctrl+클릭 판정은 terminalHost 의 linkTerm 래퍼가 감싼다.
// 파일은 편집기(줄 이동 포함), 워크스페이스 안 디렉토리는 탐색기 reveal + 트리 포커스, 밖 디렉토리는 폴더 탭.
// 프롬프트 안의 경로(`user@host:~/proj$`)도 제외하지 않는다 (사용자 결정 2026-09-12 — 셸 통합 후속)

/** VS Code 상수: 한 줄 상한·후보 길이 상한·줄당 링크 상한 (원격 왕복 절약) */
const MAX_LINE_LENGTH = 2000;
const MAX_PATH_LENGTH = 1024;
const MAX_LINKS_PER_LINE = 10;
/** 줄 단위 결과 캐시 수명 — 같은 줄 위를 오가는 호버마다 stat 을 다시 하지 않는다 (VS Code 10초) */
const CACHE_TTL_MS = 10_000;

interface Resolved {
  parsed: ParsedLink;
  /** 데몬에 묻는 절대 경로 ('/' 구분 — 프론트 경로 규약) */
  abs: string;
}

/** 논리 줄 — 줄바꿈(isWrapped)으로 이어진 버퍼 행들을 이은 텍스트와, 텍스트 오프셋 → 버퍼 셀 대응 */
interface LogicalLine {
  text: string;
  /** text[i] 가 놓인 (x 0 기반, y 버퍼 행) */
  cells: { x: number; y: number }[];
}

function logicalLine(term: Terminal, y: number): LogicalLine | null {
  const buf = term.buffer.active;
  let start = y;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let end = y;
  while (end + 1 < buf.length && buf.getLine(end + 1)?.isWrapped) end++;
  let text = '';
  const cells: { x: number; y: number }[] = [];
  for (let row = start; row <= end; row++) {
    const line: IBufferLine | undefined = buf.getLine(row);
    if (!line) return null;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // 넓은 글자의 오른쪽 반 칸
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let k = 0; k < chars.length; k++) cells.push({ x, y: row });
    }
    if (text.length > MAX_LINE_LENGTH) return null;
  }
  return { text, cells };
}

function osOf(root: string | null): LinkOs {
  return root !== null && /^[a-zA-Z]:/.test(root) ? 'windows' : 'unix';
}

/** `a/../b`, `./c` 정리 — 앞의 `..` 는 루트에서 더 못 올라간다 */
function normalize(abs: string): string {
  const drive = abs.match(/^[a-zA-Z]:/)?.[0] ?? '';
  const parts: string[] = [];
  for (const seg of abs.slice(drive.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `${drive}/${parts.join('/')}`;
}

/** 후보 텍스트 → 절대 경로. cwd·home 은 데몬 답 (null 이면 상대·`~` 후보는 버린다) */
function resolve(path: string, os: LinkOs, cwd: string | null, home: string | null): string | null {
  let p = path;
  if (p.startsWith('file:///')) p = os === 'windows' ? p.slice(8) : p.slice(7);
  else if (p.startsWith('file://')) p = p.slice(7);
  if (os === 'windows') p = p.replace(/\\/g, '/');
  if (p === '~' || p.startsWith('~/')) {
    if (home === null) return null;
    return normalize(home.replace(/\\/g, '/') + p.slice(1));
  }
  if (isAbsPath(p)) return normalize(p);
  if (cwd === null) return null;
  return normalize(`${cwd.replace(/\\/g, '/')}/${p}`);
}

/** 후보 변형 — 원문, 그리고 끝에 붙은 `]"'.` 와 프롬프트 종결 문자(`$ # % >`)를 하나씩 벗긴 것 (VS Code
 *  specialEndCharRegex 에 프롬프트 문자를 더했다 — `user@host:~/proj$` 의 `~/proj$` 가 `~/proj` 로 풀린다) */
function variants(parsed: ParsedLink): ParsedLink[] {
  const out = [parsed];
  if (parsed.row !== undefined) return out; // 접미가 있으면 경로 끝은 접미 앞에서 이미 확정됐다
  let path = parsed.path;
  while (/[\]"'.$#%>]$/.test(path)) {
    path = path.slice(0, -1);
    if (path.length === 0) break;
    out.push({ ...parsed, text: path, path });
  }
  return out;
}

const ctxOf = (inst: TerminalInstance): SessionCtx | null =>
  allSessionCtxs().find((c) => c.terminals.terminals.list.some((t) => t.id === inst.id)) ?? null;

async function open(ctx: SessionCtx, root: string, abs: string, kind: 'file' | 'directory', row?: number): Promise<void> {
  const wire = toWorkspacePath(abs, root);
  if (kind === 'file') {
    if (row !== undefined) await ctx.editors.openFileAt(wire, row);
    else await ctx.editors.openFile(wire);
    return;
  }
  // 워크스페이스 안 디렉토리는 탐색기에 드러내고 트리에 포커스 (SCM Reveal in Explorer 와 같은 순서 + 포커스)
  if (!isAbsPath(wire)) {
    showViewlet('explorer');
    await ctx.files.revealPath(wire);
    ctx.files.files.pendingFocus = true;
    return;
  }
  ctx.editors.openFolderTab(abs);
}

export function registerPathLinks(linkTerm: Terminal, term: Terminal, inst: TerminalInstance): void {
  // 줄 텍스트 키 캐시 — 같은 텍스트면 stat 결과를 재사용한다 (다른 줄이라도 같은 내용이면 같은 결과)
  const cache = new Map<string, Promise<ILink[]>>();
  let cacheTimer: ReturnType<typeof setTimeout> | null = null;
  const remember = (key: string, p: Promise<ILink[]>): Promise<ILink[]> => {
    cache.set(key, p);
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => cache.clear(), CACHE_TTL_MS);
    return p;
  };

  async function linksFor(y: number, line: LogicalLine): Promise<ILink[]> {
    const ctx = ctxOf(inst);
    const root = ctx ? rootOfBackend(ctx.backend) : null;
    if (!ctx || root === null) return [];
    const os = osOf(root);
    const parsed = detectLinks(line.text, os).filter((p) => p.path.length <= MAX_PATH_LENGTH);
    if (parsed.length === 0) return [];
    // 상대·`~` 후보가 있을 때만 cwd 를 묻는다 (호버한 줄마다 한 번, 실측 약 1.5ms + 왕복)
    const needCwd = parsed.some((p) => !isAbsPath(p.path.replace(/\\/g, '/')) && !p.path.startsWith('file:'));
    const info = needCwd ? await ctx.backend.termCwd?.(inst.session.id).catch(() => null) ?? null : null;
    const cwd = info?.cwd ?? null;
    const home = info?.home ?? null;
    const links: ILink[] = [];
    for (const p of parsed) {
      if (links.length >= MAX_LINKS_PER_LINE) break;
      let hit: { r: Resolved; kind: 'file' | 'directory' } | null = null;
      for (const v of variants(p)) {
        const abs = resolve(v.path, os, cwd, home);
        if (abs === null) continue;
        const st = await ctx.backend.stat(abs, { dir: true }).catch(() => null);
        if (!st) continue;
        hit = { r: { parsed: v, abs }, kind: st.kind ?? 'file' };
        break;
      }
      if (!hit) continue;
      const { r, kind } = hit;
      const startCell = line.cells[r.parsed.index];
      const endCell = line.cells[r.parsed.index + r.parsed.text.length - 1];
      if (!startCell || !endCell) continue;
      // xterm 범위는 1 기반, end 는 마지막 셀 포함
      links.push({
        range: { start: { x: startCell.x + 1, y: startCell.y + 1 }, end: { x: endCell.x + 1, y: endCell.y + 1 } },
        text: r.parsed.text,
        activate: (e) => {
          // WHY: 다음 매크로태스크로 미룬다 — activate 는 xterm 의 mouseup 처리 중에 불리는데, 폴더 탭 열기가
          //      동기라 그 자리에서 터미널 뷰가 숨으면 xterm 이 이어서 계산하는 마우스 보고 좌표가 NaN 이 되어
          //      셸에 `NaNm` 쓰레기가 들어간다 (2026-09-12 스모크 실측: "bash: NaN: command not found")
          if (e.ctrlKey || e.metaKey) setTimeout(() => void open(ctx, root, r.abs, kind, r.parsed.row), 0);
        },
      });
    }
    // 호버한 행에 걸린 링크만 — 논리 줄이 여러 행이면 xterm 이 행마다 다시 묻는다
    return links.filter((l) => l.range.start.y <= y + 1 && y + 1 <= l.range.end.y);
  }

  linkTerm.registerLinkProvider({
    provideLinks: (bufferLineNumber, cb) => {
      const y = bufferLineNumber - 1;
      const line = logicalLine(term, y);
      if (!line || line.text.trim() === '') return cb(undefined);
      const key = `${y}:${line.text}`;
      const p = cache.get(key) ?? remember(key, linksFor(y, line));
      void p.then((links) => cb(links.length ? links : undefined), () => cb(undefined));
    },
  });
}
