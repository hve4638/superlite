import { markRaw, reactive } from '@vue/reactivity';
import type { FileContent, ThinBackend, Unopenable, WriteResult } from '../backend/types';
import { ctx, viewOf } from './ctx';
import { errText, notify } from './notifications';
import { configLabel, configReadOnly, isConfigPath, readConfig, writeConfig } from './configfiles';
import { confirm } from './dialog';

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
  /** 워킹트리에서 지워진 파일 — diff 가 아니라 HEAD 내용을 읽기 전용 편집기로 보여 준다 (문서 없음, dirty 불가) */
  deleted?: boolean;
  /** 커밋 diff (ticket scm-commit-detail) — 이 해시의 부모 대비 diff. 양쪽 다 git 내용이라 문서가 없고
   *  읽기 전용이며 id 는 'diff:'+hash+':'+path (같은 파일의 워킹트리 diff 와 공존). rename 이관 대상 아님 */
  commit?: string;
  /** commit 과 함께 — 이름 변경된 파일의 부모 시점 경로 (original 쪽). 없으면 path */
  from?: string;
}

/** hex 뷰어 탭 — 바이트는 docs 가 아니라 editors.hex 에 산다 (텍스트 문서와 공존). 편집 없음 */
export interface HexTab {
  kind: 'hex';
  /** 'hex:'+path */
  id: string;
  path: string;
  /** "x (Hex)" */
  name: string;
  dirty: boolean;
  preview: boolean;
}

/** HTML 프리뷰 탭 — 같은 path 의 doc 을 공유하되 savedContent(저장분)만 그린다 (편집 버퍼는 반영하지 않는다). 편집 없음 */
export interface PreviewTab {
  kind: 'preview';
  /** 'preview:'+path */
  id: string;
  path: string;
  /** "Preview x" */
  name: string;
  dirty: boolean;
  preview: boolean;
}

/** 터미널 탭 — 하단 패널 대신 편집기 탭에 산다 (terminal-usability). 문서 없음(path ''),
 *  본체는 model/terminal 의 인스턴스(term = 인스턴스 id, 페이지 전역 유일). dirty·preview·복원 이력 없음 */
export interface TerminalTab {
  kind: 'terminal';
  /** 'terminal:'+term */
  id: string;
  /** 문서가 없다 — 경로 키 맵·rename·삭제 경로가 자연히 비껴간다 */
  path: '';
  /** 셸 이름 */
  name: string;
  dirty: false;
  preview: false;
  term: number;
}

/** 폴더 탭 — 탐색기 폴더를 메인 영역으로 끌어오면 yazi 식 3열(부모/현재/미리보기) 탐색 화면이
 *  탭으로 열린다 (explorer-folder-tab). path 는 현재 폴더('' = 루트) — 탭 안 이동(navigateFolderTab)이
 *  id·path·name 을 같이 바꾼다. 문서 없음, dirty·preview 없음. 커서는 path 키 folderView 맵 */
export interface FolderTab {
  kind: 'folder';
  /** 'folder:'+path */
  id: string;
  path: string;
  /** 폴더명 (루트는 '/') */
  name: string;
  dirty: boolean;
  preview: boolean;
  /** 보기 스타일 — columns(yazi 3열) / details(Windows 탐색기 자세히) / icons(큰 아이콘). 탭마다, 새 탭은 folderPrefs.style */
  style: FolderStyle;
  /** 뒤로/앞으로 이력 (탭 단위) — history[histIndex] 가 현재 path */
  history: string[];
  histIndex: number;
  /** 정렬 (details·icons) — columns 는 항상 이름순 */
  sort: { key: FolderSortKey; asc: boolean };
}
export type FolderStyle = 'columns' | 'details' | 'icons';
export type FolderSortKey = 'name' | 'mtime' | 'type' | 'size';

/** URL 탭 — sandbox iframe 으로 임의 URL 을 띄운다 (ticket browser-tab-iframe, dev 서버 미리보기 용도).
 *  문서 없음(path ''). id 는 탭마다 유일('url:'+난수) — url 은 주소칸 입력으로 바뀌므로 id 에 넣지 않는다.
 *  url 은 사용자가 입력한 값('' = 빈 탭, 주소칸만) — iframe 안에서 링크를 따라간 현재 URL 은 cross-origin 이라
 *  읽을 수 없어 추적하지 않는다 (browser-tab-full 의 자식 웹뷰 몫). 창 이동·워크스페이스 복원에는 이 값이 실린다 */
export interface UrlTab {
  kind: 'url';
  /** 'url:'+난수 */
  id: string;
  path: '';
  /** 주소칸 값에서 스킴을 뗀 것, 빈 탭은 'New Tab' */
  name: string;
  dirty: boolean;
  preview: boolean;
  url: string;
}

export type Tab = FileTab | DiffTab | HexTab | PreviewTab | TerminalTab | FolderTab | UrlTab;

/** hex 뷰어 청크 크기 — 범위 읽기(readFile offset) 단위. 4KB 이상이라 항상 payload 프레임으로 온다 */
export const HEX_CHUNK = 64 * 1024;
/** 경로당 캐시 청크 상한 — 넘으면 가장 오래된 것부터 버린다 (GB 파일 스크롤에도 메모리 상수) */
const HEX_CHUNK_CAP = 64;

/** hex 뷰어 문서 — 전체 크기(stat)와 읽어 둔 청크(인덱스 → 바이트). 편집 없음 */
export interface HexDoc {
  size: number;
  chunks: Map<number, Uint8Array>;
}

