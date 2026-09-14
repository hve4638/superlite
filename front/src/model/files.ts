import { markRaw, reactive } from '@vue/reactivity';
import type { DirEntry, QuickOpenResult, ThinBackend } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { errText, notify } from './notifications';

export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  depth: number;
  children: TreeNode[] | null;
}

/** 창 이동 핸드오프의 탐색기 트리 몫 (JSON 직렬화 가능) */
export interface FilesSnapshot {
  root: TreeNode[];
  expanded: string[];
}

/** 추가 탐색기 섹션 (ticket explorer-extra-roots) — 드롭한 폴더를 루트로 하는 독립 트리 인스턴스.
 *  워크스페이스 안 폴더만 된다 (사용자 결정 2026-09-14) — 경로가 전부 루트 상대라 파일 조작·감시 갱신·
 *  git 표식이 메인 트리와 같은 통로를 그대로 쓴다. abs 는 저장·중복 판정 키(절대 경로, '/' 구분),
 *  base 는 트리 루트의 루트 상대 경로 */
export interface ExtraRoot {
  abs: string;
  base: string;
  name: string;
  tree: ReturnType<typeof createFiles>;
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** 절대 경로인가 — unix '/' 또는 Windows 드라이브 접두. 폴더 탭이 워크스페이스 밖에 있을 때의 path 꼴 */
export function isAbsPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:/.test(path);
}

