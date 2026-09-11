import { reactive, watch } from '@vue/reactivity';
import type { DirEntry, GitChangeKind, GitLogItem, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { confirm } from './dialog';
import type { createEditors } from './editors';
import { errText, notify } from './notifications';

export interface ScmChange {
  /** 워크스페이스 루트 상대 경로 — 탐색기 장식·편집기 열기의 좌표 */
  path: string;
  /** 저장소 루트 상대 경로 — git 호출(stage 등)의 좌표. 루트 저장소면 path 와 같다 */
  rel: string;
  /** 소속 저장소 (ScmRepo.path) */
  repo: string;
  name: string;
  /** 저장소 기준 디렉토리 (VS Code SCM 뷰의 설명 열) */
  dir: string;
  kind: GitChangeKind;
  staged: boolean;
}

/** 저장소 하나의 SCM 상태 — 루트('')·하위·중첩 저장소가 각각 하나씩 */
export interface ScmRepo {
  /** 워크스페이스 루트 상대 디렉토리 (루트 저장소는 '') */
  path: string;
  /** 표시 이름 — 폴더명 (루트는 워크스페이스 이름 자리라 ScmView 가 대체) */
  name: string;
  branch: string;
  /** HEAD 커밋 해시 — diff original 캐시 무효화 키. 백엔드가 주므로 앱 밖 커밋도 잡는다 */
  head: string;
  dirty: boolean;
  changes: ScmChange[];
  commitMessage: string;
  /** 최근 커밋 목록 (Graph pane) — head 가 바뀔 때만 다시 받는다 */
  log: GitLogItem[];
  /** 진행 중인 원격 동기화 — 'fetch'|'pull'|'push', 없으면 ''. ScmView 가 회전 아이콘·메뉴 비활성에 쓴다 */
  syncing: string;
}

/** 창 이동 핸드오프의 SCM 몫 (JSON 직렬화 가능) — 저장소 목록과 선택. 확인 대기(discard)는 나르지 않는다 */
export interface ScmSnapshot {
  repos: ScmRepo[];
  selected: string;
}

/** 세션별 SCM 모듈 — git 상태·커밋이 세션의 backend·editors 에 묶인다 */
export function createScm(backend: ThinBackend, editorsM: ReturnType<typeof createEditors>) {
  const { openDiff, openFile } = editorsM;

  const scm = reactive({
    /** 인식된 저장소 — 경로순. 자동 탐색(gitRepos) + 트리 펼침(readDir repo 표식) 의 합집합 */
    repos: [] as ScmRepo[],
    /** 전 저장소 변경의 평탄 목록 (워크스페이스 경로) — 탐색기 장식·활동바 배지 */
    changes: [] as ScmChange[],
    /** 전 저장소 head 의 결합 키 — 어느 저장소든 HEAD 가 움직이면 바뀐다 (diff 탭 재동기화 신호) */
    head: '',
    /** 선택된 저장소(경로) — SCM 뷰의 변경·Graph pane 과 상태바가 이 저장소를 보인다. 리포지토리
     *  목록 클릭이 명시적으로 바꾸고, 활성 편집기 파일이 바뀌면 그 파일의 저장소를 따른다 (VS Code 자동 모드) */
    selected: '',
    /** discard 확인 대기 중인 항목 — ScmView 가 대화상자를 띄운다 */
  });

  let scanned = false;
  let refreshSeq = 0;

  function repoAt(path: string): ScmRepo | undefined {
    return scm.repos.find((r) => r.path === path);
  }

  /** 워크스페이스 경로가 속한 저장소 — 가장 깊은(긴) 저장소 경로가 이긴다 (중첩 저장소) */
  function repoOf(path: string): ScmRepo | undefined {
    let best: ScmRepo | undefined;
    for (const r of scm.repos) {
      if (r.path !== '' && path !== r.path && !path.startsWith(`${r.path}/`)) continue;
      if (!best || r.path.length > best.path.length) best = r;
    }
    return best;
  }

  /** 선택된 저장소 — 선택이 없거나 사라졌으면 첫째 */
  function activeRepo(): ScmRepo | undefined {
    return repoAt(scm.selected) ?? scm.repos[0];
  }

  function selectRepo(path: string): void {
    scm.selected = path;
  }

  // 활성 편집기 파일이 바뀌면 그 파일의 저장소를 선택 (VS Code 리포지토리 자동 선택). 세션 수명과
  // 같이 살므로 해제하지 않는다
  watch(() => editorsM.activeTab()?.path, (path) => {
    const repo = path === undefined ? undefined : repoOf(path);
    if (repo) scm.selected = repo.path;
  });

  /** 저장소 상대 경로 → 워크스페이스 경로 */
  function wsPath(repo: string, rel: string): string {
    return repo === '' ? rel : `${repo}/${rel}`;
  }

  /** 워크스페이스 경로 → 저장소 상대 경로 (repoOf 로 구한 저장소 기준) */
  function relPath(repo: ScmRepo, path: string): string {
    return repo.path === '' ? path : path.slice(repo.path.length + 1);
  }

  function rebuildAggregate(): void {
    scm.changes = scm.repos.flatMap((r) => r.changes);
    scm.head = scm.repos.map((r) => r.head).join(',');
  }

  function insertRepo(path: string): ScmRepo {
    const repo: ScmRepo = {
      path, name: path.slice(path.lastIndexOf('/') + 1), branch: '', head: '', dirty: false,
      changes: [], commitMessage: '', log: [], syncing: '',
    };
    scm.repos.push(repo);
    scm.repos.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // WHY: raw 객체가 아니라 배열에서 꺼낸 reactive proxy 를 돌려준다 — raw 에 쓰면 구독자가
    //      모르고, 뒤이은 proxy 쓰기는 같은 값이라 무시돼 상태바가 영영 비어 있었다
    return repoAt(path)!;
  }

  /** 저장소 하나의 상태 재조회. 저장소가 아니면(branch·head 둘 다 '') 목록에서 뺀다 */
  async function refreshRepo(repo: ScmRepo, seq: number): Promise<void> {
    const status = await backend.gitStatus(repo.path);
    if (seq !== refreshSeq) return;
    if (status.branch === '' && status.head === '' && repo.path !== '') {
      scm.repos = scm.repos.filter((r) => r !== repo);
      return;
    }
    const headChanged = repo.head !== status.head || repo.branch !== status.branch;
    repo.branch = status.branch;
    repo.head = status.head;
    repo.dirty = status.dirty;
    repo.changes = status.changes.map((c) => {
      // 중첩 저장소는 부모 저장소에 'vendor/nested/' 처럼 슬래시로 끝나는 untracked 디렉토리 한 항목으로
      // 온다 (git 은 안쪽 저장소로 내려가지 않는다) — 이름·디렉토리는 슬래시를 뗀 경로로 센다
      const trimmed = c.path.endsWith('/') ? c.path.slice(0, -1) : c.path;
      const slash = trimmed.lastIndexOf('/');
      return {
        path: wsPath(repo.path, c.path),
        rel: c.path,
        repo: repo.path,
        name: trimmed.slice(slash + 1),
        dir: slash === -1 ? '' : trimmed.slice(0, slash),
        kind: c.kind,
        staged: c.staged,
      };
    });
    // 로그는 커밋·체크아웃·외부 git 조작으로 head 가 움직였을 때만 — 파일 저장마다 받지 않는다
    if (headChanged || (repo.log.length === 0 && status.head)) {
      const log = await backend.gitLog(repo.path, 50);
      if (seq === refreshSeq) repo.log = log;
    }
  }

  /** 전 저장소 상태 재조회. 첫 호출은 자동 탐색(gitRepos)을 먼저 한다 */
  async function refreshScm(): Promise<void> {
    // WHY: 데몬이 요청을 병렬 처리해 겹친 gitStatus 가 역순으로 완료될 수 있다 — 낡은 응답이
    //      head 를 과거로 되돌리면 stale diff 캐시가 되살아나므로 마지막 발행분만 반영한다
    const seq = ++refreshSeq;
    if (!scanned) {
      await scan(seq);
      if (seq !== refreshSeq) return;
    }
    await Promise.all(scm.repos.map((r) => refreshRepo(r, seq)));
    if (seq !== refreshSeq) return;
    rebuildAggregate();
  }

  async function scan(seq: number): Promise<void> {
    const found = await backend.gitRepos();
    if (seq !== refreshSeq) return;
    scanned = true;
    // 합집합 — 트리 펼침으로 등록된 더 깊은 저장소는 탐색 범위 밖일 수 있다. 사라진 것은 refreshRepo 가 뺀다
    for (const p of found) if (!repoAt(p)) insertRepo(p);
  }

  function snapshot(): ScmSnapshot {
    return { repos: JSON.parse(JSON.stringify(scm.repos)) as ScmRepo[], selected: scm.selected };
  }

  /** 스냅샷 적용 — 새 창이 재조회 없이 즉시 그린다 (ticket window-detach-reload). 기존 항목에는 덮어쓰고 없는
   *  것은 넣는다 (교체가 아니다 — 진행 중인 refreshRepo 가 든 참조가 고아가 되지 않게). 원격 동기화 진행
   *  표시는 출처 창의 것이라 지운다. 자동 탐색은 스냅샷이 대신한 것으로 본다 */
  function restore(s: ScmSnapshot): void {
    for (const r of s.repos) Object.assign(repoAt(r.path) ?? insertRepo(r.path), r, { syncing: '' });
    scm.selected = s.selected;
    scanned = true;
    rebuildAggregate();
  }

  /** 재탐색 (SCM 뷰 액션) — 자동 탐색이 놓친 저장소를 다시 찾는다 */
  async function rescanRepos(): Promise<void> {
    scanned = false;
    await refreshScm();
  }

  /** 트리 나열 결과의 repo 표식 — 펼쳐서 보인 저장소를 즉시 등록하고 상태를 받는다 */
  function noteDirEntries(entries: DirEntry[]): void {
    const fresh = entries.filter((e) => e.repo && !repoAt(e.path)).map((e) => insertRepo(e.path));
    if (!fresh.length) return;
    const seq = refreshSeq; // 진행 중 refresh 와 같은 세대 — 낡은 응답 판정에 끼어들지 않는다
    void Promise.all(fresh.map((r) => refreshRepo(r, seq).catch(() => {}))).then(() => {
      if (seq === refreshSeq) rebuildAggregate();
    });
  }

  /** 변경 파일 클릭 → diff (untracked 는 diff 대상이 없으므로 파일로, 삭제는 HEAD 내용 읽기 전용 보기 — openDiff deleted) */
  async function openChange(change: ScmChange): Promise<void> {
    if (change.kind === 'untracked' || change.kind === 'added') {
      await openFile(change.path, { preview: true });
    } else {
      await openDiff(change.path, { deleted: change.kind === 'deleted' });
    }
  }

  /** 행의 "Open File" 액션 — diff 가 아니라 파일 자체를 연다 (VS Code 동일) */
  async function openChangeFile(change: ScmChange): Promise<void> {
    await openFile(change.path);
  }

  /** staged 항목만 커밋 — staged 가 없으면 no-op (UI 는 버튼을 비활성화한다) */
  async function commit(repo: ScmRepo): Promise<void> {
    if (!repo.commitMessage.trim() || !repo.changes.some((c) => c.staged)) return;
    try {
      await backend.gitCommit(repo.path, repo.commitMessage);
    } catch (e) {
      notify('error', `Failed to commit: ${errText(e)}`);
      return;
    }
    repo.commitMessage = '';
    await refreshScm(); // 새 head 가 여기서 들어온다 — 수동 무효화 불필요
  }

  /** git 조작 공통 — 실패는 notify, 성공·실패 무관하게 상태 재조회 (부분 성공 반영) */
  async function gitOp(label: string, op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (e) {
      notify('error', `Failed to ${label}: ${errText(e)}`);
    }
    await refreshScm();
  }

  /** 변경 목록을 저장소별로 묶어 op 를 저장소마다 한 번씩 */
  function perRepo(changes: ScmChange[], op: (repo: string, mine: ScmChange[]) => Promise<void>): Promise<void> {
    const groups = new Map<string, ScmChange[]>();
    for (const c of changes) groups.set(c.repo, [...(groups.get(c.repo) ?? []), c]);
    return Promise.all([...groups].map(([repo, mine]) => op(repo, mine))).then(() => {});
  }

  const rels = (changes: ScmChange[]): string[] => changes.map((c) => c.rel);

  /** 인자 없으면 전 저장소 unstaged 전체 */
  function stage(changes = scm.changes.filter((c) => !c.staged)): Promise<void> {
    return gitOp('stage', () => perRepo(changes, (repo, mine) => backend.gitStage(repo, rels(mine))));
  }

  /** 인자 없으면 전 저장소 staged 전체 */
  function unstage(changes = scm.changes.filter((c) => c.staged)): Promise<void> {
    return gitOp('unstage', () => perRepo(changes, (repo, mine) => backend.gitUnstage(repo, rels(mine))));
  }

  /** discard — 파괴적이라 확인을 거친다 (VS Code git 확장의 문구, untracked 는 파일 삭제라 DELETE 로 강조) */
  async function requestDiscard(changes = scm.changes.filter((c) => !c.staged)): Promise<void> {
    if (!changes.length) return;
    const untracked = changes.filter((c) => c.kind === 'untracked').length;
    const ask = changes.length === 1
      ? changes[0].kind === 'untracked'
        ? { message: `Are you sure you want to DELETE '${changes[0].name}'?`,
            detail: 'This is IRREVERSIBLE! This file will be FOREVER LOST if you proceed.',
            confirmLabel: 'Delete File' }
        : { message: `Are you sure you want to discard changes in '${changes[0].name}'?`,
            detail: 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST.',
            confirmLabel: 'Discard Changes' }
      : { message: `Are you sure you want to discard ALL changes in ${changes.length} files?`,
          detail: untracked
            ? `This will DELETE ${untracked} untracked file(s)! This is IRREVERSIBLE!`
            : 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST.',
          confirmLabel: 'Discard All Changes' };
    if ((await confirm(ask)) !== 'confirm') return;
    await gitOp('discard changes', () => perRepo(changes, (repo, mine) => backend.gitDiscard(
      repo,
      rels(mine.filter((c) => c.kind !== 'untracked')),
      rels(mine.filter((c) => c.kind === 'untracked')),
    )));
    // WHY: 되돌린 파일이 열려 있으면 편집기 내용이 디스크와 어긋난다 — 파일 감시가 외부 변경으로
    //      잡아 재로드한다 (mock 은 감시가 없어 탭이 옛 내용으로 남는다)
  }

  function branches(repo: ScmRepo): Promise<string[]> {
    return backend.gitBranches(repo.path);
  }

  function checkout(repo: ScmRepo, branch: string): Promise<void> {
    if (branch === repo.branch) return Promise.resolve();
    return gitOp(`checkout '${branch}'`, () => backend.gitCheckout(repo.path, branch));
  }

  /** 원격 동기화 (fetch/pull/push) — 한 저장소에 하나씩만 (진행 중이면 무시). 인증 프롬프트는 데몬의
   *  askpass 요청이 gitauth 로 오고, 대화상자는 ScmView 가 띄운다. 성공은 알림 없이 상태 재조회만 */
  async function sync(repo: ScmRepo, kind: 'fetch' | 'pull' | 'push'): Promise<void> {
    if (repo.syncing) return;
    repo.syncing = kind;
    const op = kind === 'fetch' ? backend.gitFetch : kind === 'pull' ? backend.gitPull : backend.gitPush;
    try {
      await gitOp(kind, () => op.call(backend, repo.path));
    } finally {
      repo.syncing = '';
    }
  }

  /** path 의 git 데코레이션 (explorer 용). 디렉토리는 하위 변경 여부만 본다. */
  function decorationFor(path: string, isDir: boolean): { letter: string; color: string } | null {
    if (isDir) {
      const hit = scm.changes.find((c) => c.path.startsWith(`${path}/`));
      return hit ? { letter: '', color: CHANGE_COLOR[hit.kind] } : null;
    }
    const hit = scm.changes.find((c) => c.path === path);
    return hit ? { letter: CHANGE_LETTER[hit.kind], color: CHANGE_COLOR[hit.kind] } : null;
  }

  return {
    scm, refreshScm, snapshot, restore, rescanRepos, noteDirEntries, repoOf, relPath, activeRepo, selectRepo, openChange, openChangeFile, commit,
    decorationFor, stage, unstage, requestDiscard, branches, checkout, sync,
  };
}

export const CHANGE_LETTER: Record<GitChangeKind, string> = {
  modified: 'M', untracked: 'U', deleted: 'D', added: 'A',
};

/** explorer/scm 파일명 색상용 데코레이션 토큰 이름 */
export const CHANGE_COLOR: Record<GitChangeKind, string> = {
  modified: '--vscode-gitDecoration-modifiedResourceForeground',
  untracked: '--vscode-gitDecoration-untrackedResourceForeground',
  deleted: '--vscode-gitDecoration-deletedResourceForeground',
  added: '--vscode-gitDecoration-addedResourceForeground',
};

// ---- 활성 세션 전달 shim

export const scm = viewOf(() => ctx().scm.scm);
export const refreshScm = (): Promise<void> => ctx().scm.refreshScm();
export const rescanRepos = (): Promise<void> => ctx().scm.rescanRepos();
export const repoOf = (path: string): ScmRepo | undefined => ctx().scm.repoOf(path);
export const relPath = (repo: ScmRepo, path: string): string => ctx().scm.relPath(repo, path);
export const activeRepo = (): ScmRepo | undefined => ctx().scm.activeRepo();
export const selectRepo = (path: string): void => ctx().scm.selectRepo(path);
export const openChange = (change: ScmChange): Promise<void> => ctx().scm.openChange(change);
export const openChangeFile = (change: ScmChange): Promise<void> => ctx().scm.openChangeFile(change);
export const commit = (repo: ScmRepo): Promise<void> => ctx().scm.commit(repo);
export const decorationFor = (path: string, isDir: boolean): { letter: string; color: string } | null =>
  ctx().scm.decorationFor(path, isDir);
export const stage = (changes?: ScmChange[]): Promise<void> => ctx().scm.stage(changes);
export const unstage = (changes?: ScmChange[]): Promise<void> => ctx().scm.unstage(changes);
export const requestDiscard = (changes?: ScmChange[]): Promise<void> => ctx().scm.requestDiscard(changes);
export const branches = (repo: ScmRepo): Promise<string[]> => ctx().scm.branches(repo);
export const checkout = (repo: ScmRepo, branch: string): Promise<void> => ctx().scm.checkout(repo, branch);
export const sync = (repo: ScmRepo, kind: 'fetch' | 'pull' | 'push'): Promise<void> => ctx().scm.sync(repo, kind);
