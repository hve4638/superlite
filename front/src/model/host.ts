import { EmptyBackend } from '../backend/empty';
import { MockBackend } from '../backend/mock';
import { WsBackend } from '../backend/ws';
import type { AgentInfo, ThinBackend } from '../backend/types';
import { boot } from './boot';
import { ctx, viewOf } from './ctx';
import { daemonClean } from './daemon';
import { requestDownload } from './downloads';
import { credential, type CredentialRequest } from './gitauth';
import { errText, notify } from './notifications';
import { configureNvim } from './nvim';
import type { SessionCtx } from './session';
import { tauri } from './tauri';
import {
  activateSession,
  activeSessionCtx,
  activeSessionEmpty,
  bootSession,
  cancelBackground,
  configureSessions,
  genSessionId,
  openInBackground,
  openWebFolder,
  reconnectSession,
  remoteHost,
  replaceAppSession,
  rootOfBackend,
  type OpenMode,
  sessions,
  type SessionTab,
} from './sessions';
import { bootActiveSession, subWindow } from './window';

// WHY: 백엔드 구현체 선택이 일어나는 유일한 지점 (itir boundary assembly) — 세션 관리자에
//      환경(kind·연결 생성기)을 주입하고 부팅 세션들을 등록한다.
//      웹 기본은 백엔드 /ws (같은 오리진 — 개발은 vite 프록시, 프론트는 데몬 주소를 모른다).
//      ?mock 일 때만 MockBackend — 예전 기본값(?ws 필수)은 differential 검사용이었는데
//      그 검사가 사라져 2026-09-08 뒤집었다 (ticket web-default-real-backend).
const params = new URLSearchParams(location.search);
// 페이지 URL 의 ?tkn= 을 /ws 로 넘긴다 — 백엔드가 SUPERLITE_TOKEN 으로 떠 있으면 필수.
const tkn = params.get('tkn');
/** 웹 실백엔드 모드 — ?mock 이 없으면 같은 오리진 /ws 에 붙는다 (?ws 는 이제 무해한 잉여) */
const webBackend = !params.has('mock');
// Tauri 앱은 자산 로드라 location 이 relay 가 아니다 — native 부팅 정보(boot_info)의 endpoint 가 최우선.
// 세션 목록도 함께 온다 — native 레지스트리가 발급한 id 만 relay 가 허용한다
const injected = boot?.ws;
const injectedSessions: SessionTab[] | undefined = boot?.sessions;

/** 'Open Folder' 경로 퀵인풋의 시작 경로 (열린 워크스페이스가 없는 빈 세션에서 쓴다).
 *  native 가 OS 에 맞게 준다 — Windows 는 드라이브 루트(예: 'C:/'), 그 외 '/'.
 *  부팅 정보가 없으면(웹) '/' — 웹은 보통 부팅 세션 root 에서 시작해 이 값을 안 쓴다. */
export const openRootDefault: string = boot?.openRoot ?? '/';