/** 워크스페이스 root 의 절대 경로를 '/' 구분으로 — Windows rootPath 는 '\\' 로 온다 */
function normRoot(rootPath: string): string {
  return rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 폴더 탭의 상위 폴더 — 루트('')의 위는 root 의 절대 부모, 절대 경로는 한 단계 위, 파일시스템 꼭대기
 *  ('/'·'D:')는 null. 절대 경로가 다시 워크스페이스 안을 가리키면 루트 상대로 되돌린다 */
export function folderParent(path: string, rootPath: string): string | null {
  if (!isAbsPath(path)) return path === '' ? absParent(normRoot(rootPath)) : parentOf(path);
  const up = absParent(path);
  return up === null ? null : toWorkspacePath(up, rootPath);
}
function absParent(abs: string): string | null {
  if (abs === '/' || /^[a-zA-Z]:$/.test(abs)) return null;
  const slash = abs.lastIndexOf('/');
  if (slash <= 0) return '/';
  return abs.slice(0, slash);
}

/** 워크스페이스 경로(루트 상대 또는 이미 절대)를 절대 경로로 — 세션 열기(host.openFolder)용. Windows rootPath 는 '/' 로 정규화 */
export function toAbsPath(path: string, rootPath: string): string {
  if (isAbsPath(path)) return path;
  const root = normRoot(rootPath);
  return path === '' ? root : `${root}/${path}`;
}

/** 절대 경로를 워크스페이스 기준으로 — root 자신은 '', 그 아래면 루트 상대, 밖이면 그대로.
 *  밖에서 안으로 들어올 때 탭이 파일 조작이 되는 루트 상대 꼴로 수렴하게 */
export function toWorkspacePath(abs: string, rootPath: string): string {
  const root = normRoot(rootPath);
  if (abs === root) return '';
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
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

/** 세션별 탐색기 트리 모듈 — 상태는 팩토리 안에 산다 (한 페이지에 세션 여럿).
 *  base: 트리 루트 경로 ('' = 워크스페이스 루트). 추가 탐색기 섹션은 폴더 경로(루트 상대 또는 절대)를
 *  base 로 하는 별도 인스턴스다 — 펼침·선택·로드 상태가 섹션마다 독립 (ticket explorer-extra-roots) */
export function createFiles(backend: ThinBackend, base = '') {
  const files = reactive({
    /** 추가 탐색기 섹션 — 메인 인스턴스(base '')에만 있다. 드롭 순서. refreshDir·loadedDirPaths·refreshTree·
     *  collapseAll 이 여기로도 전달된다 (감시·파일 조작 갱신이 섹션에 닿게). 트리 자체는 markRaw */
    extraRoots: [] as ExtraRoot[],
    root: [] as TreeNode[],
    expanded: new Set<string>(),
    /** 포커스 행 — 키보드·rename·새 파일 위치의 기준이자 Shift 범위 선택의 끝점 */
    selectedPath: null as string | null,
    /** 선택 집합 (ticket explorer-multiselect-dnd) — 삭제·드래그 이동·Copy Path 가 이 전체에 작용한다.
     *  selectedPath 는 항상 이 안에 있거나 null. 접힌 폴더 아래 항목도 남아 있을 수 있어 조작 때는
     *  selectedNodes()(보이는 순서·트리에 실재하는 것만)로 읽는다 */
    selected: new Set<string>(),
    /** 루트 첫 로드 중 — 탐색기가 진행 막대를 보인다 (셸은 로드를 기다리지 않고 마운트된다) */
    loading: true,
    /** 자식 로드가 800ms 를 넘긴 디렉토리 — twistie 가 스피너로 바뀐다 (VS Code asyncDataTree
     *  의 slow 상태: 빠른 로드엔 깜빡임 없이, 느린 로드엔 "걸려 있음"을 그 행에서 알린다) */
    slowDirs: new Set<string>(),
    /** 폴더 탭(FolderView)이 보는 디렉토리 나열 — 트리와 별개로 임의 경로를 든다. 값 null 은
     *  로드 중, error 는 나열 실패(사라진 디렉토리 등). acquireDir/releaseDir 참조 계수로 살고
     *  refreshDir 가 트리의 로드된 디렉토리와 같은 규칙으로 갱신한다 (explorer-folder-tab) */
    listing: new Map<string, { entries: DirEntry[] | null; error?: string }>(),
    /** 트리에 키보드 포커스를 달라는 요청 (ticket terminal-path-links — 디렉토리 링크가 reveal 뒤
     *  사이드바를 포커스한다). ExplorerView 가 소비하고 false 로 되돌린다 */
    pendingFocus: false,
  });

  /** 디렉토리 나열 결과 구독 — SCM 이 repo 표식(와이어 v13)으로 하위 저장소를 즉시 등록한다 */
  let dirLoaded: ((entries: DirEntry[]) => void) | null = null;
  function onDirLoaded(cb: (entries: DirEntry[]) => void): void {
    dirLoaded = cb;
  }
  async function readDir(path: string): Promise<DirEntry[]> {
    const entries = sortEntries(await backend.readDir(path));
    dirLoaded?.(entries);
    return entries;
  }

  async function loadChildren(node: TreeNode): Promise<void> {
    if (node.children) return;
    const entries = await readDir(node.path);
    node.children = entries.map((e) => ({
      name: e.name, path: e.path, kind: e.kind, depth: node.depth + 1, children: null,
    }));
  }

  /** 루트 첫 로드 — 병합으로 넣는다: 창 이동 핸드오프의 트리 스냅샷(restore)이 먼저 들어와 있으면 그 노드·
   *  펼침·로드된 자식을 보존해야 한다 (ticket window-detach-reload). 실패는 그대로 던진다 (원격 접속 실패 판정) */
  async function initFiles(): Promise<void> {
    const entries = await readDir(base);
    mergeChildren(null, entries);
    files.loading = false;
  }

  /** 창 이동 핸드오프의 트리 몫 — 로드된 노드 전체(자식 포함)와 펼침 집합. 선택·폴더 탭 나열은 나르지 않는다 */
  function snapshot(): FilesSnapshot {
    return { root: JSON.parse(JSON.stringify(files.root)) as TreeNode[], expanded: [...files.expanded] };
  }

  /** 스냅샷을 그대로 세운다 — 새 창이 재조회를 기다리지 않고 즉시 그린다. 이후 refreshTree 가 병합으로 따라잡는다 */
  function restore(s: FilesSnapshot): void {
    files.root = s.root;
    files.expanded = new Set(s.expanded);
    files.loading = false;
  }

  // Quick Open 목록은 데몬이 걷어 세션 캐시로 든다 (와이어 v12, VS Code 방식) — 프론트는
  // 무효 여부만 기억했다가 다음 요청에 fresh 로 싣는다. 종전 listFiles 는 init 이 목록 전체
  // (홈 디렉터리 5만 파일 4MB)를 날라 저속 링크에서 뒤따르는 readDir 응답을 수 초 막았다
  let quickStale = true;

  async function quickOpen(pattern: string): Promise<QuickOpenResult> {
    const fresh = quickStale;
    quickStale = false;
    try {
      return await backend.quickOpen(pattern, fresh);
    } catch (e) {
      if (fresh) quickStale = true;
      throw e;
    }
  }

  /** 다음 Quick Open 요청이 목록을 다시 걷게 한다 — 걷기 자체는 Ctrl+P 까지 미룬다 */
  function invalidateQuickOpen(): void {
    quickStale = true;
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

  /** 폴더 탭 열의 나열 참조 — 참조 계수가 0→1 이 될 때 readDir, 이미 있으면 왕복 없음.
   *  같은 경로를 여러 폴더 탭(부모·현재·미리보기 열)이 같이 본다 */
  const listingRefs = new Map<string, number>();
  function acquireDir(path: string): void {
    listingRefs.set(path, (listingRefs.get(path) ?? 0) + 1);
    if (files.listing.has(path)) return;
    files.listing.set(path, { entries: null });
    void loadListing(path);
  }
  function releaseDir(path: string): void {
    const n = (listingRefs.get(path) ?? 0) - 1;
    if (n > 0) {
      listingRefs.set(path, n);
      return;
    }
    listingRefs.delete(path);
    files.listing.delete(path);
  }
  async function loadListing(path: string): Promise<void> {
    try {
      const entries = await readDir(path);
      if (files.listing.has(path)) files.listing.set(path, { entries });
    } catch (e) {
      if (files.listing.has(path)) files.listing.set(path, { entries: null, error: errText(e) });
    }
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
    for (const x of files.extraRoots) void x.tree.refreshDir(path);
    const node = path === base ? null : findNode(path);
    const inTree = path === base || (node !== null && node.kind === 'directory' && node.children !== null);
    const listed = files.listing.has(path);
    if (!inTree && !listed) return;
    let entries: DirEntry[];
    try {
      entries = await readDir(path);
    } catch (e) {
      // 디렉터리가 사라진 경우 등 — 트리는 부모 리프레시가 노드를 지우고, 폴더 탭 열은 사유를 보인다
      if (files.listing.has(path)) files.listing.set(path, { entries: null, error: errText(e) });
      return;
    }
    if (files.listing.has(path)) files.listing.set(path, { entries });
    if (!inTree) return;
    // WHY: await 사이에 부모 리프레시가 이 노드를 갈아끼웠을 수 있다 — 고아에 쓰면 조용히 증발
    if (node && findNode(path) !== node) return;
    mergeChildren(node, entries);
  }

  /** 나열 결과를 node(null = 루트)의 자식에 병합 — path/kind 가 같은 노드를 재사용해 하위 펼침·로드 상태를 보존 */
  function mergeChildren(node: TreeNode | null, entries: DirEntry[]): void {
    const oldNodes = node ? node.children! : files.root;
    const old = new Map(oldNodes.map((n) => [n.path, n]));
    const depth = node ? node.depth + 1 : 0;
    const next = entries.map((e) => {
      const prev = old.get(e.path);
      return prev && prev.kind === e.kind
        ? prev
        : { name: e.name, path: e.path, kind: e.kind, depth, children: null };
    });
    // 사라진 직계 엔트리의 펼침 상태 정리 (심층 잔재는 ponytail: 방치 — 화면에는 무해. workspaceState 가
    // expanded 를 통째로 직렬화하므로 저장본에는 실리지만, 없는 경로는 복원 때 펼칠 대상이 없어 무시된다)
    for (const n of oldNodes) {
      if (!next.includes(n)) files.expanded.delete(n.path);
    }
    if (node) node.children = next;
    else files.root = next;
  }

  /** 로드된(children 있는) 디렉터리 경로 전체 + 폴더 탭 나열 경로. 루트('') 포함. 전체 리프레시·
   *  fileops 의 최근접 로드 조상 판정용. */
  function loadedDirPaths(): string[] {
    const out = [base];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'directory' && n.children) {
          out.push(n.path);
          walk(n.children);
        }
      }
    };
    walk(files.root);
    for (const p of files.listing.keys()) if (!out.includes(p)) out.push(p);
    for (const x of files.extraRoots) for (const p of x.tree.loadedDirPaths()) if (!out.includes(p)) out.push(p);
    return out;
  }

  /** 수동 새로고침 (탐색기 Refresh 버튼) — 로드된 디렉토리 재나열 + Quick Open 캐시 무효화.
   *  실패는 삼킨다 (워처·다음 시도가 복구) — refreshDir 병합이라 펼침 상태는 보존된다 */
  async function refreshTree(): Promise<void> {
    invalidateQuickOpen();
    await Promise.allSettled(loadedDirPaths().map((d) => refreshDir(d)));
  }

  /** 모두 접기 — 펼침 집합만 비운다. 로드된 자식은 유지되어 재펼침에 왕복이 없다 */
  function collapseAll(): void {
    files.expanded.clear();
    for (const x of files.extraRoots) x.tree.collapseAll();
  }

  /** 경로를 트리에 드러낸다 — 조상 디렉토리를 차례로 로드·펼치고 선택한다 (VS Code explorer.autoReveal).
   *  트리에 없는 경로(files.exclude·워크스페이스 밖)는 닿는 데까지만 펼치고 만다 */
  async function revealPath(path: string): Promise<void> {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const node = findNode(parts.slice(0, i).join('/'));
      if (!node || node.kind !== 'directory') return;
      if (!files.expanded.has(node.path)) await toggleDir(node);
    }
    if (findNode(path)) select(path);
  }

  /** 펼침 집합 복원 (ticket workspace-state-restore) — 얕은 것부터 차례로 자식을 읽어 펼친다. 트리에서
   *  사라진 경로는 건너뛴다 (조상이 없으면 그 아래도 자연히 닿지 않는다) */
  async function expandPaths(paths: string[]): Promise<void> {
    for (const p of [...paths].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const node = findNode(p);
      if (!node || node.kind !== 'directory') continue;
      try {
        await loadChildren(node);
      } catch {
        continue;
      }
      files.expanded.add(p);
    }
  }

  // ---- 선택 (VS Code 트리 규칙): 클릭 = 단일, Ctrl = 토글, Shift = 앵커부터 범위(보이는 순서)
  /** Shift 범위의 시작 — 마지막 단일·토글 선택 위치. Shift 클릭은 앵커를 옮기지 않는다 */
  let anchor: string | null = null;

  function select(path: string | null): void {
    files.selected = new Set(path === null ? [] : [path]);
    files.selectedPath = path;
    anchor = path;
  }

  function toggleSelect(path: string): void {
    if (files.selected.has(path)) {
      files.selected.delete(path);
      if (files.selectedPath === path) files.selectedPath = null;
    } else {
      files.selected.add(path);
      files.selectedPath = path;
    }
    anchor = path;
  }

  /** 앵커부터 path 까지 보이는 순서로 선택 — 앵커가 사라졌으면 단일 선택으로 물러난다 */
  function rangeSelect(path: string): void {
    const vis = visibleNodes();
    const a = anchor === null ? -1 : vis.findIndex((n) => n.path === anchor);
    const b = vis.findIndex((n) => n.path === path);
    if (a === -1 || b === -1) {
      select(path);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    files.selected = new Set(vis.slice(lo, hi + 1).map((n) => n.path));
    files.selectedPath = path;
  }

  function selectAll(): void {
    files.selected = new Set(visibleNodes().map((n) => n.path));
  }

  /** 선택된 노드 — 보이는 순서, 트리에 실재하는 것만 (접힘·리프레시로 사라진 경로는 걸러진다) */
  function selectedNodes(): TreeNode[] {
    return visibleNodes().filter((n) => files.selected.has(n.path));
  }

  /** 현재 펼침 상태 기준 flat 목록 (가상 스크롤 없이 단순 렌더) */
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

  // ---- 추가 탐색기 섹션 (ticket explorer-extra-roots) — 메인 인스턴스 전용
  /** 섹션 추가 — abs 는 절대 경로, rootPath 는 워크스페이스 root. 워크스페이스 밖·루트 자신·이미 있는
   *  폴더는 조용히 무시한다 (사용자 결정 2026-09-14: 밖 폴더 드롭은 알림 없이 아무 일도 없음).
   *  첫 나열 실패(사라진 폴더 등)는 알리고 섹션을 만들지 않는다 — 저장본에서도 그대로 빠진다 */
  async function addExtraRoot(abs: string, rootPath: string): Promise<void> {
    abs = abs.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rootPath) return;
    const rel = toWorkspacePath(abs, rootPath);
    // toWorkspacePath 는 루트 밖이면 절대 경로를 그대로 돌려준다 — 그게 곧 "밖" 판정이다
    if (rel === '' || isAbsPath(rel) || files.extraRoots.some((x) => x.abs === abs)) return;
    const tree = createFiles(backend, rel);
    try {
      await tree.initFiles();
    } catch (e) {
      notify('warning', `Could not add explorer for ${abs}: ${errText(e)}`);
      return;
    }
    if (files.extraRoots.some((x) => x.abs === abs)) return; // 나열 중 같은 폴더가 먼저 들어왔다
    files.extraRoots.push({ abs, base: rel, name: rel.slice(rel.lastIndexOf('/') + 1), tree: markRaw(tree) });
  }
  function removeExtraRoot(abs: string): void {
    const i = files.extraRoots.findIndex((x) => x.abs === abs);
    if (i !== -1) files.extraRoots.splice(i, 1);
  }
  /** 섹션 순서 바꾸기 (헤더 드래그) — from 섹션을 목록의 toIndex 자리(삽입선 위치, 0 = 맨 위,
   *  길이 = 맨 아래)로 옮긴다. 자기 자신을 빼고 나면 뒤쪽 자리는 하나씩 당겨진다. 배열 순서가 곧 저장 순서다 */
  function moveExtraRoot(fromAbs: string, toIndex: number): void {
    const from = files.extraRoots.findIndex((x) => x.abs === fromAbs);
    if (from === -1 || toIndex < 0 || toIndex > files.extraRoots.length) return;
    const to = toIndex > from ? toIndex - 1 : toIndex;
    if (to === from) return;
    files.extraRoots.splice(to, 0, ...files.extraRoots.splice(from, 1));
  }

  return {
    files, initFiles, snapshot, restore, toggleDir, refreshDir, loadedDirPaths, onDirLoaded,
    quickOpen, invalidateQuickOpen, refreshTree, collapseAll, visibleNodes, revealPath, expandPaths,
    acquireDir, releaseDir, select, toggleSelect, rangeSelect, selectAll, selectedNodes,
    addExtraRoot, removeExtraRoot, moveExtraRoot,
    /** 이 트리 루트의 루트 상대 경로 — 공용 트리 컴포넌트(FileTree)가 "루트 행" 판정에 쓴다 */
    base,
  };
}

