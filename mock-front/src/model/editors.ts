import { reactive } from '@vue/reactivity';
import { backend } from './host';

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

interface Doc {
  content: string;
  savedContent: string;
  /** savedContent 가 읽힌/쓰인 시점의 디스크 etag — 저장 시 낙관적 충돌 검사에 쓴다 */
  etag: string;
}

let nextGroupId = 1;

export const editors = reactive({
  groups: [{ id: 0, tabs: [], activeTabId: null }] as EditorGroup[],
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
});

export function activeGroup(): EditorGroup {
  return editors.groups.find((g) => g.id === editors.activeGroupId) ?? editors.groups[0];
}

export function activeTab(): Tab | null {
  const g = activeGroup();
  return g.tabs.find((t) => t.id === g.activeTabId) ?? null;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
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
export async function openFile(path: string, opts?: { preview?: boolean; groupId?: number }): Promise<void> {
  const doc = await ensureDoc(path);
  const group = opts?.groupId !== undefined
    ? editors.groups.find((g) => g.id === opts.groupId) ?? activeGroup()
    : activeGroup();

  const existing = group.tabs.find((t) => t.id === path);
  if (existing) {
    if (!opts?.preview) existing.preview = false;
    group.activeTabId = existing.id;
    editors.activeGroupId = group.id;
    return;
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
}

/** 파일을 열고 지정 라인으로 이동 (검색 결과 클릭). line 은 1-based. */
export async function openFileAt(path: string, line: number): Promise<void> {
  await openFile(path, { preview: true });
  editors.pendingReveal = { path, line };
}

/** SCM 에서 diff 탭 열기 (original: HEAD, modified: 워킹트리) */
export async function openDiff(path: string): Promise<void> {
  const doc = await ensureDoc(path);
  const group = activeGroup();
  const id = `diff:${path}`;
  if (!group.tabs.some((t) => t.id === id)) {
    group.tabs.push({
      kind: 'diff', id, path, name: `${baseName(path)} (Working Tree)`,
      dirty: doc.content !== doc.savedContent, preview: false,
    });
  }
  group.activeTabId = id;
}

export function setActiveTab(groupId: number, tabId: string): void {
  const group = editors.groups.find((g) => g.id === groupId);
  if (!group) return;
  group.activeTabId = tabId;
  editors.activeGroupId = groupId;
}

export function closeTab(groupId: number, tabId: string): void {
  const group = editors.groups.find((g) => g.id === groupId);
  if (!group) return;
  const idx = group.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  group.tabs.splice(idx, 1);
  if (group.activeTabId === tabId) {
    const next = group.tabs[Math.min(idx, group.tabs.length - 1)];
    group.activeTabId = next?.id ?? null;
  }
  // WHY: VS Code 는 마지막 탭이 닫힌 분할 그룹을 자동으로 접는다. 그룹이 하나뿐이면 빈 상태로 남긴다.
  if (group.tabs.length === 0 && editors.groups.length > 1) {
    const gIdx = editors.groups.indexOf(group);
    editors.groups.splice(gIdx, 1);
    // 닫힌 그룹의 이웃(왼쪽 우선)으로 포커스 이동 — 항상 마지막 그룹으로 가지 않는다
    if (editors.activeGroupId === group.id) {
      editors.activeGroupId = editors.groups[Math.max(0, gIdx - 1)].id;
    }
  }
}

/** 활성 탭을 오른쪽 새 그룹으로 분할 (Ctrl+\). diff 탭이면 대상 파일을 연다. */
export async function splitActiveEditor(): Promise<void> {
  const tab = activeTab();
  if (!tab) return;
  const group: EditorGroup = { id: nextGroupId++, tabs: [], activeTabId: null };
  editors.groups.splice(editors.groups.indexOf(activeGroup()) + 1, 0, group);
  await openFile(tab.path, { groupId: group.id });
}

export function updateContent(path: string, content: string): void {
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

/**
 * 외부 변경을 열린 monaco 모델에 편집으로 반영하는 훅 — ui/editor/monaco.ts 가 등록한다.
 * (model 계층이 UI 를 모른 채 재로드를 완결하기 위한 seam)
 */
let applyExternalEdit: ((path: string, content: string) => void) | null = null;
export function setApplyExternalEdit(fn: (path: string, content: string) => void): void {
  applyExternalEdit = fn;
}

/**
 * 외부(디스크) 변경 반영. 깨끗한 문서만 조용히 재로드한다 — dirty 는 안 건드리고
 * 충돌은 저장 시점 검사로 일원화한다 (VS Code 동일).
 */
export function reloadDocFromDisk(path: string, content: string, etag: string): void {
  const doc = editors.docs.get(path);
  if (!doc || doc.content !== doc.savedContent) return;
  // 내용이 같아도(touch, 같은 내용 재저장) etag 는 갱신 — 다음 저장의 스퓨리어스 충돌 방지
  doc.etag = etag;
  if (doc.savedContent === content) return;
  doc.savedContent = content;
  applyExternalEdit?.(path, content);
  // 모델 편집이 change 리스너로 이미 갱신했어도 무해(같은 값) — 모델이 없던 경우를 커버한다
  updateContent(path, content);
}

export async function saveActive(): Promise<void> {
  // diff 탭의 modified 쪽 편집도 같은 문서이므로 kind 와 무관하게 저장한다
  const tab = activeTab();
  if (!tab) return;
  const doc = editors.docs.get(tab.path);
  if (!doc || doc.content === doc.savedContent) return;
  // WHY: await 중 타이핑되면 doc.content 가 앞서간다 — 실제 쓴 내용만 saved 로 표시해야
  //      "저장됨으로 보이는 미저장 편집" 이 안 생긴다
  const content = doc.content;
  const r = await backend.writeFile(tab.path, content, doc.etag);
  if (r.conflict) {
    editors.saveConflict = tab.path;
    return;
  }
  doc.etag = r.etag;
  doc.savedContent = content;
  updateContent(tab.path, doc.content);
}

/** 충돌 토스트의 Overwrite — etag 없이 다시 써서 디스크를 내 버퍼로 덮는다 */
export async function overwriteConflict(): Promise<void> {
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
  } catch {
    // 쓰기 실패(권한, 연결 끊김) — 토스트를 남겨 재시도할 수 있게 둔다
  }
}

/** 충돌 토스트의 Revert — 버퍼를 버리고 디스크 내용으로 강제 재로드한다 (dirty 무관) */
export async function revertConflict(): Promise<void> {
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
    applyExternalEdit?.(path, content);
    updateContent(path, content);
    editors.saveConflict = null;
  } catch {
    // 읽기 실패(외부 삭제 등) — 토스트를 남긴다 (Overwrite 로 되살리는 길이 남는다)
  }
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

/** 들여쓰기 감지: 최소 양수 선행 공백 (VS Code detectIndentation 근사) */
export function indentOf(path: string): number {
  const doc = editors.docs.get(path);
  if (!doc) return 4;
  let min = Infinity;
  for (const line of doc.content.split('\n')) {
    const m = line.match(/^( +)\S/);
    if (m) min = Math.min(min, m[1].length);
  }
  return Number.isFinite(min) ? min : 4;
}