/** 웹 /ws 주소 — 세션(탭)마다 ?folder= 로 root 를 지정한다 (빈 root 는 서버 기본 root) */
function webWsUrl(folder: string): string {
  const q = new URLSearchParams();
  if (tkn !== null) q.set('tkn', tkn);
  if (folder !== '') q.set('folder', folder);
  const qs = q.toString();
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${qs ? `?${qs}` : ''}`;
}

// 빈 세션(root null)은 연결을 열지 않는다 — 앱·웹 공통 (레지스트리에 root 가 없어
// relay 도 거부한다. 폴더를 열면 세션째로 교체되므로 재연결이 아니라 새 연결이다)
const backendOf = (t: { id: string; root: string | null }): ThinBackend =>
  t.root === null ? new EmptyBackend() : new WsBackend(webWsUrl(t.root), t.id);

if (injected) {
  // 서브 창은 미러 세션 id 로 붙는다 (데몬은 같은 id 의 두 연결을 허용하지 않는다). 미러가 아직 없는
  // 세션은 무연결 자리표시 — 탭이 오면 native ensure_mirror 로 미러가 생기고 컨텍스트가 교체된다
  const appBackendOf = (t: { id: string; root: string | null; mirror?: string }): ThinBackend =>
    t.root === null || (subWindow && !t.mirror) ? new EmptyBackend() : new WsBackend(injected, t.mirror ?? t.id);
  configureSessions({ kind: 'app', backendFor: appBackendOf, onRequest: handleRequest });
  // 임베드 nvim (편집기 vim 모드) — relay 의 /nvim, /ws 와 같은 주소·토큰
  configureNvim(injected.replace(/\/ws(\?|$)/, '/nvim$1'));
  // 부팅 세션들 — native 부팅 정보의 목록 (복원이면 여럿). 마지막 탭이 활성이 되고, 묶음의
  // 활성 세션이 있으면(서브 창·새로고침) 그 탭으로
  for (const t of injectedSessions ?? []) bootSession(t, appBackendOf(t));
  if (bootActiveSession !== null) activateSession(bootActiveSession, false);
} else if (webBackend) {
  configureSessions({ kind: 'web', backendFor: backendOf, onRequest: handleRequest });
  configureNvim(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/nvim${tkn !== null ? `?tkn=${tkn}` : ''}`);
  const folder = params.get('folder') ?? '';
  const id = genSessionId();
  const name = folder.split('/').filter((s) => s !== '').pop() ?? '';
  bootSession({ id, name, root: folder }, new WsBackend(webWsUrl(folder), id));
} else {
  configureSessions({ kind: 'mock', backendFor: () => new MockBackend() });
  configureNvim(null); // mock 은 relay 가 없다 — vim 모드 없음
  bootSession({ id: 'mock', name: '', root: '' }, new MockBackend());
}

/**
 * 데몬 소켓 요청자(셸 심 `superlite <동사> [인자…]`, backend/cli — ticket cli-control-discussion,
 * 데몬 credential helper 모드)가 세션에 보낸 요청의 처리 (와이어 v9). 심은 동사를 해석하지
 * 않고 params 에 {args: 나머지 인자, cwd: 셸의 작업 폴더} 를 실어 보낸다 — 동사의 이름·인자·
 * 확인 여부는 전부 여기서 정한다. 내장 동사: notify(알림)·open(경로 열기: 파일은 그 세션 편집기,
 * 폴더는 폴더 열기)·download(Download 뷰 대기열에 넣고 바로 'queued' — `--wait` 면 사용자 확인·전송이
 * 끝나야 돌아간다)·credential(git helper 중계)·agent register|list|whoami(에이전트 등록부 — agentVerb).
 * 새 내장 동사는 case 를 더한다; 플러그인이 동사를 등록하는 방식은 ticket plugin-architecture 의 결정을 따른다. 결과는 요청자에게 돌아가고
 * throw 는 에러로 돌아간다. 요청이 온 세션 탭으로 전환한다 (VS Code 가 요청한 창을 앞으로
 * 가져오는 것과 같은 의미 — OS 수준 창 포커스는 없음). 상대 경로는 cwd 기준 (에이전트는
 * `superlite open src/a.ts` 처럼 친다)
 */