// ---- 활성 세션 전달 shim — UI·커맨드는 종전 이름 그대로 활성 세션에 작용한다

export const files = viewOf(() => ctx().files.files);
export const toggleDir = (node: TreeNode): Promise<void> => ctx().files.toggleDir(node);
export const refreshTree = (): Promise<void> => ctx().files.refreshTree();
export const quickOpen = (pattern: string): Promise<QuickOpenResult> => ctx().files.quickOpen(pattern);
export const collapseAll = (): void => ctx().files.collapseAll();
export const visibleNodes = (): TreeNode[] => ctx().files.visibleNodes();
export const revealPath = (path: string): Promise<void> => ctx().files.revealPath(path);
export const acquireDir = (path: string): void => ctx().files.acquireDir(path);
export const releaseDir = (path: string): void => ctx().files.releaseDir(path);
export const select = (path: string | null): void => ctx().files.select(path);
export const toggleSelect = (path: string): void => ctx().files.toggleSelect(path);
export const rangeSelect = (path: string): void => ctx().files.rangeSelect(path);
export const selectAll = (): void => ctx().files.selectAll();
export const selectedNodes = (): TreeNode[] => ctx().files.selectedNodes();
export const addExtraRoot = (abs: string, rootPath: string): Promise<void> => ctx().files.addExtraRoot(abs, rootPath);
export const removeExtraRoot = (abs: string): void => ctx().files.removeExtraRoot(abs);
export const moveExtraRoot = (fromAbs: string, toIndex: number): void => ctx().files.moveExtraRoot(fromAbs, toIndex);
/** 활성 세션의 메인 트리 모듈 — 공용 트리 컴포넌트가 인스턴스 하나를 받으므로 섹션 트리와 같은 모양이 필요하다.
 *  viewOf 프록시라 세션 전환이 그대로 반영된다 */
export const mainTree = viewOf(() => ctx().files);
