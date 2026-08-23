import { reactive } from '@vue/reactivity';
import { backend } from './host';
import type { GitChangeKind } from '../backend/types';
import { openDiff, openFile } from './editors';
import { errText, notify } from './notifications';

export interface ScmChange {
  path: string;
  name: string;
  dir: string;
  kind: GitChangeKind;
}

export const scm = reactive({
  branch: '',
  dirty: false,
  changes: [] as ScmChange[],
  commitMessage: '',
  /** 커밋마다 증가 — diff original(HEAD) 캐시 무효화 키 */
  headVersion: 0,
});

export async function refreshScm(): Promise<void> {
  const status = await backend.gitStatus();
  scm.branch = status.branch;
  scm.dirty = status.dirty;
  scm.changes = status.changes.map((c) => {
    const slash = c.path.lastIndexOf('/');
    return {
      path: c.path,
      name: c.path.slice(slash + 1),
      dir: slash === -1 ? '' : c.path.slice(0, slash),
      kind: c.kind,
    };
  });
}

/** 변경 파일 클릭 → diff (untracked 는 diff 대상이 없으므로 파일로) */
export async function openChange(change: ScmChange): Promise<void> {
  if (change.kind === 'untracked' || change.kind === 'added') {
    await openFile(change.path, { preview: true });
  } else {
    await openDiff(change.path);
  }
}

export async function commit(): Promise<void> {
  if (!scm.commitMessage.trim() || scm.changes.length === 0) return;
  try {
    await backend.gitCommit(scm.commitMessage);
  } catch (e) {
    notify('error', `Failed to commit: ${errText(e)}`);
    return;
  }
  scm.commitMessage = '';
  scm.headVersion += 1;
  await refreshScm();
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

/** path 의 git 데코레이션 (explorer 용). 디렉토리는 하위 변경 여부만 본다. */
export function decorationFor(path: string, isDir: boolean): { letter: string; color: string } | null {
  if (isDir) {
    const hit = scm.changes.find((c) => c.path.startsWith(`${path}/`));
    return hit ? { letter: '', color: CHANGE_COLOR[hit.kind] } : null;
  }
  const hit = scm.changes.find((c) => c.path === path);
  return hit ? { letter: CHANGE_LETTER[hit.kind], color: CHANGE_COLOR[hit.kind] } : null;
}
