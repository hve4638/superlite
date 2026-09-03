import { reactive } from '@vue/reactivity';
import type { GitChangeKind, GitLogItem, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import type { createEditors } from './editors';
import { errText, notify } from './notifications';

export interface ScmChange {
  path: string;
  name: string;
  dir: string;
  kind: GitChangeKind;
  staged: boolean;
}

/** 세션별 SCM 모듈 — git 상태·커밋이 세션의 backend·editors 에 묶인다 */
export function createScm(backend: ThinBackend, editorsM: ReturnType<typeof createEditors>) {
  const { openDiff, openFile } = editorsM;

  const scm = reactive({
    branch: '',
    dirty: false,
    changes: [] as ScmChange[],
    commitMessage: '',
    /** HEAD 커밋 해시 — diff original 캐시 무효화 키. 백엔드가 주므로 앱 밖 커밋도 잡는다 */
    head: '',
    /** 최근 커밋 목록 (Graph pane) — head 가 바뀔 때만 다시 받는다 */
    log: [] as GitLogItem[],
    /** discard 확인 대기 중인 항목 — ScmView 가 대화상자를 띄운다 */
    discardConfirm: null as ScmChange[] | null,
  });

  let refreshSeq = 0;

  async function refreshScm(): Promise<void> {
    // WHY: 데몬이 요청을 병렬 처리해 겹친 gitStatus 가 역순으로 완료될 수 있다 — 낡은 응답이
    //      head 를 과거로 되돌리면 stale diff 캐시가 되살아나므로 마지막 발행분만 반영한다
    const seq = ++refreshSeq;
    const status = await backend.gitStatus();
    if (seq !== refreshSeq) return;
    const headChanged = scm.head !== status.head || scm.branch !== status.branch;
    scm.branch = status.branch;
    scm.head = status.head;
    scm.dirty = status.dirty;
    scm.changes = status.changes.map((c) => {
      const slash = c.path.lastIndexOf('/');
      return {
        path: c.path,
        name: c.path.slice(slash + 1),
        dir: slash === -1 ? '' : c.path.slice(0, slash),
        kind: c.kind,
        staged: c.staged,
      };
    });
    // 로그는 커밋·체크아웃·외부 git 조작으로 head 가 움직였을 때만 — 파일 저장마다 받지 않는다
    if (headChanged || (scm.log.length === 0 && status.head)) {
      const log = await backend.gitLog(50);
      if (seq === refreshSeq) scm.log = log;
    }
  }

  /** 변경 파일 클릭 → diff (untracked 는 diff 대상이 없으므로 파일로, 삭제는 HEAD vs 빈 내용) */
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
  async function commit(): Promise<void> {
    if (!scm.commitMessage.trim() || !scm.changes.some((c) => c.staged)) return;
    try {
      await backend.gitCommit(scm.commitMessage);
    } catch (e) {
      notify('error', `Failed to commit: ${errText(e)}`);
      return;
    }
    scm.commitMessage = '';
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

  /** 인자 없으면 unstaged 전체 */
  function stage(changes = scm.changes.filter((c) => !c.staged)): Promise<void> {
    return gitOp('stage', () => backend.gitStage(changes.map((c) => c.path)));
  }

  /** 인자 없으면 staged 전체 */
  function unstage(changes = scm.changes.filter((c) => c.staged)): Promise<void> {
    return gitOp('unstage', () => backend.gitUnstage(changes.map((c) => c.path)));
  }

  /** discard 요청 — 파괴적이라 바로 실행하지 않고 확인 대기 상태에 둔다 (ScmView 가 대화상자) */
  function requestDiscard(changes = scm.changes.filter((c) => !c.staged)): void {
    if (changes.length) scm.discardConfirm = changes;
  }

  async function confirmDiscard(): Promise<void> {
    const changes = scm.discardConfirm;
    scm.discardConfirm = null;
    if (!changes) return;
    const tracked = changes.filter((c) => c.kind !== 'untracked').map((c) => c.path);
    const untracked = changes.filter((c) => c.kind === 'untracked').map((c) => c.path);
    await gitOp('discard changes', () => backend.gitDiscard(tracked, untracked));
    // WHY: 되돌린 파일이 열려 있으면 편집기 내용이 디스크와 어긋난다 — 파일 감시가 외부 변경으로
    //      잡아 재로드한다 (mock 은 감시가 없어 탭이 옛 내용으로 남는다)
  }

  function cancelDiscard(): void {
    scm.discardConfirm = null;
  }

  function branches(): Promise<string[]> {
    return backend.gitBranches();
  }

  function checkout(branch: string): Promise<void> {
    if (branch === scm.branch) return Promise.resolve();
    return gitOp(`checkout '${branch}'`, () => backend.gitCheckout(branch));
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
    scm, refreshScm, openChange, openChangeFile, commit, decorationFor,
    stage, unstage, requestDiscard, confirmDiscard, cancelDiscard, branches, checkout,
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
export const openChange = (change: ScmChange): Promise<void> => ctx().scm.openChange(change);
export const openChangeFile = (change: ScmChange): Promise<void> => ctx().scm.openChangeFile(change);
export const commit = (): Promise<void> => ctx().scm.commit();
export const decorationFor = (path: string, isDir: boolean): { letter: string; color: string } | null =>
  ctx().scm.decorationFor(path, isDir);
export const stage = (changes?: ScmChange[]): Promise<void> => ctx().scm.stage(changes);
export const unstage = (changes?: ScmChange[]): Promise<void> => ctx().scm.unstage(changes);
export const requestDiscard = (changes?: ScmChange[]): void => ctx().scm.requestDiscard(changes);
export const confirmDiscard = (): Promise<void> => ctx().scm.confirmDiscard();
export const cancelDiscard = (): void => ctx().scm.cancelDiscard();
export const branches = (): Promise<string[]> => ctx().scm.branches();
export const checkout = (branch: string): Promise<void> => ctx().scm.checkout(branch);
