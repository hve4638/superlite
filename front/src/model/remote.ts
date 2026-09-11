import { reactive } from '@vue/reactivity';
import { backendApiUrl, openFolder } from './host';
import type { OpenMode } from './sessions';

/**
 * 원격 탐색기 (SSH) 모델 — 백엔드 머신의 ~/.ssh/config 호스트 목록에 superlite 자체
 * 상태(즐겨찾기·고정·최근 폴더)를 합친 것. 세션과 무관한 앱 전역 상태다.
 *
 * FAVORITE: 사용자가 고른 host (즐겨찾기 순). 고정(fix)은 즐겨찾기에서만 — 고정 시점의
 * config 블록을 백엔드가 저장하고 접속에 그 저장본을 쓴다 (config 에서 사라져도 접속된다).
 * 저장본과 현재 config 가 다르면 drift (이탤릭). 고정 안 한 즐겨찾기가 config 에서 사라지면
 * missing (이탤릭, 접속 불가).
 * ALL: ~/.ssh/config 전체 (config 순), 즐겨찾기인 항목은 별 아이콘.
 * 최근 폴더: 호스트 행을 펼치면 그 호스트에서 연 최근 폴더가 한 줄 행으로 나온다 (VS Code Remote
 * Explorer 의 호스트 하위 폴더). 행 클릭은 선택, hover 의 →/새 탭이 접속 (호스트 행과 동일). relay 가
 * attach 성공 시 기록한다. 상태 파일의 items 스키마(pin·그룹, ticket remote-path-items)는 relay 에
 * 남아 있지만 프론트는 평면 단일 아이템 목록으로 펴서 보이고 편집은 pin 토글·제거뿐이다 — 그룹·별칭·DnD 는
 * 2026-09-11 사용자 결정으로 UI 에서 걷어냈고 pin(상단 고정, 행에 pinned 아이콘)만 남겼다 (ticket
 * remote-explorer-vscode-style). 편집은 결과 목록을 set-items 로 통째로 보낸다. 호스트 행의 펼침은 호스트별 지속 (collapsed — 기본 펼침).
 * pane 접힘 상태는 전역 지속 (백엔드 파일) — 초기값만 백엔드가 한 번 정한다 (즐겨찾기가 없으면
 * FAVORITE 닫힘·ALL 열림), 그 뒤는 사용자가 접고 펼친 대로.
 * 상태는 백엔드 파일이 단일 출처 — 변경 응답이 곧 갱신된 목록이라 재조회하지 않는다.
 */

export interface RemoteHost {
  name: string;
  favorite: boolean;
  pinned: boolean;
  /** 고정 저장본 ≠ 현재 config (사라짐 포함) — '이 경고 숨김' 으로 인정하면 false */
  drift: boolean;
  /** config 에 없고 고정도 안 된 즐겨찾기 — 접속 불가 */
  missing: boolean;
}

/** 단일 경로 아이템 (원격 절대 경로) — pinned 면 상단 고정 */
export type PathItem = { path: string; pinned: boolean };
/** 그룹 — 멤버 순서가 곧 탭 생성 순서. 별칭은 선택 (없으면 제목줄 없음). pin 은 단일과 같은 규칙 */
export type PathGroup = { alias?: string; paths: string[]; pinned: boolean };
export type RemoteItem = PathItem | PathGroup;

export function isGroup(item: RemoteItem): item is PathGroup {
  return 'paths' in item;
}

export interface HostList {
  favorites: RemoteHost[];
  all: RemoteHost[];
  panes: { favorite: boolean; all: boolean };
  /** 경로 아이템 목록을 접어 둔 host — 없으면 펼침 */
  collapsed: string[];
  /** host → 경로 아이템 (pin 이 위, 그 아래 최근순 — relay 가 정규화한 순서 그대로) */
  items: Record<string, RemoteItem[]>;
}

export type RemoteOp = 'fav' | 'unfav' | 'pin' | 'unpin' | 'ack' | 'refresh' | 'set-items' | 'pane' | 'expand';

export const remote = reactive({
  favorites: [] as RemoteHost[],
  all: [] as RemoteHost[],
  panes: { favorite: true, all: true },
  collapsed: [] as string[],
  items: {} as Record<string, RemoteItem[]>,
  loaded: false,
  error: null as string | null,
});

function apply(list: HostList): void {
  remote.favorites = list.favorites;
  remote.all = list.all;
  remote.panes = list.panes;
  remote.collapsed = list.collapsed;
  remote.items = list.items;
  remote.error = null;
}

/** 원격 탐색기 표시 여부 — 백엔드 HTTP API 가 없는 환경(mock)은 감춘다 */
export function remoteEnabled(): boolean {
  return backendApiUrl('/ssh/hosts') !== null;
}

