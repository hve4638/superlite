import { reactive } from '@vue/reactivity';
import type { ThinBackend, WriteResult } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { errText, notify } from './notifications';

export interface FileTab {
  kind: 'file';
  /** 탭 식별자. file 탭은 path, diff 탭은 'diff:'+path */
  id: string;
  path: string;
  name: string;
  dirty: boolean;
  /** preview 탭(이탤릭). 다른 파일을 preview 로 열면 교체된다. */
  preview: boolean;
}

export interface DiffTab {
  kind: 'diff';
  id: string;
  path: string;
  /** 탭 라벨: "format.ts (Working Tree)" */
  name: string;
  /** diff 의 modified 쪽은 워킹트리 파일 그 자체라 편집·저장이 가능하다 (VS Code 동일) */
  dirty: boolean;
  preview: boolean;
}

export type Tab = FileTab | DiffTab;

export interface EditorGroup {
  id: number;
  tabs: Tab[];
  activeTabId: string | null;
}

/** 화면 배치 트리 — 리프는 그룹 id, 분기는 행(row: 좌우)/열(column: 상하) 컨테이너.
 *  그룹 순회는 flat 한 editors.groups 로 하고, 이 트리는 배치·분할 위치만 담당한다. */
export interface LayoutBranch {
  dir: 'row' | 'column';
  children: LayoutNode[];
  /** 자식별 flex 비율 — 생략 시 균등. 인덱스가 children 과 정렬된다 */
  sizes?: number[];
}
export type LayoutNode = number | LayoutBranch;

export type SplitSide = 'left' | 'right' | 'up' | 'down';

interface Doc {
  content: string;
  savedContent: string;
  /** savedContent 가 읽힌/쓰인 시점의 디스크 etag — 저장 시 낙관적 충돌 검사에 쓴다 */
  etag: string;
}

const RECENTLY_CLOSED_CAP = 20;

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * 외부 변경을 열린 monaco 모델에 편집으로 반영하는 훅 — ui/editor/monaco.ts 가 등록한다.
 * (model 계층이 UI 를 모른 채 재로드를 완결하기 위한 seam)
 * 세션 공용 슬롯 — 훅은 경로를 받는 UI 능력이지 세션 상태가 아니다.
 */
let applyExternalEdit: ((path: string, content: string) => void) | null = null;
export function setApplyExternalEdit(fn: (path: string, content: string) => void): void {
  applyExternalEdit = fn;
}

/**
 * rename/delete 시 열린 monaco 모델을 버리는 훅 — ui/editor/monaco.ts 가 등록한다.
 * 새 경로의 모델은 doc 스냅샷에서 재생성된다 (VS Code 의 "새 경로 재해석" 과 동일 감각 —
 * 언어도 새 확장자로 재판정된다. 커서·undo 는 잃는다).
 */
let disposeModels: ((path: string) => void) | null = null;
export function setDisposeModels(fn: (path: string) => void): void {
  disposeModels = fn;
}

/** 세션별 에디터 모듈 — 탭·그룹·문서 상태와 열기/저장/충돌 처리가 팩토리 안에 산다.
 *  isActive: 이 세션이 활성인가 — monaco 훅은 활성 세션에서만 발화한다 (모델 캐시가
 *  활성 세션 소유라, 배경 세션의 재로드가 같은 경로의 활성 모델을 덮으면 안 된다.
 *  배경 세션의 모델은 재활성화 때 doc 스냅샷에서 다시 만들어진다) */