/** URL 탭 이름 — 스킴을 뗀 주소, 빈 주소는 'New Tab' */
export function urlTabName(url: string): string {
  return url === '' ? 'New Tab' : url.replace(/^https?:\/\//, '');
}

/** 탭 id 규칙 — kind 별 접두 (file 은 path 그대로) */
export function tabIdOf(kind: Tab['kind'], path: string): string {
  return kind === 'file' ? path : `${kind}:${path}`;
}

/** 탭 라벨 규칙 — diff 는 호출측이 상태 접미를 붙인다. 클라이언트 설정 파일(configfiles)은 종류·프로필명 */
export function tabNameOf(kind: Tab['kind'], path: string): string {
  if (kind === 'file' && isConfigPath(path)) return configLabel(path);
  const base = baseName(path);
  if (kind === 'folder') return base || '/';
  return kind === 'hex' ? `${base} (Hex)` : kind === 'preview' ? `Preview ${base}` : base;
}

export interface EditorGroup {
  id: number;
  tabs: Tab[];
  activeTabId: string | null;
  /** 그룹 잠금 — 다른 그룹이 마지막 탭을 잃어도 자동으로 접히지 않게 배치를 지킨다 (삭제로 인한
   *  자동 병합 방지만 — 사용자가 직접 닫거나 드래그로 재배치하는 것은 막지 않는다). 잠긴 그룹
   *  자신이 비면 종전대로 접히고 잠금도 사라진다 — 잠금은 탭이 있는 그룹에만 존재한다.
   *  스냅샷(창 이동·워크스페이스 복원)에 그대로 실린다 */
  locked?: boolean;
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

export interface Doc {
  content: string;
  savedContent: string;
  /** savedContent 가 읽힌/쓰인 시점의 디스크 etag — 저장 시 낙관적 충돌 검사에 쓴다 */
  etag: string;
  /** 열 수 없는 사유(크기 초과·이진) — 있으면 편집기 대신 안내 화면이 뜨고 content 는 '' 다.
   *  '' === '' 라 dirty 가 될 수 없어 저장 경로는 자연히 막힌다 */
  unopenable?: Unopenable;
  /** 이미지 문서의 base64 데이터 — 있으면 편집기 대신 이미지 뷰어가 뜬다.
   *  content 는 unopenable 과 같은 '' 고정이라 dirty·저장 경로가 자연히 막힌다 */
  image?: string;
  /** 읽기 전용 — 편집기가 readOnly 로 열어 dirty 가 생기지 않는다 (내장 default tmux 프로필, configfiles) */
  readOnly?: boolean;
}

const RECENTLY_CLOSED_CAP = 20;

/** 세션 탭 창 이동 핸드오프의 에디터 몫 — 그룹·배치·문서 버퍼 전부 (undo·커서는 잃는다) */
export interface EditorsSnapshot {
  groups: EditorGroup[];
  layout: LayoutNode;
  activeGroupId: number;
  nextGroupId: number;
  docs: [string, Doc][];
}

/** 에디터 탭 한 개의 창 이동 핸드오프 — 탭 + 그 문서 버퍼 (다른 탭이 같은 문서를 계속 보면
 *  출처에도 남는다). doc null = 문서가 아직 로드되지 않았던 탭 — 받는 쪽이 디스크에서 연다 */
export interface TabHandoff {
  tab: Tab;
  doc: Doc | null;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 이미지 뷰어로 여는 확장자 → MIME — VS Code 내장 Media Preview 의 이미지 세트와 동일 */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

/** 이미지 확장자면 MIME, 아니면 null — 순수 함수, 세션 무관 (svg 는 VS Code 기본대로 텍스트) */
export function imageMime(path: string): string | null {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  // dot<=0 제외 — 확장자 없는 파일·dotfile(.png 같은 이름)은 이미지가 아니다
  if (dot <= 0) return null;
  return IMAGE_MIMES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** HTML 프리뷰 대상 판별 — 순수 함수, 세션 무관 */
export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** 뷰어 자동 갱신 스위치 — 뷰어 종류별, 세션 무관 전역 (localStorage). HTML 은 재렌더가 싸서 on,
 *  PDF 는 재렌더 비용이 커서 off 가 기본 (viewer-cache-refresh). ponytail: 설정 체계(config-system)가
 *  생기면 그쪽으로 옮긴다 */
const AUTO_RELOAD_KEY = 'superlite.viewerAutoReload';
export const viewerAutoReload = reactive(loadAutoReload());
function loadAutoReload(): { html: boolean; pdf: boolean } {
  const d = { html: true, pdf: false };
  try {
    const p = JSON.parse(localStorage.getItem(AUTO_RELOAD_KEY) ?? '') as Partial<typeof d>;
    return { html: p.html ?? d.html, pdf: p.pdf ?? d.pdf };
  } catch {
    return d;
  }
}
export function toggleViewerAutoReload(kind: keyof typeof viewerAutoReload): void {
  viewerAutoReload[kind] = !viewerAutoReload[kind];
  localStorage.setItem(AUTO_RELOAD_KEY, JSON.stringify(viewerAutoReload));
}

export const EDITOR_ZOOM_MIN = 50;
export const EDITOR_ZOOM_MAX = 200;
export const EDITOR_ZOOM_STEP = 10;
// editorView 초기화가 loadWindowZoom 을 부르므로 이 셋은 그보다 위에 있어야 한다 (const TDZ — vite dev 는 모듈 순서 그대로라 부팅이 깨졌다)
const EDITOR_ZOOM_KEY = 'superlite.editorZoom';
function clampZoom(percent: number): number {
  const snapped = Math.round(percent / EDITOR_ZOOM_STEP) * EDITOR_ZOOM_STEP;
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, snapped));
}
/** 배율 저장 (편집기·터미널 공용, ticket zoom-per-window — 배율은 창마다 따로다). 창의 값은 sessionStorage 에
 *  둔다 — 창(웹뷰)마다 별도라 다른 창에 번지지 않고, 새로고침에는 남고, 창이 닫히면 사라진다. localStorage 는
 *  마지막으로 조절한 값의 사본 — 재시작 첫 창·두 번째 실행 창처럼 물려받을 부모가 없는 창의 시작값이다.
 *  분리로 생긴 새 창은 핸드오프(fontZoom)로 출처 창 값을 물려받은 뒤 독립한다 (2026-09-09 사용자 결정) */
export function loadWindowZoom(key: string): number {
  const n = Number(sessionStorage.getItem(key) ?? localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? clampZoom(n) : 100;
}
export function saveWindowZoom(key: string, percent: number): void {
  sessionStorage.setItem(key, String(percent));
  localStorage.setItem(key, String(percent));
}
/** 자동 줄바꿈 — 전 에디터 공통 뷰 상태 (VS Code Alt+Z 와 같이 세션 안에서만, 영속화 없음).
 *  zoom 은 편집기 전용 줌(퍼센트) — 웹뷰 줌(Ctrl+Shift+=, 창 단위)과 별개로 Monaco 글꼴 크기만 바꾼다.
 *  세션 무관·창 단위라 loadWindowZoom 으로 기억한다 */
export const editorView = reactive({ wordWrap: false, zoom: loadWindowZoom(EDITOR_ZOOM_KEY) });
export function toggleWordWrap(): void {
  editorView.wordWrap = !editorView.wordWrap;
}

/** 폴더 탭 기본값 — 마지막으로 고른 스타일이 새 탭의 기본, 미리보기 창(Windows 탐색기의 '미리보기 창')
 *  펼침은 전역. 세션 무관이라 localStorage (explorer-folder-tab) */
const FOLDER_PREFS_KEY = 'superlite.folderPrefs';
export const folderPrefs = reactive(loadFolderPrefs());
function loadFolderPrefs(): { style: FolderStyle; previewPane: boolean } {
  const d = { style: 'columns' as FolderStyle, previewPane: false };
  try {
    const p = JSON.parse(localStorage.getItem(FOLDER_PREFS_KEY) ?? '') as Partial<typeof d>;
    if (p.style === 'columns' || p.style === 'details' || p.style === 'icons') d.style = p.style;
    if (typeof p.previewPane === 'boolean') d.previewPane = p.previewPane;
  } catch { /* 없음·손상 — 기본값 */ }
  return d;
}
function saveFolderPrefs(): void {
  localStorage.setItem(FOLDER_PREFS_KEY, JSON.stringify(folderPrefs));
}
export function toggleFolderPreviewPane(): void {
  folderPrefs.previewPane = !folderPrefs.previewPane;
  saveFolderPrefs();
}

/** 편집기 줌 설정 — 10 단위 스냅·50~200 클램프 후 저장. MonacoHost 가 지켜보다 fontSize 갱신 */
export function setEditorZoom(percent: number): void {
  editorView.zoom = clampZoom(percent);
  saveWindowZoom(EDITOR_ZOOM_KEY, editorView.zoom);
}
export function stepEditorZoom(dir: 1 | -1): void {
  setEditorZoom(editorView.zoom + dir * EDITOR_ZOOM_STEP);
}

/** 프리뷰 수동 갱신 신호 — path 별 tick. 자동 갱신 off 인 프리뷰가 이걸 보고 iframe 을 다시 만든다 */
export const previewReloadTick = reactive(new Map<string, number>());
export function reloadPreview(path: string): void {
  previewReloadTick.set(path, (previewReloadTick.get(path) ?? 0) + 1);
}

/** base64 길이에서 원본 바이트 수 복원 — 패딩 보정 (와이어가 크기를 따로 나르지 않는다) */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
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
    /** 이미지 뷰어 상태 (path 키) — ImageView 가 세우고 statusbar 가 활성 탭 경로로 읽는다.
     *  배율(zoom)은 'fit'(영역 맞춤, 초기값) 또는 원본 대비 배율 숫자(1 = 100%, 휠 줌).
     *  뷰 상태지만 문서(docs)처럼 경로 단위 공유 — 같은 이미지를 보는 그룹들이 함께
     *  움직인다. 해상도(w·h)는 이미지 로드 시점에 채워진다 */
    imageView: new Map<string, { w: number; h: number; zoom: 'fit' | number }>(),
    /** 폴더 탭 뷰 상태 (현재 폴더 path 키) — 현재 열의 커서 항목 경로와 그 인덱스(항목이 사라지면
     *  같은 자리로 물러난다). FolderView 가 세운다. 탭 전환·재열기에도 살아 있고, rename·삭제·창 이동
     *  정리는 pathMaps 로 함께 (커서는 핸드오프에 실리지 않는다 — 받는 쪽은 첫 항목부터) */
    folderView: new Map<string, { cursor: string; index: number }>(),
    /** hex 뷰어 문서 (path 키) — docs 와 분리: 텍스트 문서·이진 unopenable 과 무관하게 같은
     *  경로를 hex 로도 볼 수 있다. HexView 가 ensureHex(크기)·loadHexChunk(보이는 범위)로
     *  채우고, 외부 변경·rename·삭제 시 비우거나 이관한다 (비우면 다음 표시가 다시 읽는다).
     *  창 이동 스냅샷에는 싣지 않는다 — 받는 쪽이 같은 경로로 다시 읽는다 */
    hex: new Map<string, HexDoc>(),
    /** 열림 직후 특정 라인으로 스크롤할 요청 (검색 결과 클릭 등). MonacoHost 가 소비 후 null 로 되돌린다. */
    pendingReveal: null as { path: string; line: number } | null,
    /** 저장 충돌(디스크가 더 새것) 중인 파일 path — 토스트가 Overwrite/Revert 를 띄운다.
     *  ponytail: 슬롯 하나 — 동시 다발 충돌은 마지막 것만 표시 (저장은 어차피 파일별 재시도) */
    saveConflict: null as string | null,
    /** 외부 삭제로 디스크에서 사라진 열린 파일 path — 탭에 strikethrough, 저장하면 부활.
     *  (탭은 유지 — VS Code closeOnFileDelete=false. 앱 내 삭제는 closePathTabs 가 닫는다) */
    orphaned: new Set<string>(),
    /** 닫은 탭 복원 이력 (최근이 뒤) — Ctrl+Shift+T 가 pop 한다 */
    recentlyClosed: [] as { kind: Tab['kind']; path: string; deleted?: boolean; commit?: string; from?: string }[],
    /** 닫기 확인 대기 — dirty 문서의 마지막 탭을 닫을 때 Save/Don't Save/Cancel 대화상자
     *  (VS Code 동일 — 조용히 닫으면 버퍼가 몰래 살아남아 "닫았는데 편집이 남는" 혼동을 낳는다) */
    /** 에디터 포커스 요청 — MonacoHost 가 소비. 트리 단일 클릭(preview)은 세우지 않아
     *  포커스가 트리에 남는다 (VS Code 동일 — Delete 가 파일 삭제로 이어져야 한다) */
    pendingFocus: false,
    /** 로드가 800ms 를 넘긴 탭 id — 그룹 본문 상단에 진행선이 뜬다 (VS Code editorOperation 의
     *  800ms 지연 progress). 파일 탭은 readFile, hex 탭은 stat·청크 읽기가 대상. 창 이동
     *  스냅샷에는 싣지 않는다 (진행 중 요청은 창을 따라가지 않는다) */
    slowTabs: new Set<string>(),
    /** 워크스페이스 상태 복원(hydrate)으로 문서를 읽는 중인 탭 id — 탭마다 진행선 (지연 없음, 탭 단위).
     *  slowTabs 와 달리 복원 전용 — 사용자가 연 탭의 800ms 규칙은 그대로 */
    loadingTabs: new Set<string>(),
    /** 파일별 monaco 뷰 상태(커서·스크롤 — ICodeEditorViewState JSON) — path 키. MonacoHost 가 커서·스크롤
     *  변화마다 적고 모델을 끼운 뒤 되돌린다. 워크스페이스 상태 저장에 실린다 (ticket workspace-state-restore).
     *  markRaw — 반응형이면 커서 이동마다 저장 effect 가 깨어난다 */
    viewStates: markRaw(new Map<string, unknown>()),
  });
  const viewStates = editors.viewStates;

  /** 탭 id 별 진행 중 로드 수 — 마지막 로드가 끝나야 slowTabs 에서 내린다 (hex 청크는 겹친다) */
  const loadCount = new Map<string, number>();

  /** 탭의 로드를 지켜본다 — 800ms 를 넘기면 slowTabs 에 올리고, 끝나면(성공·실패 모두) 내린다 */
  async function trackLoad<T>(tabId: string, p: Promise<T>): Promise<T> {
    loadCount.set(tabId, (loadCount.get(tabId) ?? 0) + 1);
    const timer = setTimeout(() => editors.slowTabs.add(tabId), 800);
    try {
      return await p;
    } finally {
      clearTimeout(timer);
      const n = (loadCount.get(tabId) ?? 1) - 1;
      if (n > 0) {
        loadCount.set(tabId, n);
      } else {
        loadCount.delete(tabId);
        editors.slowTabs.delete(tabId);
      }
    }
  }

  // WHY: 터미널 탭 × 는 PTY 정리로 이어져야 하는데 editors 는 terminal 모듈을 모른다 —
  //      createTerminals 가 disposeTerminal 을 등록한다 (세션별 슬롯)
  let terminalCloser: ((term: number) => void) | null = null;
  function setTerminalCloser(fn: (term: number) => void): void {
    terminalCloser = fn;
  }

  /** 터미널 탭 열기 — model/terminal 의 register 가 부른다. at 이 없으면 활성 그룹 끝 */
  function openTerminalTab(term: number, name: string, at?: { groupId?: number; index?: number }): void {
    const group = (at?.groupId !== undefined ? editors.groups.find((g) => g.id === at.groupId) : undefined) ?? activeGroup();
    const tab: TerminalTab = { kind: 'terminal', id: `terminal:${term}`, path: '', name, dirty: false, preview: false, term };
    group.tabs.splice(Math.min(at?.index ?? group.tabs.length, group.tabs.length), 0, tab);
    group.activeTabId = tab.id;
    editors.activeGroupId = group.id;
  }

  /** 터미널 탭 제목 갱신 — tmux 세션 이름이 오면(termTmux) 'bash' 자리에 들어간다 */
  function renameTerminalTab(term: number, name: string): void {
    for (const g of editors.groups) {
      for (const t of g.tabs) {
        if (t.kind === 'terminal' && t.term === term) t.name = name;
      }
    }
  }

  /** 인스턴스 id 의 터미널 탭을 앞으로 — 사이드바에서 이미 열린 세션을 골랐을 때. 없으면 false */
  function focusTerminalTab(term: number): boolean {
    for (const g of editors.groups) {
      const t = g.tabs.find((t) => t.kind === 'terminal' && t.term === term);
      if (t) {
        g.activeTabId = t.id;
        editors.activeGroupId = g.id;
        return true;
      }
    }
    return false;
  }

  /** 인스턴스 id 의 터미널 탭을 모든 그룹에서 닫는다 — 셸 종료·세션 회수 (PTY 는 이미 정리됨) */
  function closeTerminalTabs(term: number): void {
    for (const g of [...editors.groups]) {
      for (const t of [...g.tabs]) {
        if (t.kind === 'terminal' && t.term === term) closeTab(g.id, t.id, true);
      }
    }
  }

  function activeGroup(): EditorGroup {
    return editors.groups.find((g) => g.id === editors.activeGroupId) ?? editors.groups[0];
  }

  function activeTab(): Tab | null {
    const g = activeGroup();
    return g.tabs.find((t) => t.id === g.activeTabId) ?? null;
  }

  // WHY: 클라이언트 설정 파일(superlite:/ 가상 경로)은 데몬 파일이 아니라 relay HTTP 로 읽고 쓴다 —
  //      문서·탭·dirty·저장 흐름은 그대로 두고 IO 만 갈아 끼운다. etag 없음('') — 충돌 검사 없이 덮어쓴다
  function readDoc(path: string, opts?: { encoding?: 'base64' }): Promise<FileContent> {
    if (isConfigPath(path)) return readConfig(path).then((content) => ({ content, etag: '' }));
    return backend.readFile(path, opts);
  }
  function writeDoc(path: string, content: string, etag?: string): Promise<WriteResult> {
    if (isConfigPath(path)) return writeConfig(path, content).then(() => ({ etag: '' }));
    return backend.writeFile(path, content, etag);
  }

  async function ensureDoc(path: string): Promise<Doc> {
    let doc = editors.docs.get(path);
    if (!doc) {
      // 이미지 확장자는 base64 로 읽는다 — 이진 판별(binary unopenable)을 타지 않고
      // 크기 상한(large)만 공유한다
      const image = imageMime(path) !== null;
      const r = await readDoc(path, image ? { encoding: 'base64' } : undefined);
      doc = r.unopenable !== undefined
        ? { content: '', savedContent: '', etag: r.etag, unopenable: r.unopenable }
        : image
          ? { content: '', savedContent: '', etag: r.etag, image: r.content }
          : { content: r.content, savedContent: r.content, etag: r.etag };
      if (isConfigPath(path) && configReadOnly(path)) doc.readOnly = true;
      editors.docs.set(path, doc);
    }
    return doc;
  }

  /**
   * 파일 열기. preview=true(트리 단일 클릭)면 기존 preview 탭을 교체하고,
   * preview=false(더블 클릭/명시적 오픈)면 고정 탭으로 연다.
   * 탭은 읽기 전에 즉시 뜬다 — 문서가 없는 파일 탭은 UI 가 빈 본문(+800ms 뒤 진행선)으로
   * 그리고, 읽기가 끝나면 docs 반응형이 편집기·뷰어를 채운다 (VS Code: 큰 파일도 탭이 먼저).
   */
  /** @returns 열기 성공 여부 — 읽기 실패는 탭을 걷고 notify 후 false (호출측 후속 동작 가드용) */
  async function openFile(
    path: string,
    opts?: { preview?: boolean; groupId?: number; focus?: boolean },
  ): Promise<boolean> {
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

    const doc = editors.docs.get(path);
    const tab: FileTab = {
      kind: 'file', id: path, path, name: tabNameOf('file', path),
      // WHY: dirty 인 채 닫힌 문서를 다시 열 수 있다 — 버퍼가 살아 있으므로 doc 상태에서 파생해야
      //      "clean 탭 아래 미저장 내용" 이 생기지 않는다. 아직 안 읽은 문서는 clean
      dirty: doc !== undefined && doc.content !== doc.savedContent,
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

    if (doc === undefined) {
      try {
        await trackLoad(tab.id, ensureDoc(path));
      } catch (e) {
        notify('error', `Unable to open '${baseName(path)}': ${errText(e)}`);
        // 읽지 못한 탭은 걷는다 — 왕복 중 사용자가 이미 닫았으면 takeTab 이 null 로 비껴간다
        if (takeTab(group.id, tab.id)) collapseIfEmpty(group.id);
        return false;
      }
    }
    return true;
  }

  /** 파일을 열고 지정 라인으로 이동 (검색 결과 클릭). line 은 1-based. */
  async function openFileAt(path: string, line: number): Promise<void> {
    // 열기 실패 시 reveal 을 남기면 다음 성공적 열기 때 엉뚱한 스크롤이 튄다
    if (!(await openFile(path, { preview: true }))) return;
    editors.pendingReveal = { path, line };
  }

  /** SCM 에서 diff 탭 열기 (original: HEAD, modified: 워킹트리).
   *  deleted: 워킹트리에서 지워진 파일 — 워킹트리 문서가 없으므로 diff 대신 HEAD 내용을
   *  읽기 전용 편집기로 보여 준다 (MonacoHost 가 분기). 문서를 만들지 않아 dirty·저장 경로가 없다.
   *  commit: 그 커밋의 부모 대비 diff — 양쪽 다 git 내용(문서 없음, 읽기 전용), 탭 라벨은 짧은 해시 */
  async function openDiff(path: string, opts?: { deleted?: boolean; commit?: string; from?: string }): Promise<void> {
    let dirty = false;
    if (!opts?.deleted && !opts?.commit) {
      try {
        const doc = await ensureDoc(path);
        dirty = doc.content !== doc.savedContent;
      } catch (e) {
        notify('error', `Unable to open '${baseName(path)}': ${errText(e)}`);
        return;
      }
    }
    const group = activeGroup();
    const id = opts?.commit ? `diff:${opts.commit}:${path}` : `diff:${path}`;
    if (!group.tabs.some((t) => t.id === id)) {
      const suffix = opts?.commit ? opts.commit.slice(0, 7) : opts?.deleted ? 'Deleted' : 'Working Tree';
      group.tabs.push({
        kind: 'diff', id, path, name: `${baseName(path)} (${suffix})`,
        dirty, preview: false, deleted: opts?.deleted, commit: opts?.commit, from: opts?.from,
      });
    }
    group.activeTabId = id;
    editors.pendingFocus = true;
  }

  /** hex 뷰어 탭 열기 — 활성 그룹에 고정 탭. 바이트 로드는 HexView 가 ensureHex 로 한다
   *  (창 이동·복원·재열기 모두 같은 경로로 수렴) */
  /** URL 탭 열기 — 활성 그룹 끝에 새 탭. url 이 없으면 빈 탭(주소칸에 포커스, UrlView 몫). 같은 URL 의 탭이
   *  있어도 새로 연다 (주소칸으로 URL 이 바뀌므로 중복 판정에 의미가 없다) */
  function openUrl(url = ''): void {
    const group = activeGroup();
    const id = `url:${Math.random().toString(36).slice(2, 10)}`;
    const tab: UrlTab = { kind: 'url', id, path: '', name: urlTabName(url), dirty: false, preview: false, url };
    group.tabs.push(tab);
    group.activeTabId = id;
    editors.pendingFocus = true;
  }

  /** 주소칸 확정 — 탭의 url·name 을 바꾼다 (iframe 교체는 UrlView 가 url 을 지켜보다 한다) */
  function navigateUrlTab(tabId: string, url: string): void {
    for (const g of editors.groups) {
      const t = g.tabs.find((t) => t.id === tabId);
      if (t?.kind === 'url') {
        t.url = url;
        t.name = urlTabName(url);
        return;
      }
    }
  }

  function openHex(path: string): void {
    const group = activeGroup();
    const id = tabIdOf('hex', path);
    if (!group.tabs.some((t) => t.id === id)) {
      group.tabs.push({ kind: 'hex', id, path, name: tabNameOf('hex', path), dirty: false, preview: false });
    }
    group.activeTabId = id;
  }

  /** 폴더 탭 열기 — 탐색기 폴더 드래그 드롭(중앙)·탭바 폴더 버튼(루트). 같은 폴더 탭이 그 그룹에
   *  있으면 활성화만. 나열은 FolderView 가 files.acquireDir 로 한다 (창 이동·복원·재열기 수렴) */
  function openFolderTab(path: string, opts: { groupId?: number; index?: number } = {}): void {
    const id = tabIdOf('folder', path);
    // 그룹 지정이 없으면(메뉴·타이틀바 클릭) 어느 그룹에든 이미 열린 같은 폴더 탭으로 포커스만 옮긴다
    const existing = opts.groupId === undefined ? editors.groups.find((g) => g.tabs.some((t) => t.id === id)) : undefined;
    const group = existing ?? (opts.groupId !== undefined ? editors.groups.find((g) => g.id === opts.groupId) : undefined) ?? activeGroup();
    if (!group.tabs.some((t) => t.id === id)) {
      const tab: FolderTab = {
        kind: 'folder', id, path, name: tabNameOf('folder', path), dirty: false, preview: false,
        style: folderPrefs.style, history: [path], histIndex: 0, sort: { key: 'name', asc: true },
      };
      group.tabs.splice(Math.min(opts.index ?? group.tabs.length, group.tabs.length), 0, tab);
    }
    group.activeTabId = id;
    editors.activeGroupId = group.id;
    editors.pendingFocus = true;
  }

  /** 빈 새 그룹을 refGroupId 상하좌우에 만든다 — 가장자리 드롭(폴더·새 터미널)의 공통 몸체.
   *  호출측이 곧바로 탭을 넣는다 (넣지 못하면 빈 그룹이 남으므로 동기 열기 전용) */
  function addGroupBeside(refGroupId: number, side: SplitSide): number | null {
    const ref = editors.groups.find((g) => g.id === refGroupId);
    if (!ref) return null;
    const group: EditorGroup = { id: nextGroupId++, tabs: [], activeTabId: null };
    editors.groups.splice(editors.groups.indexOf(ref) + 1, 0, group);
    insertIntoLayout(refGroupId, group.id, side);
    return group.id;
  }

  /** 탐색기 폴더 드래그 드롭(가장자리) — refGroupId 상하좌우의 새 그룹에 폴더 탭을 연다 */
  function openFolderTabSplit(path: string, refGroupId: number, side: SplitSide): void {
    const groupId = addGroupBeside(refGroupId, side);
    if (groupId !== null) openFolderTab(path, { groupId });
  }

  /** 폴더 탭 안 이동 — 탭을 제자리에서 다른 폴더로 바꾼다 (id·path·name 동시 갱신, yazi 의 cd).
   *  그 그룹에 목적지 폴더 탭이 이미 있으면 이 탭을 접고 그쪽을 활성화한다 (id 는 그룹 안에서 유일) */
  function navigateFolderTab(groupId: number, tabId: string, path: string, opts: { via?: 'back' | 'forward' } = {}): void {
    const group = editors.groups.find((g) => g.id === groupId);
    const tab = group?.tabs.find((t) => t.id === tabId);
    if (!group || !tab || tab.kind !== 'folder' || tab.path === path) return;
    const id = tabIdOf('folder', path);
    if (group.tabs.some((t) => t.id === id)) {
      group.tabs.splice(group.tabs.indexOf(tab), 1);
    } else {
      tab.id = id;
      tab.path = path;
      tab.name = tabNameOf('folder', path);
      // 이력 — 뒤로/앞으로는 자리만 옮기고, 새 이동은 앞쪽 이력을 버리고 쌓는다 (브라우저 동일)
      if (opts.via === 'back') tab.histIndex = Math.max(0, tab.histIndex - 1);
      else if (opts.via === 'forward') tab.histIndex = Math.min(tab.history.length - 1, tab.histIndex + 1);
      else {
        tab.history.splice(tab.histIndex + 1, Infinity, path);
        tab.histIndex = tab.history.length - 1;
      }
    }
    group.activeTabId = id;
  }

  /** 폴더 탭 보기 스타일 — 그 탭만 바꾸고, 새 탭의 기본값으로 기억한다 */
  function setFolderStyle(groupId: number, tabId: string, style: FolderStyle): void {
    const tab = editors.groups.find((g) => g.id === groupId)?.tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'folder') return;
    tab.style = style;
    folderPrefs.style = style;
    saveFolderPrefs();
  }

  /** 폴더 탭 정렬 — 같은 열이면 방향 토글, 다른 열이면 오름차순으로 (Windows 탐색기 열 머리글 동일) */
  function setFolderSort(groupId: number, tabId: string, key: FolderSortKey): void {
    const tab = editors.groups.find((g) => g.id === groupId)?.tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'folder') return;
    tab.sort = tab.sort.key === key ? { key, asc: !tab.sort.asc } : { key, asc: true };
  }

  /** hex 문서가 없으면 stat 으로 크기만 세운다 — 바이트는 loadHexChunk 가 보이는 범위만 읽는다 */
  async function ensureHex(path: string): Promise<void> {
    if (editors.hex.has(path)) return;
    try {
      const { size } = await trackLoad(tabIdOf('hex', path), backend.stat(path));
      if (!editors.hex.has(path)) editors.hex.set(path, { size, chunks: new Map() });
    } catch (e) {
      notify('error', `Unable to open '${baseName(path)}': ${errText(e)}`);
    }
  }

  /** 진행 중인 청크 요청 — 같은 청크를 스크롤마다 겹쳐 요청하지 않는다 */
  const hexPending = new Set<string>();

  /** hex 청크 로드 — 범위 읽기(offset, 와이어 v11). 캐시 상한을 넘으면 가장 오래된 청크부터 버린다.
   *  실패는 조용히 — 스크롤마다 나는 요청이라 토스트 폭주를 피한다 (다음 스크롤이 재시도) */
  async function loadHexChunk(path: string, idx: number): Promise<void> {
    const key = `${path}\0${idx}`;
    const doc = editors.hex.get(path);
    if (!doc || doc.chunks.has(idx) || hexPending.has(key)) return;
    hexPending.add(key);
    try {
      const r = await trackLoad(
        tabIdOf('hex', path),
        backend.readFile(path, { encoding: 'base64', offset: idx * HEX_CHUNK, maxBytes: HEX_CHUNK }),
      );
      // 왕복 중 외부 변경으로 문서가 갈렸으면(비워졌으면) 옛 바이트를 넣지 않는다
      if (editors.hex.get(path) !== doc || r.unopenable !== undefined) return;
      doc.chunks.set(idx, Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0)));
      for (const k of doc.chunks.keys()) {
        if (doc.chunks.size <= HEX_CHUNK_CAP) break;
        if (k !== idx) doc.chunks.delete(k);
      }
    } catch {
      // ponytail: 실패는 다음 스크롤의 재요청에 맡긴다
    } finally {
      hexPending.delete(key);
    }
  }

  /** HTML 프리뷰 탭 열기 — 활성 그룹에 (닫은 탭 복원·창 간 이동의 재개방 경로). 이미 어느 그룹에든
   *  열려 있으면 그 탭을 활성화한다. 문서는 같은 path 의 doc 을 공유한다. 편집기에서의 전환은 toggleHtmlPreview.
   *  탭은 읽기 전에 뜬다 (openFile 과 같은 규칙 — 프리뷰는 문서가 올 때까지 빈 화면, 실패하면 탭을 걷는다) */
  async function openHtmlPreview(path: string): Promise<void> {
    const id = tabIdOf('preview', path);
    for (const g of editors.groups) {
      if (g.tabs.some((t) => t.id === id)) {
        g.activeTabId = id;
        editors.activeGroupId = g.id;
        return;
      }
    }
    const group = activeGroup();
    group.tabs.push({ kind: 'preview', id, path, name: tabNameOf('preview', path), dirty: false, preview: false });
    group.activeTabId = id;
    if (editors.docs.has(path)) return;
    try {
      await trackLoad(id, ensureDoc(path));
    } catch (e) {
      notify('error', `Unable to open '${baseName(path)}': ${errText(e)}`);
      if (takeTab(group.id, id)) collapseIfEmpty(group.id);
    }
  }

  /** HTML 편집기 ↔ 프리뷰 제자리 전환 (Ctrl+Shift+V) — 탭을 같은 자리에서 다른 종류로 바꾼다.
   *  문서는 공유되므로 dirty 버퍼가 유지되고, 프리뷰 상태에서 탐색기로 같은 파일을 열면 편집기 탭이
   *  따로 열린다 (id 가 다르다). 바꿀 종류의 탭이 이 그룹에 이미 있으면 현재 탭을 접고 그쪽을 활성화 */
  function toggleHtmlPreview(groupId: number, tabId: string): void {
    const group = editors.groups.find((g) => g.id === groupId);
    const idx = group?.tabs.findIndex((t) => t.id === tabId) ?? -1;
    if (!group || idx === -1) return;
    const cur = group.tabs[idx];
    if (cur.kind !== 'file' && cur.kind !== 'preview') return;
    if (cur.kind === 'file' && !isHtml(cur.path)) return;
    const kind = cur.kind === 'file' ? 'preview' : 'file';
    const id = tabIdOf(kind, cur.path);
    const existing = group.tabs.find((t) => t.id === id);
    if (existing) {
      group.tabs.splice(idx, 1);
      group.activeTabId = id;
      return;
    }
    const doc = editors.docs.get(cur.path);
    const dirty = kind === 'file' && doc !== undefined && doc.content !== doc.savedContent;
    group.tabs.splice(idx, 1, { kind, id, path: cur.path, name: tabNameOf(kind, cur.path), dirty, preview: false });
    if (group.activeTabId === tabId) group.activeTabId = id;
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
    const groupId = addGroupBeside(refGroupId, side);
    if (groupId === null) return;
    // 읽기 실패 시 빈 그룹 잔재를 남기지 않는다 (잠금과 무관 — 사용자가 만든 빈 그룹이 아니다)
    if (!(await openFile(path, { groupId }))) {
      const group = editors.groups.find((g) => g.id === groupId);
      if (group) removeGroup(group);
    }
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
  //      다른 그룹이 잠겨 있으면 접지 않는다 — 잠금은 "삭제로 인한 자동 병합 방지" 다 (editor-group-empty-lock)
  function collapseIfEmpty(groupId: number): void {
    const group = editors.groups.find((g) => g.id === groupId);
    if (!group || group.tabs.length !== 0) return;
    // 잠금은 탭이 있는 동안만 — 탭을 다 닫으면 접히든 남든 잠금은 사라진다 (사용자 결정 2026-09-08)
    delete group.locked;
    if (editors.groups.length <= 1) return;
    if (editors.groups.some((g) => g !== group && g.locked)) return;
    removeGroup(group);
  }

  /** 빈 그룹을 배치에서 걷어낸다 — 잠금과 무관 (collapseIfEmpty 의 몸체, 사용자의 직접 닫기도 여기로) */
  function removeGroup(group: EditorGroup): void {
    const gIdx = editors.groups.indexOf(group);
    editors.groups.splice(gIdx, 1);
    removeFromLayout(group.id);
    // 접힌 그룹의 이웃(왼쪽 우선)으로 포커스 이동 — 항상 마지막 그룹으로 가지 않는다
    if (editors.activeGroupId === group.id) {
      editors.activeGroupId = editors.groups[Math.max(0, gIdx - 1)].id;
    }
  }

  /** 빈 그룹 직접 닫기 (빈 탭바의 ×) — 잠금과 무관하게 걷어낸다. 탭이 있거나 하나뿐인 그룹은 no-op */
  function closeEmptyGroup(groupId: number): void {
    const group = editors.groups.find((g) => g.id === groupId);
    if (!group || group.tabs.length !== 0 || editors.groups.length <= 1) return;
    removeGroup(group);
  }

  /** 그룹 잠금 토글 (탭바 자물쇠·팔레트) — 빈 그룹은 잠글 수 없다 (잠금은 탭이 있는 동안만) */
  function toggleGroupLock(groupId: number): void {
    const group = editors.groups.find((g) => g.id === groupId);
    if (!group || group.tabs.length === 0) return;
    if (group.locked) delete group.locked;
    else group.locked = true;
  }

  /** force: 확인 대화상자를 거치지 않는 닫기 — confirm 처리부·삭제(closePathTabs)가 쓴다 */
  function closeTab(groupId: number, tabId: string, force = false): void {
    if (!force) {
      const target = editors.groups.find((g) => g.id === groupId)?.tabs.find((t) => t.id === tabId);
      if (!target) return;
      const doc = editors.docs.get(target.path);
      // 같은 문서의 편집 표면(file·diff)이 다른 탭으로 남으면 버퍼는 계속 보이는 중 — 확인 불요.
      // preview·hex 탭은 savedContent·디스크만 그려 참조로 세지 않는다 (세면 미저장 버퍼가
      // 보이지 않은 채 살아남는다, review-front-model C2). 남는 편집 표면이 없으면 닫는 탭이
      // preview 여도 확인한다 — 버퍼가 닿을 곳이 없어지는 것은 같다
      // 커밋 diff 탭은 문서를 그리지 않는다 — 참조로 세지 않는다
      const isEditor = (t: Tab) => t.kind === 'file' || (t.kind === 'diff' && !t.commit);
      const editorRefs = editors.groups.reduce(
        (n, g) => n + g.tabs.filter((t) => t.path === target.path && isEditor(t)).length,
        0,
      );
      const lastEditor = editorRefs === (isEditor(target) ? 1 : 0);
      if (doc && doc.content !== doc.savedContent && lastEditor) {
        void askClose(groupId, tabId, target.path);
        return;
      }
    }
    const tab = takeTab(groupId, tabId);
    if (!tab) return;
    if (tab.kind === 'terminal') {
      // 복원 이력 없음 — 죽은 셸은 되살릴 수 없다. 훅이 PTY 를 정리한다 (removeAt 경유면 이미 없어 무해)
      terminalCloser?.(tab.term);
    } else if (tab.kind !== 'url') { // URL 탭은 path 가 없어 최근 닫은 탭 이력 밖
      editors.recentlyClosed.push(tab.kind === 'diff'
        ? { kind: tab.kind, path: tab.path, deleted: tab.deleted, commit: tab.commit, from: tab.from }
        : { kind: tab.kind, path: tab.path });
      if (editors.recentlyClosed.length > RECENTLY_CLOSED_CAP) editors.recentlyClosed.shift();
    }
    collapseIfEmpty(groupId);
  }

  /** dirty 문서의 마지막 탭 닫기 확인 (VS Code Save / Don't Save / Cancel).
   *  Save 는 저장 성공 시에만 닫는다 (실패·충돌은 탭 유지, 충돌은 토스트가 이어받는다).
   *  Don't Save 는 버퍼·monaco 모델을 버려 다음 열기가 디스크를 읽게 한다. Cancel 은 탭·버퍼 유지 */
  async function askClose(groupId: number, tabId: string, path: string): Promise<void> {
    const choice = await confirm({
      message: `Do you want to save the changes you made to '${baseName(path)}'?`,
      detail: "Your changes will be lost if you don't save them.",
      confirmLabel: 'Save',
      secondaryLabel: "Don't Save",
    });
    if (choice === 'confirm') {
      if (await saveDoc(path)) closeTab(groupId, tabId, true);
    } else if (choice === 'secondary') {
      editors.docs.delete(path);
      editors.orphaned.delete(path);
      disposeModelsHook(path);
      closeTab(groupId, tabId, true);
    }
  }

  /** 마지막으로 닫은 탭 복원 (Ctrl+Shift+T) — 활성 그룹에 고정 탭으로 연다.
   *  열기 실패(삭제된 파일 등)는 openFile/openDiff 가 notify 한다 — 이력에서는 소모된다 */
  async function reopenClosedEditor(): Promise<void> {
    const entry = editors.recentlyClosed.pop();
    if (!entry) return;
    if (entry.kind === 'diff') await openDiff(entry.path, { deleted: entry.deleted, commit: entry.commit, from: entry.from });
    else if (entry.kind === 'hex') openHex(entry.path);
    else if (entry.kind === 'preview') await openHtmlPreview(entry.path);
    else if (entry.kind === 'folder') openFolderTab(entry.path);
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

  /** 탭 드래그 드롭 — refGroupId 의 상하좌우(side) 새 그룹으로 분리. 단일 탭 그룹의 자기 분리는
   *  [ (빈) | A ] — 원 그룹을 빈 채 남긴다 (빈 그룹을 만들려는 의도, editor-group-empty-lock) */
  function moveTabSplit(fromGroupId: number, tabId: string, refGroupId: number, side: SplitSide): void {
    const ref = editors.groups.find((g) => g.id === refGroupId);
    if (!ref) return;
    const selfSplit = fromGroupId === refGroupId && ref.tabs.length === 1;
    const tab = takeTab(fromGroupId, tabId);
    if (!tab) return;
    tab.preview = false;
    const group: EditorGroup = { id: nextGroupId++, tabs: [tab], activeTabId: tab.id };
    editors.groups.splice(editors.groups.indexOf(ref) + 1, 0, group);
    insertIntoLayout(refGroupId, group.id, side);
    editors.activeGroupId = group.id;
    editors.pendingFocus = true;
    if (!selfSplit) collapseIfEmpty(fromGroupId);
  }

  /** 활성 그룹 오른쪽에 빈 그룹을 만들고 포커스 (팔레트 View: Split Editor). 탭 복제가 아니다 —
   *  빈 그룹은 드롭·탐색기 열기의 대상이 된다 (editor-group-empty-lock, 2026-09-08) */
  function splitGroup(): void {
    const id = addGroupBeside(activeGroup().id, 'right');
    if (id !== null) editors.activeGroupId = id;
  }

  function updateContent(path: string, content: string): void {
    const doc = editors.docs.get(path);
    if (!doc) return;
    doc.content = content;
    const dirty = doc.content !== doc.savedContent;
    for (const g of editors.groups) {
      for (const t of g.tabs) {
        // hex·preview 탭은 편집 표면이 아니다 — dirty 점을 받지 않는다
        if (t.path === path && (t.kind === 'file' || (t.kind === 'diff' && !t.commit))) {
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
  /** 경로 키 상태 맵 전부 (문서 + 뷰어 상태) — rename 이관(remapPaths)·삭제 정리(closePathTabs)·
   *  창 이동 정리(takeTabForHandoff)가 같은 목록을 순회한다. 뷰 상태를 가진 뷰어가 늘면 여기에만
   *  추가한다. docs 는 restore 가 재할당하므로 매번 읽는다 */
  function pathMaps(): Map<string, unknown>[] {
    return [editors.docs, editors.imageView, editors.hex, editors.folderView, viewStates];
  }

  function remapPaths(from: string, to: string): void {
    const mapPath = (p: string) =>
      p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null;
    for (const m of pathMaps()) {
      for (const [path, v] of [...m]) {
        const np = mapPath(path);
        if (np === null) continue;
        m.delete(path);
        m.set(np, v);
      }
    }
    disposeModelsHook(from);
    for (const g of editors.groups) {
      for (const t of g.tabs) {
        if (t.kind === 'diff' && t.commit) continue; // 커밋 시점 경로 — 워킹트리 rename 을 따르지 않는다
        const np = mapPath(t.path);
        if (np === null) continue;
        const newId = tabIdOf(t.kind, np);
        if (g.activeTabId === t.id) g.activeTabId = newId;
        t.id = newId;
        t.path = np;
        t.name = t.kind === 'diff' ? `${baseName(np)} (${t.deleted ? 'Deleted' : 'Working Tree'})` : tabNameOf(t.kind, np);
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
    for (const m of pathMaps()) {
      for (const p of [...m.keys()]) if (match(p)) m.delete(p);
    }
    disposeModelsHook(path);
    if (editors.saveConflict !== null && match(editors.saveConflict)) editors.saveConflict = null;
    for (const p of [...editors.orphaned]) if (match(p)) editors.orphaned.delete(p);
  }

  /**
   * 외부(디스크) 변경 반영. 깨끗한 문서만 조용히 재로드한다 — dirty 는 안 건드리고
   * 충돌은 저장 시점 검사로 일원화한다 (VS Code 동일).
   */
  function reloadDocFromDisk(path: string, r: FileContent): void {
    // hex 바이트는 여기 r 로 못 만든다(텍스트/이미지 읽기) — 비워서 HexView 가 다시 읽게 한다
    editors.hex.delete(path);
    const doc = editors.docs.get(path);
    if (!doc || doc.content !== doc.savedContent) return;
    // 내용이 같아도(touch, 같은 내용 재저장) etag 는 갱신 — 다음 저장의 스퓨리어스 충돌 방지
    doc.etag = r.etag;
    // 외부 변경으로 열 수 없게(텍스트→이진·크기 초과) 되거나 반대로 돌아올 수 있다 —
    // 사유를 최신화하고, unopenable 쪽 내용은 '' 로 수렴시킨다 (안내 화면이 대신 뜬다)
    doc.unopenable = r.unopenable;
    // 이미지 문서 — content 는 '' 고정이라 base64 만 갱신하면 뷰어가 반응한다
    // (watch 가 이미지 경로를 encoding=base64 로 읽어 왔다는 전제. large 전이 시 비운다)
    if (imageMime(path) !== null) {
      doc.image = r.unopenable !== undefined ? undefined : r.content;
      return;
    }
    const content = r.unopenable !== undefined ? '' : r.content;
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
      r = await writeDoc(path, content, doc.etag);
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
      const r = await writeDoc(path, content);
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
      const r = await readDoc(path);
      if (r.unopenable !== undefined) {
        // 디스크가 이진·크기 초과로 바뀐 경우 — 텍스트로 되돌릴 내용이 없다.
        // 토스트는 남긴다 — Overwrite 로 내 버퍼를 살리는 길이 남는다
        notify('error', `Failed to revert '${baseName(path)}': file is binary or too large`);
        return;
      }
      const { content, etag } = r;
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

  /** 들여쓰기 감지: 최소 양수 선행 공백 (VS Code detectIndentation 근사).
   *  앞 1만 줄까지만 본다 — 탭 전환(sync)마다 불리므로 초대형 파일의 전체 스캔은
   *  줄 수 비례 비용이 된다 (split 도 전체 할당이라 indexOf 순회로 상한을 지킨다) */
  function indentOf(path: string): number {
    const doc = editors.docs.get(path);
    if (!doc) return 4;
    const content = doc.content;
    let min = Infinity;
    let pos = 0;
    for (let i = 0; i < 10000 && pos < content.length; i++) {
      let end = content.indexOf('\n', pos);
      if (end === -1) end = content.length;
      const m = content.slice(pos, end).match(/^( +)\S/);
      if (m) min = Math.min(min, m[1].length);
      pos = end + 1;
    }
    return Number.isFinite(min) ? min : 4;
  }

  /** 세션 통째 창 이동용 스냅샷 — JSON 왕복 가능한 평범한 객체만 (Map 은 엔트리로) */
  function snapshot(): EditorsSnapshot {
    return {
      groups: JSON.parse(JSON.stringify(editors.groups)) as EditorGroup[],
      layout: JSON.parse(JSON.stringify(editors.layout)) as LayoutNode,
      activeGroupId: editors.activeGroupId,
      nextGroupId,
      docs: [...editors.docs].map(([p, d]) => [p, { ...d }]),
    };
  }

  /** 스냅샷을 이 세션에 덮어쓴다 — 새 창의 빈 세션에 쓰는 것이 전제 (기존 탭은 버린다).
   *  monaco 모델은 doc 스냅샷에서 다시 만들어진다 (세션 전환과 같은 경로) */
  function restore(s: EditorsSnapshot): void {
    // 터미널 탭은 걷어낸다 — 인스턴스 id 가 창마다 달라 adoptTerminals 가 새 탭으로 다시 연다.
    // 그 때문에 비게 된 그룹만 접는다 — 원래 빈 그룹(사용자가 만든 것)은 배치의 일부라 남긴다
    const emptied: number[] = [];
    for (const g of s.groups) {
      const n = g.tabs.length;
      g.tabs = g.tabs.filter((t) => t.kind !== 'terminal');
      if (n > 0 && g.tabs.length === 0) emptied.push(g.id);
      if (g.activeTabId !== null && !g.tabs.some((t) => t.id === g.activeTabId)) g.activeTabId = g.tabs[0]?.id ?? null;
    }
    editors.groups = s.groups;
    editors.layout = s.layout;
    editors.activeGroupId = s.activeGroupId;
    nextGroupId = Math.max(nextGroupId, s.nextGroupId);
    editors.docs = new Map(s.docs);
    editors.orphaned.clear();
    editors.pendingFocus = true;
    for (const id of emptied) collapseIfEmpty(id);
  }

  /** 워크스페이스 상태 복원의 문서 채우기 (ticket workspace-state-restore) — restore 로 세운 껍데기 탭
   *  중 문서가 필요한 것(file·preview·삭제 아닌 diff)을 활성 탭부터 읽는다. 탭마다 loadingTabs 로 진행선을
   *  올리고, 읽기 실패(사라진 파일 등)한 탭은 걷어낸다. 반환은 걷어낸 탭 이름 — 호출측이 알림 한 줄로 합친다.
   *  hex·folder 탭은 뷰가 스스로 읽고, 이미 문서가 있는 경로는 건너뛴다 */
  async function hydrate(): Promise<string[]> {
    const order: { groupId: number; tab: Tab }[] = [];
    const push = (g: EditorGroup, t: Tab) => {
      if (t.kind !== 'file' && t.kind !== 'preview' && !(t.kind === 'diff' && !t.deleted && !t.commit)) return;
      if (editors.docs.has(t.path)) return;
      if (!order.some((o) => o.tab.path === t.path)) order.push({ groupId: g.id, tab: t });
    };
    const act = activeGroup();
    for (const g of [act, ...editors.groups.filter((g) => g !== act)]) {
      const a = g.tabs.find((t) => t.id === g.activeTabId);
      if (a) push(g, a);
    }
    for (const g of editors.groups) for (const t of g.tabs) push(g, t);
    const failed: string[] = [];
    // 순차 읽기 — 활성 탭이 먼저 채워지고, 원격에서 탭 수만큼 동시 요청을 쏟지 않는다
    for (const { tab } of order) {
      const ids = editors.groups.flatMap((g) => g.tabs.filter((t) => t.path === tab.path).map((t) => t.id));
      for (const id of ids) editors.loadingTabs.add(id);
      try {
        await ensureDoc(tab.path);
      } catch {
        failed.push(baseName(tab.path));
        for (const g of [...editors.groups]) {
          for (const t of [...g.tabs]) if (t.path === tab.path && takeTab(g.id, t.id)) collapseIfEmpty(g.id);
        }
        viewStates.delete(tab.path);
      } finally {
        for (const id of ids) editors.loadingTabs.delete(id);
      }
    }
    return failed;
  }

  /** 탭 하나를 다른 창으로 보내기 위해 뗀다 — 닫기 확인·최근 닫은 탭 이력을 거치지 않는다
   *  (닫는 게 아니라 옮기는 것). 같은 문서를 보는 마지막 탭이면 버퍼·monaco 모델도 여기서
   *  버린다 (다음 열기는 디스크에서). 빠진 그룹은 접는다 */
  function takeTabForHandoff(groupId: number, tabId: string): TabHandoff | null {
    const tab = takeTab(groupId, tabId);
    if (!tab) return null;
    if (tab.kind === 'terminal' || tab.kind === 'url') {
      // 문서가 없다 — 탭만 뗀다. PTY 스냅샷·해제는 호출측(sessions)이 terminals 로 한다. URL 탭은 url 만 실린다
      collapseIfEmpty(groupId);
      return { tab, doc: null };
    }
    const doc = editors.docs.get(tab.path);
    const refs = editors.groups.reduce((n, g) => n + g.tabs.filter((t) => t.path === tab.path).length, 0);
    if (refs === 0) {
      for (const m of pathMaps()) m.delete(tab.path);
      editors.orphaned.delete(tab.path);
      disposeModelsHook(tab.path);
    }
    collapseIfEmpty(groupId);
    return { tab: { ...tab, preview: false }, doc: doc ? { ...doc } : null };
  }

  /** 다른 창에서 넘어온 탭을 받는다 — 문서 버퍼가 없던(로드 전) 탭은 디스크에서 연다.
   *  이 세션이 같은 문서를 이미 열고 있으면 이쪽 버퍼를 유지한다 (같은 root 라 같은 파일 —
   *  두 버퍼 중 하나는 잃는데, 받는 쪽이 보고 있던 것을 지킨다). 같은 탭이 이미 있으면 활성화만 */
  function acceptTab(h: TabHandoff, groupId?: number, index?: number): void {
    if (h.tab.kind === 'terminal') return; // 터미널은 adoptTerminals 가 새 인스턴스로 탭을 연다
    const group = (groupId !== undefined ? editors.groups.find((g) => g.id === groupId) : undefined) ?? activeGroup();
    if (editors.docs.has(h.tab.path) && h.doc && h.doc.content !== h.doc.savedContent) {
      // 넘어온 쪽이 미저장인데 이쪽 버퍼를 지킨다 — 조용히 버리지 않고 알린다
      notify('warning', `Unsaved changes of '${baseName(h.tab.path)}' from the other window were discarded (already open here)`);
    }
    // hex·folder·url 탭은 문서가 필요 없다 — 바이트·나열·페이지는 받는 쪽 뷰가 다시 읽는다
    if (!editors.docs.has(h.tab.path) && h.tab.kind !== 'hex' && h.tab.kind !== 'folder' && h.tab.kind !== 'url') {
      if (!h.doc) {
        void (h.tab.kind === 'diff' ? openDiff(h.tab.path, { deleted: h.tab.deleted, commit: h.tab.commit, from: h.tab.from })
          : h.tab.kind === 'preview' ? openHtmlPreview(h.tab.path)
            : openFile(h.tab.path, { groupId: group.id }));
        return;
      }
      editors.docs.set(h.tab.path, h.doc);
    }
    const doc = editors.docs.get(h.tab.path);
    const editable = h.tab.kind === 'file' || (h.tab.kind === 'diff' && !h.tab.commit);
    const tab: Tab = { ...h.tab, dirty: editable && doc !== undefined && doc.content !== doc.savedContent, preview: false };
    if (!group.tabs.some((t) => t.id === tab.id)) {
      group.tabs.splice(Math.min(index ?? group.tabs.length, group.tabs.length), 0, tab);
    }
    group.activeTabId = tab.id;
    editors.activeGroupId = group.id;
    editors.pendingFocus = true;
  }

  return {
    editors, activeGroup, activeTab, openFile, openFileAt, openDiff, openHex, openUrl, navigateUrlTab, ensureHex, loadHexChunk, openHtmlPreview, toggleHtmlPreview, setActiveTab, pinTab,
    openFolderTab, openFolderTabSplit, navigateFolderTab, addGroupBeside, setFolderStyle, setFolderSort,
    openFileSplit, closeTab,
    reopenClosedEditor, moveTabToGroup, moveTabSplit,
    splitGroup, closeEmptyGroup, toggleGroupLock, updateContent, setOrphaned, remapPaths, closePathTabs,
    reloadDocFromDisk, hasDirtyDocs, saveActive, overwriteConflict, revertConflict, indentOf,
    snapshot, restore, hydrate, takeTabForHandoff, acceptTab,
    openTerminalTab, closeTerminalTabs, setTerminalCloser, renameTerminalTab, focusTerminalTab,
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

// ---- 활성 세션 전달 shim — UI·커맨드는 종전 이름 그대로 활성 세션에 작용한다

export const editors = viewOf(() => ctx().editors.editors);
export const activeGroup = (): EditorGroup => ctx().editors.activeGroup();
export const activeTab = (): Tab | null => ctx().editors.activeTab();
export const openFile = (
  path: string, opts?: { preview?: boolean; groupId?: number; focus?: boolean },
): Promise<boolean> => ctx().editors.openFile(path, opts);
export const openFileAt = (path: string, line: number): Promise<void> =>
  ctx().editors.openFileAt(path, line);
export const openDiff = (path: string, opts?: { deleted?: boolean }): Promise<void> =>
  ctx().editors.openDiff(path, opts);
export const openHex = (path: string): void => ctx().editors.openHex(path);
export const openUrl = (url?: string): void => ctx().editors.openUrl(url);
export const navigateUrlTab = (tabId: string, url: string): void => ctx().editors.navigateUrlTab(tabId, url);
export const openFolderTab = (path: string, opts: { groupId?: number; index?: number } = {}): void => ctx().editors.openFolderTab(path, opts);
export const addGroupBeside = (refGroupId: number, side: SplitSide): number | null => ctx().editors.addGroupBeside(refGroupId, side);
export const openFolderTabSplit = (path: string, refGroupId: number, side: SplitSide): void =>
  ctx().editors.openFolderTabSplit(path, refGroupId, side);
export const navigateFolderTab = (groupId: number, tabId: string, path: string, opts: { via?: 'back' | 'forward' } = {}): void =>
  ctx().editors.navigateFolderTab(groupId, tabId, path, opts);
export const setFolderStyle = (groupId: number, tabId: string, style: FolderStyle): void =>
  ctx().editors.setFolderStyle(groupId, tabId, style);
export const setFolderSort = (groupId: number, tabId: string, key: FolderSortKey): void =>
  ctx().editors.setFolderSort(groupId, tabId, key);
export const ensureHex = (path: string): Promise<void> => ctx().editors.ensureHex(path);
export const loadHexChunk = (path: string, idx: number): Promise<void> => ctx().editors.loadHexChunk(path, idx);
export const toggleHtmlPreview = (groupId: number, tabId: string): void => ctx().editors.toggleHtmlPreview(groupId, tabId);
export const setActiveTab = (groupId: number, tabId: string): void =>
  ctx().editors.setActiveTab(groupId, tabId);
export const pinTab = (groupId: number, tabId: string): void => ctx().editors.pinTab(groupId, tabId);
export const openFileSplit = (path: string, refGroupId: number, side: SplitSide): Promise<void> =>
  ctx().editors.openFileSplit(path, refGroupId, side);
export const closeTab = (groupId: number, tabId: string, force = false): void =>
  ctx().editors.closeTab(groupId, tabId, force);
export const reopenClosedEditor = (): Promise<void> => ctx().editors.reopenClosedEditor();
export const moveTabToGroup = (fromGroupId: number, tabId: string, toGroupId: number, index?: number): void =>
  ctx().editors.moveTabToGroup(fromGroupId, tabId, toGroupId, index);
export const moveTabSplit = (fromGroupId: number, tabId: string, refGroupId: number, side: SplitSide): void =>
  ctx().editors.moveTabSplit(fromGroupId, tabId, refGroupId, side);
export const splitGroup = (): void => ctx().editors.splitGroup();
export const closeEmptyGroup = (groupId: number): void => ctx().editors.closeEmptyGroup(groupId);
export const toggleGroupLock = (groupId: number): void => ctx().editors.toggleGroupLock(groupId);
export const updateContent = (path: string, content: string): void =>
  ctx().editors.updateContent(path, content);
export const setOrphaned = (path: string, on: boolean): void => ctx().editors.setOrphaned(path, on);
export const remapPaths = (from: string, to: string): void => ctx().editors.remapPaths(from, to);
export const closePathTabs = (path: string): void => ctx().editors.closePathTabs(path);
export const reloadDocFromDisk = (path: string, r: FileContent): void =>
  ctx().editors.reloadDocFromDisk(path, r);
export const hasDirtyDocs = (): boolean => ctx().editors.hasDirtyDocs();
export const saveActive = (): Promise<void> => ctx().editors.saveActive();
export const overwriteConflict = (): Promise<void> => ctx().editors.overwriteConflict();
export const revertConflict = (): Promise<void> => ctx().editors.revertConflict();
export const indentOf = (path: string): number => ctx().editors.indentOf(path);