async function handleRequest(
  tab: SessionTab,
  ctx: SessionCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'notify': {
      const sev = p.severity === 'error' || p.severity === 'warning' ? p.severity : 'info';
      notify(sev, String(p.message ?? ''));
      return null;
    }
    case 'open': {
      const abs = argPath(p);
      if (!abs) throw new Error('경로 필요: superlite open <경로>');
      const { full, wire } = requestPath(ctx.workbench.workbench.rootPath, abs);
      // 파일인가 — stat 은 정규 파일만 성공한다. 아니면 폴더 나열(browseDir, 절대 경로)로
      // 확인, 그것도 실패하면 그 에러(경로 부재 등)가 요청자에게 돌아간다
      const isFile = await ctx.backend.stat(wire).then(() => true, () => false);
      if (!isFile) {
        if (!ctx.backend.browseDir) throw new Error('폴더 열기 미지원');
        await ctx.backend.browseDir(full);
      }
      activateSession(tab.id);
      if (isFile) {
        if (!(await ctx.editors.openFile(wire))) throw new Error(`열 수 없다: ${abs}`);
        return { kind: 'file' };
      }
      openFolder(full); // 활성 세션 기준 원격 판정 — 방금 전환했으므로 이 세션의 호스트다
      return { kind: 'folder' };
    }
    // download [--wait]: 기본은 Download 뷰 대기열에 넣고 바로 돌아온다 (에이전트가 막히지 않는다 — 사용자
    // 결정 2026-09-12). --wait 면 사용자의 확인·전송이 끝나야 돌아오고 취소·실패는 에러
    // 경로는 여럿 가능 (`superlite download a b c`, 글로브는 셸이 펼친다) — 경로마다 대기열 항목 하나
    case 'download': {
      const paths = argPaths(p);
      if (paths.length === 0) throw new Error('경로 필요: superlite download <경로…> [--wait]');
      activateSession(tab.id);
      const jobs: Promise<void>[] = [];
      for (const abs of paths) {
        const { wire } = requestPath(ctx.workbench.workbench.rootPath, abs);
        // 정규 파일이면 file, 아니면 폴더로 본다 — 부재는 전송 단계에서 에러로 돌아간다
        const isFile = await ctx.backend.stat(wire).then(() => true, () => false);
        jobs.push(requestDownload(ctx.backend, tab.name, wire, isFile ? 'file' : 'directory'));
      }
      if (argFlags(p).has('--wait')) {
        await Promise.all(jobs); // 하나라도 취소·실패면 에러
        return null;
      }
      for (const j of jobs) j.catch(() => {}); // 결과는 뷰가 보여 준다 — 요청자는 이미 떠났다
      return paths.length === 1 ? 'queued' : `queued ${paths.length}`;
    }
    // git credential helper 중계 (와이어 v18 — 데몬이 띄운 git 과 터미널 git 모두): get 은 {username,
    // password} 또는 null, store/erase 는 null
    case 'credential':
      return credential(p as unknown as CredentialRequest);
    case 'agent':
      return agentVerb(ctx, p);
    case 'card':
      return cardVerb(ctx, p);
    default:
      throw new Error(`미지 요청: ${method}`);
  }
}

const AGENT_USAGE =
  'Usage: superlite agent register <name> [--role <role>] [--lane <lane>] [--parent <name|$id>] | list | whoami';

/**
 * 에이전트 등록부 동사 (ticket superlite-agent-registry, 와이어 v23). 등록 단위는 요청자의 tmux 세션 id —
 * 데몬이 request params 에 동봉한 tmux. 저장은 데몬의 tmux 세션 환경변수라 세션과 함께 사라진다 (사용자 결정
 * 2026-09-13). 이름은 중복될 수 있어 표시는 늘 `이름 ($id)` 이고, --parent 는 이름 또는 `$id` — 이름이 둘 이상에
 * 맞으면 에러로 `$id` 지목을 요구한다. list 는 서버 전체(모든 워크트리), whoami 는 자기 세션의 등록 한 줄.
 * plain·Windows 터미널(tmux 없음)은 register·whoami 가 에러 — 등록 단위가 없다. 하위 워커 자동 등록
 * (superlite-card-control)은 같은 registerAgent 를 새 세션의 id 와 요청자의 id(parent)로 부르면 된다
 */