export function createEditors(backend: ThinBackend, isActive: () => boolean = () => true) {
  let nextGroupId = 1;
  const applyExternalEditHook = (path: string, content: string) => {
    if (isActive()) applyExternalEdit?.(path, content);
  };
  const disposeModelsHook = (path: string) => {
    if (isActive()) disposeModels?.(path);
  };

  const editors = reactive({
    groups: [{ id: 0, tabs: [], activeTabId: null }] as EditorGroup[],
    layout: 0 as LayoutNode,
    activeGroupId: 0,
    /** path → 문서 내용. 그룹/탭과 분리 — 같은 파일을 여러 탭이 공유한다. */
    docs: new Map<string, Doc>(),
    /** 커서 위치 (statusbar 표시용, 1-based) */
    cursor: { line: 1, col: 1 },
    /** 열림 직후 특정 라인으로 스크롤할 요청 (검색 결과 클릭 등). MonacoHost 가 소비 후 null 로 되돌린다. */
    pendingReveal: null as { path: string; line: number } | null,
    /** 저장 충돌(디스크가 더 새것) 중인 파일 path — 토스트가 Overwrite/Revert 를 띄운다.
     *  ponytail: 슬롯 하나 — 동시 다발 충돌은 마지막 것만 표시 (저장은 어차피 파일별 재시도) */
    saveConflict: null as string | null,
    /** 외부 삭제로 디스크에서 사라진 열린 파일 path — 탭에 strikethrough, 저장하면 부활.
     *  (탭은 유지 — VS Code closeOnFileDelete=false. 앱 내 삭제는 closePathTabs 가 닫는다) */
    orphaned: new Set<string>(),
    /** 닫은 탭 복원 이력 (최근이 뒤) — Ctrl+Shift+T 가 pop 한다 */
    recentlyClosed: [] as { kind: Tab['kind']; path: string }[],
    /** 닫기 확인 대기 — dirty 문서의 마지막 탭을 닫을 때 Save/Don't Save/Cancel 대화상자
     *  (VS Code 동일 — 조용히 닫으면 버퍼가 몰래 살아남아 "닫았는데 편집이 남는" 혼동을 낳는다) */
    closeConfirm: null as { groupId: number; tabId: string; path: string } | null,
    /** 에디터 포커스 요청 — MonacoHost 가 소비. 트리 단일 클릭(preview)은 세우지 않아
     *  포커스가 트리에 남는다 (VS Code 동일 — Delete 가 파일 삭제로 이어져야 한다) */
    pendingFocus: false,
  });

  function activeGroup(): EditorGroup {
    return editors.groups.find((g) => g.id === editors.activeGroupId) ?? editors.groups[0];
  }

  function activeTab(): Tab | null {
    const g = activeGroup();
    return g.tabs.find((t) => t.id === g.activeTabId) ?? null;
  }

  async function ensureDoc(path: string): Promise<Doc> {
    let doc = editors.docs.get(path);
    if (!doc) {
      const { content, etag } = await backend.readFile(path);
      doc = { content, savedContent: content, etag };
      editors.docs.set(path, doc);
    }
    return doc;
  }

  /**
   * 파일 열기. preview=true(트리 단일 클릭)면 기존 preview 탭을 교체하고,
   * preview=false(더블 클릭/명시적 오픈)면 고정 탭으로 연다.
   */
  /** @returns 열기 성공 여부 — 읽기 실패는 notify 후 false (호출측 후속 동작 가드용) */
  async function openFile(
    path: string,
    opts?: { preview?: boolean; groupId?: number; focus?: boolean },
  ): Promise<boolean> {
    let doc: Doc;
    try {
      doc = await ensureDoc(path);
    } catch (e) {
      notify('error', `Unable to open '${baseName(path)}': ${errText(e)}`);
      return false;
    }
    const group = opts?.groupId !== undefined
      ? editors.groups.find((g) => g.id === opts.groupId) ?? activeGroup()
      : activeGroup();

    const existing = group.tabs.find((t) => t.id === path);
    if (existing) {
      if (!opts?.preview) existing.preview = false;
      group.activeTabId = existing.id;
      editors.activeGroupId = group.id;
      if (opts?.focus !== false) editors.pendingFocus = true;
      return true;
    }

    const tab: FileTab = {
      kind: 'file', id: path, path, name: baseName(path),
      // WHY: dirty 인 채 닫힌 문서를 다시 열 수 있다 — 버퍼가 살아 있으므로 doc 상태에서 파생해야
      //      "clean 탭 아래 미저장 내용" 이 생기지 않는다.
      dirty: doc.content !== doc.savedContent,
      preview: opts?.preview ?? false,
    };
    const previewIdx = group.tabs.findIndex((t) => t.preview);
    if (tab.preview && previewIdx !== -1) {
      group.tabs.splice(previewIdx, 1, tab);
    } else {
      group.tabs.push(tab);
    }
    group.activeTabId = tab.id;
    editors.activeGroupId = group.id;
    if (opts?.focus !== false) editors.pendingFocus = true;
    return true;
  }

  /** 파일을 열고 지정 라인으로 이동 (검색 결과 클릭). line 은 1-based. */
  async function openFileAt(path: string, line: number): Promise<void> {
    // 열기 실패 시 reveal 을 남기면 다음 성공적 열기 때 엉뚱한 스크롤이 튄다
    if (!(await openFile(path, { preview: true }))) return;
    editors.pendingReveal = { path, line };
  }

  /** SCM 에서 diff 탭 열기 (original: HEAD, modified: 워킹트리) */
  async function openDiff(path: string): Promise<void> {
    let doc: Doc;
    try {
      doc = await ensureDoc(path);
    } catch (e) {
      notify('error', `Unable to open '${baseName(path)}': ${errText(e)}`);
      return;
    }
    const group = activeGroup();
    const id = `diff:${path}`;
    if (!group.tabs.some((t) => t.id === id)) {
      group.tabs.push({
        kind: 'diff', id, path, name: `${baseName(path)} (Working Tree)`,
        dirty: doc.content !== doc.savedContent, preview: false,
      });
    }
    group.activeTabId = id;
    editors.pendingFocus = true;
  }

  function setActiveTab(groupId: number, tabId: string): void {
    const group = editors.groups.find((g) => g.id === groupId);
    if (!group) return;
    group.activeTabId = tabId;
    editors.activeGroupId = groupId;
    editors.pendingFocus = true;
  }

  /** preview 탭 고정 — 탭 더블클릭 (VS Code 동일) */
  function pinTab(groupId: number, tabId: string): void {
    const tab = editors.groups.find((g) => g.id === groupId)?.tabs.find((t) => t.id === tabId);
    if (tab) tab.preview = false;
  }

  /** 새 그룹을 ref 그룹의 상하좌우에 배치 — 같은 방향 분기면 형제로 끼우고, 아니면 리프를 분기로 바꾼다 */
  function insertIntoLayout(refGroupId: number, newGroupId: number, side: SplitSide): void {
    const dir = side === 'left' || side === 'right' ? 'row' : 'column';
    const before = side === 'left' || side === 'up';
    const visit = (node: LayoutNode, parent: LayoutBranch | null): boolean => {
      if (node === refGroupId) {
        if (parent && parent.dir === dir) {
          const i = parent.children.indexOf(node);
          // 새 그룹은 ref 공간의 절반을 가져간다 (VS Code 동일)
          const sizes = parent.sizes ?? parent.children.map(() => 1);
          const half = sizes[i] / 2;
          sizes[i] = half;
          sizes.splice(before ? i : i + 1, 0, half);
          parent.children.splice(before ? i : i + 1, 0, newGroupId);
          parent.sizes = sizes;
        } else {
          const branch: LayoutNode = { dir, children: before ? [newGroupId, refGroupId] : [refGroupId, newGroupId] };
          if (parent) parent.children.splice(parent.children.indexOf(node), 1, branch);
          else editors.layout = branch;
        }
        return true;
      }
      return typeof node !== 'number' && node.children.some((c) => visit(c, node));
    };
    visit(editors.layout, null);
  }

  /** 그룹을 배치 트리에서 제거 — 자식이 하나 남은 분기는 그 자식으로 평탄화한다.
   *  제거된 몫은 남은 형제들에 비례 배분된다 (flex 재정규화) */
  function removeFromLayout(groupId: number): void {
    const walk = (node: LayoutNode): LayoutNode | null => {
      if (typeof node === 'number') return node === groupId ? null : node;
      const children: LayoutNode[] = [];
      const sizes: number[] = [];
      node.children.forEach((c, i) => {
        const kept = walk(c);
        if (kept !== null) {
          children.push(kept);
          sizes.push(node.sizes?.[i] ?? 1);
        }
      });
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { dir: node.dir, children, sizes };
    };
    editors.layout = walk(editors.layout) ?? editors.groups[0]?.id ?? 0;
  }

  /** 탐색기 드래그 드롭 — 파일을 refGroupId 의 상하좌우(side) 새 그룹에 연다 */
  async function openFileSplit(path: string, refGroupId: number, side: SplitSide): Promise<void> {
    const ref = editors.groups.find((g) => g.id === refGroupId);
    if (!ref) return;
    const group: EditorGroup = { id: nextGroupId++, tabs: [], activeTabId: null };
    editors.groups.splice(editors.groups.indexOf(ref) + 1, 0, group);
    insertIntoLayout(refGroupId, group.id, side);
    // 읽기 실패 시 빈 그룹 잔재를 남기지 않는다
    if (!(await openFile(path, { groupId: group.id }))) collapseIfEmpty(group.id);
  }

  /** 그룹에서 탭을 떼어낸다 — 활성 탭이었으면 이웃(같은 인덱스, 없으면 왼쪽)으로 활성 이동 */
  function takeTab(groupId: number, tabId: string): Tab | null {
    const group = editors.groups.find((g) => g.id === groupId);
    if (!group) return null;
    const idx = group.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return null;
    const [tab] = group.tabs.splice(idx, 1);
    if (group.activeTabId === tabId) {
      const next = group.tabs[Math.min(idx, group.tabs.length - 1)];
      group.activeTabId = next?.id ?? null;
    }
    return tab;
  }

  // WHY: VS Code 는 마지막 탭이 빠진 분할 그룹을 자동으로 접는다. 그룹이 하나뿐이면 빈 상태로 남긴다.
  function collapseIfEmpty(groupId: number): void {
    const group = editors.groups.find((g) => g.id === groupId);
    if (!group || group.tabs.length !== 0 || editors.groups.length <= 1) return;
    const gIdx = editors.groups.indexOf(group);
    editors.groups.splice(gIdx, 1);
    removeFromLayout(group.id);
    // 접힌 그룹의 이웃(왼쪽 우선)으로 포커스 이동 — 항상 마지막 그룹으로 가지 않는다
    if (editors.activeGroupId === group.id) {
      editors.activeGroupId = editors.groups[Math.max(0, gIdx - 1)].id;
    }
  }

  /** force: 확인 대화상자를 거치지 않는 닫기 — confirm 처리부·삭제(closePathTabs)가 쓴다 */
  function closeTab(groupId: number, tabId: string, force = false): void {
    if (!force) {
      const target = editors.groups.find((g) => g.id === groupId)?.tabs.find((t) => t.id === tabId);
      if (!target) return;
      const doc = editors.docs.get(target.path);
      // 같은 문서를 보는 다른 탭(diff 포함)이 남으면 버퍼는 계속 보이는 중 — 확인 불요
      const refs = editors.groups.reduce(
        (n, g) => n + g.tabs.filter((t) => t.path === target.path).length,
        0,
      );
      if (doc && doc.content !== doc.savedContent && refs === 1) {
        editors.closeConfirm = { groupId, tabId, path: target.path };
        return;
      }
    }
    const tab = takeTab(groupId, tabId);
    if (!tab) return;
    editors.recentlyClosed.push({ kind: tab.kind, path: tab.path });
    if (editors.recentlyClosed.length > RECENTLY_CLOSED_CAP) editors.recentlyClosed.shift();
    collapseIfEmpty(groupId);
  }

  /** 닫기 확인 Save — 저장 성공 시에만 닫는다 (실패·충돌은 탭 유지, 충돌은 토스트가 이어받는다) */
  async function confirmCloseSave(): Promise<void> {
    const c = editors.closeConfirm;
    if (!c) return;
    editors.closeConfirm = null;
    if (await saveDoc(c.path)) closeTab(c.groupId, c.tabId, true);
  }

  /** 닫기 확인 Don't Save — 버퍼·monaco 모델을 버려 다음 열기가 디스크를 읽게 한다 */
  function confirmCloseDiscard(): void {
    const c = editors.closeConfirm;
    if (!c) return;
    editors.closeConfirm = null;
    editors.docs.delete(c.path);
    editors.orphaned.delete(c.path);
    disposeModelsHook(c.path);
    closeTab(c.groupId, c.tabId, true);
  }

  function confirmCloseCancel(): void {
    editors.closeConfirm = null;
  }

  /** 마지막으로 닫은 탭 복원 (Ctrl+Shift+T) — 활성 그룹에 고정 탭으로 연다.
   *  열기 실패(삭제된 파일 등)는 openFile/openDiff 가 notify 한다 — 이력에서는 소모된다 */
  async function reopenClosedEditor(): Promise<void> {
    const entry = editors.recentlyClosed.pop();
    if (!entry) return;
    if (entry.kind === 'diff') await openDiff(entry.path);
    else await openFile(entry.path);
  }

  /** 탭 드래그 드롭 — 다른 그룹의 index 위치로 이동(생략 시 끝), 같은 그룹이면 순서 변경.
   *  이동·재배열하면 preview 해제 (VS Code 동일) */
  function moveTabToGroup(fromGroupId: number, tabId: string, toGroupId: number, index?: number): void {
    const to = editors.groups.find((g) => g.id === toGroupId);
    if (!to) return;
    if (fromGroupId === toGroupId) {
      const from = to.tabs.findIndex((t) => t.id === tabId);
      if (from === -1) return;
      let insert = Math.min(index ?? to.tabs.length, to.tabs.length);
      const [tab] = to.tabs.splice(from, 1);
      // 자기 자신을 뺀 만큼 삽입 지점이 당겨진다
      if (from < insert) insert -= 1;
      tab.preview = false;
      to.tabs.splice(insert, 0, tab);
      to.activeTabId = tab.id;
      editors.activeGroupId = toGroupId;
      return;
    }
    const tab = takeTab(fromGroupId, tabId);
    if (!tab) return;
    tab.preview = false;
    // 대상 그룹에 같은 탭이 이미 있으면 합류 — 원 그룹 것은 이미 뗐으니 활성화만 한다
    if (!to.tabs.some((t) => t.id === tab.id)) {
      to.tabs.splice(Math.min(index ?? to.tabs.length, to.tabs.length), 0, tab);
    }
    to.activeTabId = tab.id;
    editors.activeGroupId = toGroupId;
    editors.pendingFocus = true;
    collapseIfEmpty(fromGroupId);
  }

  /** 탭 드래그 드롭 — refGroupId 의 상하좌우(side) 새 그룹으로 분리 */
  function moveTabSplit(fromGroupId: number, tabId: string, refGroupId: number, side: SplitSide): void {
    const ref = editors.groups.find((g) => g.id === refGroupId);
    if (!ref) return;
    // 단일 탭 그룹의 자기 분리는 결과가 제자리 — no-op
    if (fromGroupId === refGroupId && ref.tabs.length === 1) return;
    const tab = takeTab(fromGroupId, tabId);
    if (!tab) return;
    tab.preview = false;
    const group: EditorGroup = { id: nextGroupId++, tabs: [tab], activeTabId: tab.id };
    editors.groups.splice(editors.groups.indexOf(ref) + 1, 0, group);
    insertIntoLayout(refGroupId, group.id, side);
    editors.activeGroupId = group.id;
    editors.pendingFocus = true;
    collapseIfEmpty(fromGroupId);
  }

  /** 활성 탭을 오른쪽 새 그룹으로 분할 (Ctrl+\). diff 탭이면 대상 파일을 연다. */
  async function splitActiveEditor(): Promise<void> {
    const tab = activeTab();
    if (!tab) return;
    const ref = activeGroup();
    const group: EditorGroup = { id: nextGroupId++, tabs: [], activeTabId: null };
    editors.groups.splice(editors.groups.indexOf(ref) + 1, 0, group);
    insertIntoLayout(ref.id, group.id, 'right');
    await openFile(tab.path, { groupId: group.id });
  }

  function updateContent(path: string, content: string): void {
    const doc = editors.docs.get(path);
    if (!doc) return;
    doc.content = content;
    const dirty = doc.content !== doc.savedContent;
    for (const g of editors.groups) {
      for (const t of g.tabs) {
        if (t.path === path) {
          t.dirty = dirty;
          if (dirty) t.preview = false;
        }
      }
    }
  }

  /** 외부 삭제 표시 토글 — watch 의 실존 재검증이 세우고, 재생성·저장 성공이 내린다 */
  function setOrphaned(path: string, on: boolean): void {
    if (on) editors.orphaned.add(path);
    else editors.orphaned.delete(path);
  }

  /**
   * rename 반영 — from(파일 또는 디렉토리) 아래의 열린 문서·탭 경로를 to 로 이관한다.
   * 내용·dirty·etag 유지 (rename 은 mtime·size 를 안 바꾸므로 etag 가 계속 유효하다).
   */
  function remapPaths(from: string, to: string): void {
    const mapPath = (p: string) =>
      p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null;
    for (const [path, doc] of [...editors.docs]) {
      const np = mapPath(path);
      if (np === null) continue;
      editors.docs.delete(path);
      editors.docs.set(np, doc);
    }
    disposeModelsHook(from);
    for (const g of editors.groups) {
      for (const t of g.tabs) {
        const np = mapPath(t.path);
        if (np === null) continue;
        const newId = t.kind === 'diff' ? `diff:${np}` : np;
        if (g.activeTabId === t.id) g.activeTabId = newId;
        t.id = newId;
        t.path = np;
        t.name = t.kind === 'diff' ? `${baseName(np)} (Working Tree)` : baseName(np);
      }
    }
    if (editors.saveConflict !== null) {
      const np = mapPath(editors.saveConflict);
      if (np !== null) editors.saveConflict = np;
    }
    for (const p of [...editors.orphaned]) {
      const np = mapPath(p);
      if (np !== null) {
        editors.orphaned.delete(p);
        editors.orphaned.add(np);
      }
    }
  }

  /**
   * 앱 내 삭제 반영 — path(디렉토리면 하위 포함)의 탭을 모든 그룹에서 닫고 문서·모델을
   * 버린다. 외부 삭제(탭 유지, closeOnFileDelete=false)와 달리 앱 내 삭제는 닫는 것이
   * VS Code 동일 — dirty 경고는 삭제 confirm 이 겸한다.
   */
  function closePathTabs(path: string): void {
    const match = (p: string) => p === path || p.startsWith(`${path}/`);
    for (const g of [...editors.groups]) {
      for (const t of [...g.tabs]) {
        // force — 삭제는 이미 confirm 을 거쳤다 (dirty 경고는 삭제 confirm 이 겸한다)
        if (match(t.path)) closeTab(g.id, t.id, true);
      }
    }
    for (const p of [...editors.docs.keys()]) {
      if (match(p)) editors.docs.delete(p);
    }
    disposeModelsHook(path);
    if (editors.saveConflict !== null && match(editors.saveConflict)) editors.saveConflict = null;
    for (const p of [...editors.orphaned]) if (match(p)) editors.orphaned.delete(p);
  }

  /**
   * 외부(디스크) 변경 반영. 깨끗한 문서만 조용히 재로드한다 — dirty 는 안 건드리고
   * 충돌은 저장 시점 검사로 일원화한다 (VS Code 동일).
   */
  function reloadDocFromDisk(path: string, content: string, etag: string): void {
    const doc = editors.docs.get(path);
    if (!doc || doc.content !== doc.savedContent) return;
    // 내용이 같아도(touch, 같은 내용 재저장) etag 는 갱신 — 다음 저장의 스퓨리어스 충돌 방지
    doc.etag = etag;
    if (doc.savedContent === content) return;
    doc.savedContent = content;
    applyExternalEditHook(path, content);
    // 모델 편집이 change 리스너로 이미 갱신했어도 무해(같은 값) — 모델이 없던 경우를 커버한다
    updateContent(path, content);
  }

  /** 미저장 문서 존재 여부 — 탭 닫힘(beforeunload) 안전망 판정용 */
  function hasDirtyDocs(): boolean {
    for (const doc of editors.docs.values()) {
      if (doc.content !== doc.savedContent) return true;
    }
    return false;
  }

  /** 문서 저장의 실체 — 활성 탭 저장(saveActive)과 닫기 확인 Save 가 공유한다.
   *  @returns 저장 완료 여부 — 실패·충돌·경합(rename)은 false */
  async function saveDoc(path: string): Promise<boolean> {
    const doc = editors.docs.get(path);
    if (!doc || doc.content === doc.savedContent) return true;
    // WHY: await 중 타이핑되면 doc.content 가 앞서간다 — 실제 쓴 내용만 saved 로 표시해야
    //      "저장됨으로 보이는 미저장 편집" 이 안 생긴다
    const content = doc.content;
    let r: WriteResult;
    try {
      r = await backend.writeFile(path, content, doc.etag);
    } catch (e) {
      notify('error', `Failed to save '${baseName(path)}': ${errText(e)}`);
      return false;
    }
    // WHY: 왕복 중 rename 되면(remapPaths 가 docs 키를 옮긴다) 이 결과는 옛 경로 것이다 —
    //      saved 로 표시하면 새 경로의 더티를 잃는다. 버리면 다음 저장이 새 경로로 다시 쓴다.
    if (editors.docs.get(path) !== doc) return false;
    if (r.conflict) {
      editors.saveConflict = path;
      return false;
    }
    doc.etag = r.etag;
    doc.savedContent = content;
    updateContent(path, doc.content);
    // orphan 저장 = 부활 (데몬 writeFile 은 대상 부재 시 그냥 쓴다) — 표시 즉시 해제
    editors.orphaned.delete(path);
    return true;
  }

  async function saveActive(): Promise<void> {
    // diff 탭의 modified 쪽 편집도 같은 문서이므로 kind 와 무관하게 저장한다
    const tab = activeTab();
    if (!tab) return;
    await saveDoc(tab.path);
  }

  /** 충돌 토스트의 Overwrite — etag 없이 다시 써서 디스크를 내 버퍼로 덮는다 */
  async function overwriteConflict(): Promise<void> {
    const path = editors.saveConflict;
    const doc = path ? editors.docs.get(path) : null;
    if (!path || !doc) {
      editors.saveConflict = null;
      return;
    }
    const content = doc.content;
    try {
      const r = await backend.writeFile(path, content);
      if (r.etag === undefined) return; // etag 생략 시 conflict 는 안 온다 — 타입 좁히기용
      doc.etag = r.etag;
      doc.savedContent = content;
      // WHY: await 중 타이핑되면 doc.content 가 앞서 있다 — 스냅샷을 넘기면 버퍼가 되감긴다
      updateContent(path, doc.content);
      editors.saveConflict = null;
      editors.orphaned.delete(path);
    } catch (e) {
      // 충돌 토스트는 남겨 재시도할 수 있게 둔다
      notify('error', `Failed to save '${baseName(path)}': ${errText(e)}`);
    }
  }

  /** 충돌 토스트의 Revert — 버퍼를 버리고 디스크 내용으로 강제 재로드한다 (dirty 무관) */
  async function revertConflict(): Promise<void> {
    const path = editors.saveConflict;
    const doc = path ? editors.docs.get(path) : null;
    if (!path || !doc) {
      editors.saveConflict = null;
      return;
    }
    try {
      const { content, etag } = await backend.readFile(path);
      doc.etag = etag;
      doc.savedContent = content;
      applyExternalEditHook(path, content);
      updateContent(path, content);
      editors.saveConflict = null;
      editors.orphaned.delete(path); // 읽혔다 = 디스크에 있다
    } catch (e) {
      // 충돌 토스트는 남긴다 — Overwrite 로 되살리는 길이 남는다
      notify('error', `Failed to revert '${baseName(path)}': ${errText(e)}`);
    }
  }

  /** 들여쓰기 감지: 최소 양수 선행 공백 (VS Code detectIndentation 근사) */
  function indentOf(path: string): number {
    const doc = editors.docs.get(path);
    if (!doc) return 4;
    let min = Infinity;
    for (const line of doc.content.split('\n')) {
      const m = line.match(/^( +)\S/);
      if (m) min = Math.min(min, m[1].length);
    }
    return Number.isFinite(min) ? min : 4;
  }

  return {
    editors, activeGroup, activeTab, openFile, openFileAt, openDiff, setActiveTab, pinTab,
    openFileSplit, closeTab, confirmCloseSave, confirmCloseDiscard, confirmCloseCancel,
    reopenClosedEditor, moveTabToGroup, moveTabSplit,
    splitActiveEditor, updateContent, setOrphaned, remapPaths, closePathTabs,
    reloadDocFromDisk, hasDirtyDocs, saveActive, overwriteConflict, revertConflict, indentOf,
  };
}

