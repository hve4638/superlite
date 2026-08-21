import { reactive } from '@vue/reactivity';
import { backend } from './host';
import type { DirEntry } from '../backend/types';

export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  depth: number;
  children: TreeNode[] | null;
}

export const files = reactive({
  root: [] as TreeNode[],
  expanded: new Set<string>(),
  selectedPath: null as string | null,
  /** quick open 용 전체 파일 목록 */
  allFiles: [] as string[],
});

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  // WHY: VS Code explorer 정렬 — 디렉토리 우선, 이후 이름순(대소문자 무시).
  //      dotfile 도 같은 규칙으로 알파벳 위치에 온다 (ls 처럼 앞으로 몰지 않는다).
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

async function loadChildren(node: TreeNode): Promise<void> {
  if (node.children) return;
  const entries = sortEntries(await backend.readDir(node.path));
  node.children = entries.map((e) => ({
    name: e.name, path: e.path, kind: e.kind, depth: node.depth + 1, children: null,
  }));
}

export async function initFiles(): Promise<void> {
  const entries = sortEntries(await backend.readDir(''));
  files.root = entries.map((e) => ({ name: e.name, path: e.path, kind: e.kind, depth: 0, children: null }));
  files.allFiles = await backend.listFiles();
}

const loadingDirs = new Set<string>();

export async function toggleDir(node: TreeNode): Promise<void> {
  if (files.expanded.has(node.path)) {
    files.expanded.delete(node.path);
    return;
  }
  // WHY: 로드 완료 전 재클릭(더블클릭)이 두 번째 toggle 로 들어오면 펼침이 무효화된다 — 로드 중엔 무시
  if (loadingDirs.has(node.path)) return;
  loadingDirs.add(node.path);
  try {
    await loadChildren(node);
  } finally {
    loadingDirs.delete(node.path);
  }
  files.expanded.add(node.path);
}

function findNode(path: string, nodes: TreeNode[] = files.root): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.kind === 'directory' && n.children && path.startsWith(`${n.path}/`)) {
      return findNode(path, n.children);
    }
  }
  return null;
}

/**
 * 로드된 디렉터리를 다시 읽어 기존 노드와 병합 — path/kind 가 같은 노드를 재사용해
 * 하위의 펼침·로드 상태를 보존한다. path='' 는 루트. 미로드 디렉터리는 무시.
 */
export async function refreshDir(path: string): Promise<void> {
  const node = path === '' ? null : findNode(path);
  if (path !== '' && (!node || node.kind !== 'directory' || !node.children)) return;
  let entries: DirEntry[];
  try {
    entries = sortEntries(await backend.readDir(path));
  } catch {
    return; // 디렉터리가 사라진 경우 등 — 부모 리프레시가 노드를 지운다
  }
  // WHY: await 사이에 부모 리프레시가 이 노드를 갈아끼웠을 수 있다 — 고아에 쓰면 조용히 증발
  if (node && findNode(path) !== node) return;
  const oldNodes = node ? node.children! : files.root;
  const old = new Map(oldNodes.map((n) => [n.path, n]));
  const depth = node ? node.depth + 1 : 0;
  const next = entries.map((e) => {
    const prev = old.get(e.path);
    return prev && prev.kind === e.kind
      ? prev
      : { name: e.name, path: e.path, kind: e.kind, depth, children: null };
  });
  // 사라진 직계 엔트리의 펼침 상태 정리 (심층 잔재는 ponytail: 방치 — 무해)
  for (const n of oldNodes) {
    if (!next.includes(n)) files.expanded.delete(n.path);
  }
  if (node) node.children = next;
  else files.root = next;
}

/** 로드된(children 있는) 디렉터리 경로 전체. 루트('') 포함. 전체 리프레시용. */
export function loadedDirPaths(): string[] {
  const out = [''];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'directory' && n.children) {
        out.push(n.path);
        walk(n.children);
      }
    }
  };
  walk(files.root);
  return out;
}

export async function refreshAllFiles(): Promise<void> {
  files.allFiles = await backend.listFiles();
}

/** 현재 펼침 상태 기준 flat 목록 (가상 스크롤 없이 단순 렌더) */
export function visibleNodes(): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === 'directory' && files.expanded.has(n.path) && n.children) walk(n.children);
    }
  };
  walk(files.root);
  return out;
}