async function agentVerb(ctx: SessionCtx, p: Record<string, unknown>): Promise<unknown> {
  const { positional, opts } = argOpts(p);
  const sub = positional[0];
  const be = ctx.backend;
  if (!be.listAgents || !be.registerAgent) throw new Error('이 세션의 백엔드는 에이전트 등록을 지원하지 않는다');
  const me = typeof p.tmux === 'string' ? p.tmux : null;
  switch (sub) {
    case 'list': {
      const list = await be.listAgents();
      return list.length === 0 ? '(등록된 에이전트 없음)' : list.map((a) => agentLine(a, list)).join('\n');
    }
    case 'whoami': {
      if (me === null) throw new Error('tmux 세션 밖 — 등록 단위가 tmux 세션이라 plain·Windows 터미널에서는 쓸 수 없다');
      const list = await be.listAgents();
      const self = list.find((a) => a.id === me);
      if (!self) throw new Error(`미등록 (tmux 세션 ${me}) — superlite agent register <이름> 으로 등록한다`);
      return agentLine(self, list);
    }
    case 'register': {
      const name = positional[1];
      if (!name) throw new Error(AGENT_USAGE);
      if (me === null) throw new Error('tmux 세션 밖 — 등록 단위가 tmux 세션이라 plain·Windows 터미널에서는 쓸 수 없다');
      let parent: string | undefined;
      if (opts.parent !== undefined) {
        parent = resolveAgent(await be.listAgents(), opts.parent).id;
        if (parent === me) throw new Error('자기 자신을 parent 로 둘 수 없다');
      }
      await be.registerAgent({ id: me, name, role: opts.role, lane: opts.lane, parent });
      return `registered ${name} (${me})`;
    }
    default:
      throw new Error(AGENT_USAGE);
  }
}

// 한 줄에 다 넣으면 좁은 터미널에서 접혀 읽을 수 없다 (사용자 지적 2026-09-14) — 하위 동사마다 한 줄, 문구는 영어
const CARD_USAGE = [
  'Usage:',
  '  superlite card new [--cwd <dir>] [--name <name>] [--role <role>] [--lane <lane>] [-- <command...>]',
  '  superlite card read <$id|name> [--lines N]',
  '  superlite card send <$id|name> [--no-enter] -- <text...>',
  '  superlite card close <$id|name...>',
  '  superlite card close --cwd <dir>',
].join('\n');

/**
 * 카드 제어 동사 (ticket superlite-card-control, 와이어 v25). 카드의 식별자는 tmux 세션 id(`$N`, 등록부와 같은 단위) —
 * 대상은 늘 명시한다 ("활성 터미널" 같은 암묵 대상 없음). new 는 요청자 터미널이 앉은 탭의 카드로 새 셸을 띄우고(cwd 는
 * --cwd, 없으면 요청자 셸의 cwd), 새 세션 id 로 registerAgent(parent = 요청자, lane 은 요청자 것 상속, role 기본
 * worker)한 뒤 `--` 뒤의 인자를 셸 인용해 한 줄로 넣는다 — 옛 wtree post-create 훅의 tmux new-window + send-keys
 * 와 같은 동작. 뒤에서 만든다 — 요청자 탭이 보던 카드를 되돌려 화면을 빼앗지 않는다 (훅의 -d 와 같다). 출력은 `$N`.
 * read 는 화면(기본)·스크롤백(--lines N), send 는 글자 그대로 + Enter(--no-enter 면 생략), close 는 즉시 종료가 아니라
 * 닫기 요청(terminals.requestClose — [D] 표시 + 사용자가 그 카드로 가면 닫기/유지 확인, 사용자 결정 2026-09-13).
 * close --cwd <폴더> 는 그 폴더(사라진 워크트리)에 앉은 이 워크스페이스의 카드 전부 — post-destroy 훅이 쓴다
 */