/** 분할 경계 드래그 — 경계(boundary) 앞뒤 자식의 비율만 재분배한다 (둘의 합 보존).
 *  startSizes 는 드래그 시작 스냅샷, deltaPx 는 시작점 기준 누적 (Sash 계약과 동일) */
export function resizeSplit(
  branch: LayoutBranch, boundary: number, startSizes: number[],
  deltaPx: number, totalPx: number, minPx: number,
): void {
  const a = boundary - 1;
  const b = boundary;
  const sum = startSizes.reduce((x, y) => x + y, 0);
  const frac = (deltaPx / totalPx) * sum;
  const minFrac = (minPx / totalPx) * sum;
  const pair = startSizes[a] + startSizes[b];
  const next = Math.min(pair - minFrac, Math.max(minFrac, startSizes[a] + frac));
  branch.sizes = startSizes.map((s, i) => (i === a ? next : i === b ? pair - next : s));
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', js: 'javascript', json: 'json', md: 'markdown',
  css: 'css', html: 'html', sh: 'shell', gitignore: 'ignore',
};

export function languageOf(path: string): string {
  const name = baseName(path);
  const ext = name.startsWith('.') ? name.slice(1) : name.slice(name.lastIndexOf('.') + 1);
  return LANGUAGES[ext] ?? 'plaintext';
}

