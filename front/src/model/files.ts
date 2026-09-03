import { reactive } from '@vue/reactivity';
import type { DirEntry, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';

export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  depth: number;
  children: TreeNode[] | null;
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// 재사용 collator — localeCompare 는 호출마다 collator 를 만들어 수만 항목 정렬이 초 단위였다
const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
function sortEntries(entries: DirEntry[]): DirEntry[] {
  // WHY: VS Code explorer 정렬 — 디렉토리 우선, 이후 이름순(대소문자 무시).
  //      dotfile 도 같은 규칙으로 알파벳 위치에 온다 (ls 처럼 앞으로 몰지 않는다).
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/** 세션별 탐색기 트리 모듈 — 상태는 팩토리 안에 산다 (한 페이지에 세션 여럿) */
export function createFiles(backend: ThinBackend) {
  const files = reactive({
    root: [] as TreeNode[],
    expanded: new Set<string>(),
    selectedPath: null as string | null,
    /** quick open 용 전체 파일 목록 */
    allFiles: [] as string[],
    /** 루트 첫 로드 중 — 탐색기가 진행 막대를 보인다 (셸은 로드를 기다리지 않고 마운트된다) */
    loading: true,
    /** 자식 로드가 800ms 를 넘긴 디렉토리 — twistie 가 스피너로 바뀐다 (VS Code asyncDataTree
     *  의 slow 상태: 빠른 로드엔 깜빡임 없이, 느린 로드엔 "걸려 있음"을 그 행에서 알린다) */
    slowDirs: new Set<string>(),
  });

  async function loadChildren(node: TreeNode): Promise<void> {
    if (node.children) return;
    const entries = sortEntries(await backend.readDir(node.path));
    node.children = entries.map((e) => ({
      name: e.name, path: e.path, kind: e.kind, depth: node.depth + 1, children: null,
    }));
  }

  async function initFiles(): Promise<void> {
    const entries = sortEntries(await backend.readDir(''));
    files.root = entries.map((e) => ({ name: e.name, path: e.path, kind: e.kind, depth: 0, children: null }));
    files.loading = false;
    files.allFiles = await backend.listFiles();
  }

  const loadingDirs = new Set<string>();

  async function toggleDir(node: TreeNode): Promise<void> {
    if (files.expanded.has(node.path)) {
      files.expanded.delete(node.path);
      return;
    }
    // WHY: 로드 완료 전 재클릭(더블클릭)이 두 번째 toggle 로 들어오면 펼침이 무효화된다 — 로드 중엔 무시
    if (loadingDirs.has(node.path)) return;
    loadingDirs.add(node.path);
    const slowTimer = setTimeout(() => files.slowDirs.add(node.path), 800);
    try {
      await loadChildren(node);
    } finally {
      clearTimeout(slowTimer);
      files.slowDirs.delete(node.path);
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
  async function refreshDir(path: string): Promise<void> {
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
  function loadedDirPaths(): string[] {
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

  async function refreshAllFiles(): Promise<void> {
    files.allFiles = await backend.listFiles();
  }

  /** 수동 새로고침 (탐색기 Refresh 버튼) — 로드된 디렉토리 재나열 + Quick Open 목록 재조회.
   *  실패는 삼킨다 (워처·다음 시도가 복구) — refreshDir 병합이라 펼침 상태는 보존된다 */
  async function refreshTree(): Promise<void> {
    await Promise.allSettled([...loadedDirPaths().map((d) => refreshDir(d)), refreshAllFiles()]);
  }

  /** 모두 접기 — 펼침 집합만 비운다. 로드된 자식은 유지되어 재펼침에 왕복이 없다 */
  function collapseAll(): void {
    files.expanded.clear();
  }

  /** 현재 펼침 상태 기준 flat 목록 (가상 스크롤 없이 단순 렌더) */
  /** 경로를 트리에 드러낸다 — 조상 디렉토리를 차례로 로드·펼치고 선택한다 (VS Code explorer.autoReveal).
   *  트리에 없는 경로(files.exclude·워크스페이스 밖)는 닿는 데까지만 펼치고 만다 */
  async function revealPath(path: string): Promise<void> {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const node = findNode(parts.slice(0, i).join('/'));
      if (!node || node.kind !== 'directory') return;
      if (!files.expanded.has(node.path)) await toggleDir(node);
    }
    if (findNode(path)) files.selectedPath = path;
  }

  function visibleNodes(): TreeNode[] {
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

  return {
    files, initFiles, toggleDir, refreshDir, loadedDirPaths,
    refreshAllFiles, refreshTree, collapseAll, visibleNodes, revealPath,
  };
}

// ---- 활성 세션 전달 shim — UI·커맨드는 종전 이름 그대로 활성 세션에 작용한다

export const files = viewOf(() => ctx().files.files);
export const initFiles = (): Promise<void> => ctx().files.initFiles();
export const toggleDir = (node: TreeNode): Promise<void> => ctx().files.toggleDir(node);
export const refreshDir = (path: string): Promise<void> => ctx().files.refreshDir(path);
export const loadedDirPaths = (): string[] => ctx().files.loadedDirPaths();
export const refreshAllFiles = (): Promise<void> => ctx().files.refreshAllFiles();
export const refreshTree = (): Promise<void> => ctx().files.refreshTree();
export const collapseAll = (): void => ctx().files.collapseAll();
export const visibleNodes = (): TreeNode[] => ctx().files.visibleNodes();
export const revealPath = (path: string): Promise<void> => ctx().files.revealPath(path);