async function cardVerb(ctx: SessionCtx, p: Record<string, unknown>): Promise<unknown> {
  const be = ctx.backend;
  if (!be.listTerminals || !be.captureTerminal || !be.sendTerminal || !be.listAgents || !be.registerAgent) {
    throw new Error('이 세션의 백엔드는 카드 제어를 지원하지 않는다');
  }
  const rawArgs = (Array.isArray(p.args) ? p.args : []).filter((a): a is string => typeof a === 'string');
  const dash = rawArgs.indexOf('--');
  const head = dash === -1 ? rawArgs : rawArgs.slice(0, dash);
  const tail = dash === -1 ? [] : rawArgs.slice(dash + 1);
  const { positional, opts } = argOpts({ args: head });
  const sub = positional[0];
  const me = typeof p.tmux === 'string' ? p.tmux : null;
  const cwd = typeof p.cwd === 'string' ? p.cwd : '';
  switch (sub) {
    case 'new': {
      if (me === null) throw new Error('tmux 세션 밖 — 카드 단위가 tmux 세션이라 plain·Windows 터미널에서는 쓸 수 없다');
      const dir = opts.cwd !== undefined ? resolveAgainst(cwd, opts.cwd) : cwd;
      const mine = ctx.terminals.terminals.list.find((t) => t.tmux?.id === me);
      const place = mine ? ctx.terminals.hostTabFor(mine.id) : null;
      const inst = ctx.terminals.createTerminal(place ? { host: place.tabId, groupId: place.groupId } : undefined, { cwd: dir });
      // 뒤에서 — 요청자 탭이 보던 카드(또는 탭 자신)를 되돌린다
      if (place) ctx.editors.setActiveCard(place.groupId, place.tabId, place.activeCard);
      const created = await inst.ready;
      if (opts.name !== undefined) await ctx.terminals.renameListed(created.id, opts.name);
      const agents = await be.listAgents();
      const parent = agents.find((a) => a.id === me);
      await be.registerAgent({ id: created.id, name: opts.name ?? created.name, role: opts.role ?? 'worker', lane: opts.lane ?? parent?.lane ?? undefined, parent: me });
      if (tail.length > 0) await be.sendTerminal(created.id, tail.map(shellQuote).join(' '), true);
      return created.id;
    }
    case 'read': {
      const target = positional[1];
      if (!target) throw new Error(CARD_USAGE);
      const id = await resolveCard(ctx, target);
      const lines = opts.lines !== undefined ? Number(opts.lines) : undefined;
      if (lines !== undefined && !(lines > 0)) throw new Error('--lines 는 양의 정수');
      return await be.captureTerminal(id, lines);
    }
    case 'send': {
      const target = positional[1];
      if (!target) throw new Error(CARD_USAGE);
      const id = await resolveCard(ctx, target);
      const text = (tail.length > 0 ? tail : positional.slice(2)).join(' ');
      await be.sendTerminal(id, text, opts['no-enter'] === undefined);
      return null;
    }
    case 'close': {
      let ids: string[];
      if (opts.cwd !== undefined) {
        const dead = resolveAgainst(cwd, opts.cwd);
        const list = await be.listTerminals();
        ids = list.filter((t) => onDeadPath(t.cwd, dead)).map((t) => t.id);
        if (ids.length === 0) return `(그 폴더에 앉은 카드 없음: ${dead})`;
      } else {
        if (positional.length < 2) throw new Error(CARD_USAGE);
        ids = await Promise.all(positional.slice(1).map((t) => resolveCard(ctx, t)));
      }
      const reason = opts.cwd !== undefined ? `워크트리가 삭제되었습니다: ${opts.cwd}` : '에이전트가 닫기를 요청했습니다';
      for (const id of ids) await ctx.terminals.requestClose(id, reason);
      return ids.map((id) => `close requested ${id}`).join('\n');
    }
    default:
      throw new Error(CARD_USAGE);
  }
}

/** 카드 대상 — `$id`(맨 숫자도 id — 셸이 `$154` 를 `$1`+`54` 로 펼치므로 따옴표 없이 `154` 로 칠 수 있게), 아니면 등록
 *  이름(resolveAgent — 모호하면 에러), 그것도 없으면 tmux 세션 이름 (서버 전체) */
async function resolveCard(ctx: SessionCtx, ref: string): Promise<string> {
  const be = ctx.backend;
  const list = await be.listTerminals!(true);
  if (ref.startsWith('$') || /^\d+$/.test(ref)) {
    const id = ref.startsWith('$') ? ref : `$${ref}`;
    if (!list.some((t) => t.id === id)) throw new Error(`없는 카드: ${id}`);
    return id;
  }
  const agents = await be.listAgents!();
  if (agents.some((a) => a.name === ref)) return resolveAgent(agents, ref).id;
  const byName = list.filter((t) => t.name === ref);
  if (byName.length === 1) return byName[0].id;
  if (byName.length === 0) throw new Error(`없는 카드: ${ref}`);
  throw new Error(`모호한 이름 ${ref}: ${byName.map((t) => t.id).join(', ')} — $id 로 지목한다`);
}