/** statusbar 라벨용 표시 이름 */
export function languageLabel(path: string): string {
  const id = languageOf(path);
  const labels: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown',
    css: 'CSS', html: 'HTML', shell: 'Shell Script', ignore: 'Ignore', plaintext: 'Plain Text',
  };
  return labels[id] ?? id;
}

// ---- 활성 세션 전달 shim — UI·커맨드는 종전 이름 그대로 활성 세션에 작용한다

export const editors = viewOf(() => ctx().editors.editors);
export const activeGroup = (): EditorGroup => ctx().editors.activeGroup();
export const activeTab = (): Tab | null => ctx().editors.activeTab();
export const openFile = (
  path: string, opts?: { preview?: boolean; groupId?: number; focus?: boolean },
): Promise<boolean> => ctx().editors.openFile(path, opts);
export const openFileAt = (path: string, line: number): Promise<void> =>
  ctx().editors.openFileAt(path, line);
export const openDiff = (path: string): Promise<void> => ctx().editors.openDiff(path);
export const setActiveTab = (groupId: number, tabId: string): void =>
  ctx().editors.setActiveTab(groupId, tabId);
export const pinTab = (groupId: number, tabId: string): void => ctx().editors.pinTab(groupId, tabId);
export const openFileSplit = (path: string, refGroupId: number, side: SplitSide): Promise<void> =>
  ctx().editors.openFileSplit(path, refGroupId, side);