/** 호스트 목록 (재)로드 — 뷰 마운트·세션 목록 변경·사이드바 새로고침이 부른다. loaded 는
 *  "조회를 한 번이라도 시작했는가" — 빈 목록 안내 표시 여부 */
export async function refreshHosts(): Promise<void> {
  remote.loaded = true;
  remote.error = null;
  try {
    const url = backendApiUrl('/ssh/hosts');
    if (url === null) throw new Error('원격 미지원 환경');
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    apply((await res.json()) as HostList);
  } catch (e) {
    remote.error = e instanceof Error ? e.message : String(e);
  }
}

/** 상태 변경 — 백엔드가 돌려준 목록으로 갈아끼운다. host 자리는 pane 이면 pane 이름,
 *  extra 는 pane·expand 의 open. body 는 set-items 의 아이템 JSON — text/plain 이라 CORS preflight
 *  없이(단순 요청) 간다. 실패는 목록 위 오류 줄에 (다음 성공 응답이 지운다) */
export async function setHostState(
  op: RemoteOp,
  host: string,
  extra: Record<string, string> = {},
  body?: string,
): Promise<void> {
  try {
    const url = backendApiUrl('/ssh/state', { op, host, ...extra });
    if (url === null) throw new Error('원격 미지원 환경');
    const res = await fetch(url, { method: 'POST', body, headers: body === undefined ? {} : { 'content-type': 'text/plain' } });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    apply((await res.json()) as HostList);
  } catch (e) {
    remote.error = e instanceof Error ? e.message : String(e);
  }
}

/** pane 접힘 토글 — 로컬 즉시 반영 + 전역 지속 */
export function setPaneOpen(pane: 'favorite' | 'all', open: boolean): void {
  remote.panes = { ...remote.panes, [pane]: open };
  void setHostState('pane', pane, { open: open ? '1' : '0' });
}

/** 호스트 행의 최근 폴더 펼침 토글 — 로컬 즉시 반영 + 호스트별 지속 (같은 host 는 두 pane 이 공유) */
export function setHostExpanded(host: string, open: boolean): void {
  remote.collapsed = open ? remote.collapsed.filter((h) => h !== host) : [...remote.collapsed, host];
  void setHostState('expand', host, { open: open ? '1' : '0' });
}

/** 호스트에 접속 — 경로 없는 `ssh://host` 로 원격 빈 세션(시작 페이지)을 연다. 폴더는 그
 *  세션의 '폴더 열기'가 원격을 탐색해 고른다 (VS Code "Connect to Host" 와 동일).
 *  mode 'replace'=현재 탭 대체(→, "현재 창에 연결") / 'new'=항상 새 탭(새 창 아이콘 — 활성
 *  탭이 빈 세션이어도 대체하지 않는다) */
export function connectHost(host: string, mode: OpenMode): void {
  openFolder(`ssh://${host}`, { mode });
}

/** 경로 아이템으로 접속 — path 는 원격 절대 경로. mode 규칙은 connectHost 와 동일 */
export function openRecent(host: string, path: string, mode: OpenMode): void {
  openFolder(`ssh://${host}${path}`, { mode });
}

/** 호스트의 최근 폴더 — 아이템 목록을 평면 단일 아이템 목록으로 편다 (그룹은 멤버를 차례로, pin 은 그룹의 것을
 *  물려받고, 같은 경로는 처음 것만). relay 가 pin 을 위로 정렬해 두므로 순서는 그대로 */
export function recentOf(host: string): PathItem[] {
  const out: PathItem[] = [];
  for (const it of remote.items[host] ?? []) {
    for (const p of isGroup(it) ? it.paths : [it.path]) {
      if (!out.some((o) => o.path === p)) out.push({ path: p, pinned: it.pinned });
    }
  }
  return out;
}

/** 편집 결과를 set-items 로 통째로 보낸다 — 평면 목록으로 보내므로 옛 파일의 그룹은 첫 편집 때 풀린다 */
function setRecent(host: string, items: PathItem[]): Promise<void> {
  return setHostState('set-items', host, {}, JSON.stringify(items));
}

/** 상단 고정 토글 — relay 가 pin 된 것을 위로 올린다 (pin 끼리 순서 유지) */
export function togglePin(host: string, path: string): Promise<void> {
  return setRecent(host, recentOf(host).map((i) => (i.path === path ? { ...i, pinned: !i.pinned } : i)));
}

/** 최근 목록에서 제거 */
export function forgetItem(host: string, path: string): Promise<void> {
  return setRecent(host, recentOf(host).filter((i) => i.path !== path));
}