/** wtree post-destroy 훅의 on_dead_path 와 같은 규칙 — 그 경로 자체·하위, 삭제된 cwd 의 ' (deleted)' 접미 */
function onDeadPath(cwd: string, dead: string): boolean {
  const base = cwd.endsWith(' (deleted)') ? cwd.slice(0, -' (deleted)'.length) : cwd;
  return base === dead || base.startsWith(`${dead}/`);
}

/** 상대 경로를 요청자 cwd 기준으로 (Windows 드라이브 경로 포함) */
function resolveAgainst(cwd: string, p: string): string {
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return `${cwd.replace(/\/$/, '')}/${p}`;
}

/** 초기 명령 인자 하나를 대화형 셸이 같은 argv 로 되읽게 인용 — 안전 문자만이면 그대로, 아니면 작은따옴표
 *  (내부 ' 는 '\'' — 옛 post-create 훅과 같은 규칙) */
function shellQuote(a: string): string {
  return /^[A-Za-z0-9_\-./=:@%+,]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

/** 등록 한 줄 — `이름 ($id)` 뒤에 있는 필드만 `key=값`, parent 는 목록에서 이름을 찾아 `이름 ($id)` */
function agentLine(a: AgentInfo, all: AgentInfo[]): string {
  const cols = [`${a.name} (${a.id})`];
  if (a.role) cols.push(`role=${a.role}`);
  if (a.lane) cols.push(`lane=${a.lane}`);
  if (a.parent) {
    const pa = all.find((x) => x.id === a.parent);
    cols.push(`parent=${pa ? `${pa.name} (${pa.id})` : a.parent}`);
  }
  cols.push(`session=${a.session}`);
  if (a.root) cols.push(`root=${a.root}`);
  return cols.join('  ');
}

/** 이름 또는 `$id` 로 에이전트 하나를 고른다 — 없으면 에러, 이름이 여럿에 맞으면 후보를 나열하며 `$id` 지목을 요구 */
function resolveAgent(list: AgentInfo[], ref: string): AgentInfo {
  if (ref.startsWith('$')) {
    const hit = list.find((a) => a.id === ref);
    if (!hit) throw new Error(`없는 에이전트: ${ref}`);
    return hit;
  }
  const hits = list.filter((a) => a.name === ref);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`없는 에이전트: ${ref}`);
  throw new Error(`모호한 이름 ${ref}: ${hits.map((a) => `${a.name} (${a.id})`).join(', ')} — $id 로 지목한다`);
}

/** 심 params 의 args 를 위치 인자와 `--키 값` 옵션으로 나눈다 (값 없는 `--키` 는 'true') */
function argOpts(p: Record<string, unknown>): { positional: string[]; opts: Record<string, string> } {
  const args = (Array.isArray(p.args) ? p.args : []).filter((a): a is string => typeof a === 'string');
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[a.slice(2)] = next;
      i++;
    } else opts[a.slice(2)] = 'true';
  }
  return { positional, opts };
}

/** 심 params 의 `--플래그` 인자 집합 */
function argFlags(p: Record<string, unknown>): Set<string> {
  return new Set((Array.isArray(p.args) ? p.args : []).filter((a): a is string => typeof a === 'string' && a.startsWith('--')));
}

/** 심 params 의 경로 인자들 — `--플래그` 를 뺀 args (종전 path 도 받는다). 상대 경로는 cwd 로 절대화 */
function argPaths(p: Record<string, unknown>): string[] {
  const positional = (Array.isArray(p.args) ? p.args : []).filter((a): a is string => typeof a === 'string' && !a.startsWith('--'));
  const raws = typeof p.path === 'string' ? [p.path] : positional;
  const cwd = typeof p.cwd === 'string' ? p.cwd.replace(/[\\/]+$/, '') : '';
  return raws
    .filter((r) => r !== '')
    .map((raw) => (/^([a-zA-Z]:|\/)/.test(raw) || cwd === '' ? raw : `${cwd}/${raw}`));
}

