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