export const closeTab = (groupId: number, tabId: string, force = false): void =>
  ctx().editors.closeTab(groupId, tabId, force);
export const confirmCloseSave = (): Promise<void> => ctx().editors.confirmCloseSave();
export const confirmCloseDiscard = (): void => ctx().editors.confirmCloseDiscard();
export const confirmCloseCancel = (): void => ctx().editors.confirmCloseCancel();
export const reopenClosedEditor = (): Promise<void> => ctx().editors.reopenClosedEditor();
export const moveTabToGroup = (fromGroupId: number, tabId: string, toGroupId: number, index?: number): void =>
  ctx().editors.moveTabToGroup(fromGroupId, tabId, toGroupId, index);
export const moveTabSplit = (fromGroupId: number, tabId: string, refGroupId: number, side: SplitSide): void =>
  ctx().editors.moveTabSplit(fromGroupId, tabId, refGroupId, side);
export const splitActiveEditor = (): Promise<void> => ctx().editors.splitActiveEditor();
export const updateContent = (path: string, content: string): void =>
  ctx().editors.updateContent(path, content);
export const setOrphaned = (path: string, on: boolean): void => ctx().editors.setOrphaned(path, on);
export const remapPaths = (from: string, to: string): void => ctx().editors.remapPaths(from, to);
export const closePathTabs = (path: string): void => ctx().editors.closePathTabs(path);
export const reloadDocFromDisk = (path: string, content: string, etag: string): void =>
  ctx().editors.reloadDocFromDisk(path, content, etag);
export const hasDirtyDocs = (): boolean => ctx().editors.hasDirtyDocs();
export const saveActive = (): Promise<void> => ctx().editors.saveActive();
export const overwriteConflict = (): Promise<void> => ctx().editors.overwriteConflict();
export const revertConflict = (): Promise<void> => ctx().editors.revertConflict();
export const indentOf = (path: string): number => ctx().editors.indentOf(path);