/** 첫 경로 인자 (open 등 단일 경로 동사) — 없으면 '' */
function argPath(p: Record<string, unknown>): string {
  return argPaths(p)[0] ?? '';
}

/** 요청자가 준 절대 경로 → full('/' 구분 절대 경로 — 폴더 열기·browseDir 용)과 wire(파일
 *  단건 RPC 용 — 루트 안이면 상대화, 밖이면 절대 경로 그대로. readFile/stat 은 절대 경로
 *  허용 — OS 드롭과 같은 규칙). 드라이브 경로(Windows)만 '\\' 를 '/' 로 — unix 는 '\\' 가
 *  파일명 문자다 */
function requestPath(rootPath: string, abs: string): { full: string; wire: string } {
  const win = /^[a-zA-Z]:/.test(abs);
  const full = win ? abs.replaceAll('\\', '/') : abs;
  const root = (win ? rootPath.replaceAll('\\', '/') : rootPath).replace(/\/+$/, '');
  const inRoot =
    root !== '' &&
    (win ? full.toLowerCase().startsWith(`${root.toLowerCase()}/`) : full.startsWith(`${root}/`));
  return { full, wire: inRoot ? full.slice(root.length + 1) : full };
}

/** 활성 세션의 백엔드 — 종전 싱글턴 이름 유지 (monaco·QuickInput·commands 가 쓴다) */
export const backend: ThinBackend = viewOf(() => ctx().backend);

/** 활성 탭이 빈 세션이면 그 id — 폴더 열기가 새 탭 대신 그 자리를 교체하게 하는 인자 */
function replaceTarget(): string | undefined {
  return activeSessionEmpty() ? sessions.activeId : undefined;
}

/**
 * 백엔드 자체 HTTP API(/ssh/*) 주소 — 데몬 와이어(/ws) 밖에서 백엔드가 직접 응답하는
 * 첫 표면이다 (주소·연결은 백엔드 소유 — ws docs/decision/remote-ssh.md). 웹은 같은
 * 오리진 상대 경로, 앱은 주입된 WS endpoint 에서 오리진·토큰을 유도한다.
 * mock 은 null — 호출측(원격 탐색기)이 UI 를 감추는 신호다.
 */
export function backendApiUrl(path: string, query: Record<string, string> = {}): string | null {
  const q = new URLSearchParams(query);
  if (injected) {
    const u = new URL(injected.replace(/^ws/, 'http'));
    const t = u.searchParams.get('tkn');
    if (t !== null) q.set('tkn', t);
    const qs = q.toString();
    return `${u.origin}${path}${qs ? `?${qs}` : ''}`;
  }
  if (!webBackend) return null;
  if (tkn !== null) q.set('tkn', tkn);
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}

/**
 * '폴더 열기' 확정의 단일 진입점 — 환경 분기가 여기 숨어 퀵인풋·원격 탐색기는 환경을
 * 모른다. 앱·웹 모두 "새 세션 탭 추가"이되, 활성 탭이 빈 세션이면 그 자리를 교체한다 (시작
 * 페이지에서 열기 흐름). 앱은 native 커맨드 open_folder_path invoke (검증·세션 등록은
 * native 소유 — sessions-changed 반향으로 탭이 생긴다), 웹은 front 세션 관리자가
 * ?folder= 연결을 하나 더 연다. mock 은 무동작.
 * opts.mode: 'replace' 는 활성 탭이 비어 있지 않아도 대체한다 (VS Code 원격의 "현재 창에
 * 연결" — 웹은 openWebFolder replace, 앱은 invoke 후 replaceAppSession). 'new' 는 활성 탭이
 * 빈 세션이어도 남기고 새 탭을 배경에 더한다 — 현재 탭이 활성으로 남는다 (원격 탐색기의
 * "새 탭에 연결", 2026-09-05). 생략은 기본 — 활성 빈 탭만 제자리 교체. */
export function openFolder(root: string, opts: { mode?: OpenMode } = {}): void {
  // 원격 세션 안의 '폴더 열기' — 퀵인풋의 browseDir 는 원격 데몬을 탐색하므로 확정된
  // 절대 경로는 그 호스트의 경로다 (VS Code 원격 창의 Open Folder 와 동일). 세션 root 표기
  // (ssh://host/path)로 되돌려 relay 가 원격으로 해석하게 한다
  const active = sessions.list.find((t) => t.id === sessions.activeId);
  const host = active?.root ? remoteHost(active.root) : null;
  if (host !== null && !root.startsWith('ssh://')) root = `ssh://${host}${root}`;
  if (tauri) {
    // 빈 탭은 native 가 제자리 교체(replace id), 비어 있지 않은 탭의 대체는 invoke 뒤
    // 이전 탭을 닫는 front 뒷정리다 (native replace 는 root 없는 세션만 받는다)
    const prevId = sessions.activeId;
    // 'replace' 도 활성 탭이 비어 있으면 native 제자리 교체를 쓴다 — 대상이 이미 열려 있어
    // native 가 포커스만 옮기면 교체 슬롯은 건드리지 않으므로 Welcome 탭이 남는다 (2026-09-05)
    const emptyTarget = opts.mode === 'new' ? undefined : replaceTarget();
    // 'new' 는 배경 열기 — sessions-changed 가 invoke 응답보다 먼저 올 수 있어 예약이 앞선다
    if (opts.mode === 'new') openInBackground(root);
    // native 가 canonicalize·디렉토리 검증을 한다 — 잘못된 경로(오타·부재)는 reject 로
    // 오므로 알림으로 드러낸다 (경로 퀵인풋은 자동완성 없이도 타이핑 확정을 허용한다)
    void tauri.core
      .invoke('open_folder_path', { path: root, replace: emptyTarget })
      .then(() => {
        if (opts.mode === 'replace' && emptyTarget === undefined) replaceAppSession(prevId, root);
      })
      .catch((e) => {
        cancelBackground(root);
        notify('error', `폴더를 열 수 없습니다: ${String(e)}`);
      });
    return;
  }
  if (!webBackend) return;
  openWebFolder(root, opts.mode);
}

/** OS 폴더 다이얼로그 열기 (앱 전용) — 팔레트 커맨드·퀵인풋의 두 번째 Ctrl+O 가
 *  공유한다. 활성 빈 탭의 교체 판단(replace)을 한 곳에 모은다 */
export function openFolderDialog(): void {
  void tauri?.core.invoke('open_folder', { replace: replaceTarget() });
}

/**
 * 강제 정리 확인 — 승인 시 백엔드 POST /daemon/clean(host 는 실패 세션의 root 에서) 로
 * `superlite-daemon --clean` 을 원격(로컬 세션이면 로컬)에서 실행하고, 결과를 알림으로 보인
 * 뒤 그 세션을 재접속한다. 사용자 승인 없이는 아무것도 죽이지 않는다 (ticket daemon-cleanup)
 */
export async function confirmDaemonClean(): Promise<void> {
  const backend = daemonClean.pending;
  if (backend === null) return;
  daemonClean.pending = null;
  daemonClean.busy = true;
  try {
    const root = rootOfBackend(backend);
    const host = root === null ? null : remoteHost(root);
    const url = backendApiUrl('/daemon/clean', host === null ? {} : { host });
    if (url === null) throw new Error('원격 미지원 환경');
    const res = await fetch(url, { method: 'POST' });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    notify('info', `데몬 정리:\n${text.trim() || '(정리할 것 없음)'}`);
    reconnectSession(backend);
  } catch (e) {
    notify('error', `데몬 정리 실패: ${errText(e)}`);
  } finally {
    daemonClean.busy = false;
  }
}
daemonClean.onConfirm = confirmDaemonClean;

/** 영구 실패 뒤 사용자 주도 재접속 (시작 페이지·탐색기 Retry) — 활성 세션을 다시 연다 */
export function retryActiveConnection(): void {
  const c = activeSessionCtx();
  if (c) reconnectSession(c.backend);
}
