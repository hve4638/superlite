import { reactive } from '@vue/reactivity';
import { backendApiUrl, openFolder } from './host';
import { sessions, type OpenMode } from './sessions';

/**
 * 원격 탐색기 (SSH) 모델 — 백엔드 머신의 ~/.ssh/config 호스트 목록에 superlite 자체
 * 상태(즐겨찾기·고정·최근 폴더)를 합친 것. 세션과 무관한 앱 전역 상태다.
 *
 * FAVORITE: 사용자가 고른 host (즐겨찾기 순). 고정(fix)은 즐겨찾기에서만 — 고정 시점의
 * config 블록을 백엔드가 저장하고 접속에 그 저장본을 쓴다 (config 에서 사라져도 접속된다).
 * 저장본과 현재 config 가 다르면 drift (이탤릭). 고정 안 한 즐겨찾기가 config 에서 사라지면
 * missing (이탤릭, 접속 불가).
 * ALL: ~/.ssh/config 전체 (config 순), 즐겨찾기인 항목은 별 아이콘.
 * 경로 아이템: 호스트 행을 펼치면 그 호스트의 경로 아이템이 나온다 (VS Code Remote Explorer 의
 * 호스트 하위 폴더에 pin·그룹을 더한 것 — ticket remote-path-items). 행 클릭은 선택, hover 의
 * →/새 탭이 접속 (호스트 행과 동일). relay 가 attach 성공 시 최근 폴더로 기록한다 (pin 아래 맨 위).
 * pin = 상단 고정(pin 끼리는 순서 유지). 그룹 = 경로 여러 개를 한 번에 여러 탭으로 여는 묶음 —
 * 아이템을 다른 아이템 위로 끌면 생기고, 항상 펼쳐진 채 세로선으로 묶여 보인다. 별칭은 우클릭으로.
 * 편집(pin·이동·복사·그룹·별칭·제거)은 여기서 결과 목록을 계산해 통째로 보낸다 (set-items — 시작
 * 페이지 Pinned 의 setPinned 와 같은 방식). 평면(최상위·그룹)마다 같은 경로는 하나 — relay 가
 * 정규화하며 뒤에 온 쪽을 버린다. 호스트 행의 펼침은 호스트별 지속 (collapsed — 기본 펼침).
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

/** 그룹 열기 — 멤버마다 세션 탭. 같은 ssh://host/path 탭이 이미 열려 있으면 그 멤버는 건너뛴다
 *  (새로 만들지도 활성화하지도 않는다 — openFolder 의 기존 탭 포커스 규칙과 별개). 첫 새 멤버가
 *  mode(현재 탭 대체 / 새 탭)를 받고 나머지는 새 탭 */
export function openGroup(host: string, paths: string[], mode: OpenMode): void {
  const open = new Set(sessions.list.map((t) => t.root?.replace(/\/+$/, '') ?? null));
  paths
    .map((p) => `ssh://${host}${p}`)
    .filter((r) => !open.has(r.replace(/\/+$/, '')))
    .forEach((r, i) => openFolder(r, { mode: i === 0 ? mode : 'new' }));
}

// ---- 경로 아이템 편집 — 현재 목록의 사본을 고쳐 set-items 로 통째로 보낸다 (relay 가 정규화·검증)

function itemsOf(host: string): RemoteItem[] {
  return (remote.items[host] ?? []).map((i) => (isGroup(i) ? { ...i, paths: [...i.paths] } : { ...i }));
}

function setItems(host: string, items: RemoteItem[]): Promise<void> {
  return setHostState('set-items', host, {}, JSON.stringify(items));
}

/** pin 토글 (최상위 아이템 — 단일·그룹) — relay 가 pin 을 위로 올린다 */
export function togglePin(host: string, index: number): Promise<void> {
  const items = itemsOf(host);
  const it = items[index];
  if (it !== undefined) it.pinned = !it.pinned;
  return setItems(host, items);
}

/** 목록에서 제거 — 최상위 단일 아이템, 또는 group 을 주면 그 그룹의 멤버 (하나 남으면 relay 가 그룹을 푼다) */
export function forgetItem(host: string, path: string, group?: number): Promise<void> {
  let items = itemsOf(host);
  if (group === undefined) items = items.filter((i) => isGroup(i) || i.path !== path);
  else {
    const g = items[group];
    if (g !== undefined && isGroup(g)) g.paths = g.paths.filter((p) => p !== path);
  }
  return setItems(host, items);
}

/** 그룹 별칭 — 빈 문자열은 없음 */
export function setGroupAlias(host: string, group: number, alias: string): Promise<void> {
  const items = itemsOf(host);
  const g = items[group];
  if (g === undefined || !isGroup(g)) return Promise.resolve();
  const a = alias.trim();
  if (a === '') delete g.alias;
  else g.alias = a;
  return setItems(host, items);
}

/** 드래그 출처 — 최상위 아이템(index) 또는 그룹 멤버(index 의 그룹 안 member). 이 목록 밖(시작 페이지
 *  Pinned)에서 온 경로들은 출처 없이 paths 만 온다 (복사와 같다) */
export type ItemSource = { index: number; member?: string };
/** 드롭 자리 — 최상위 index 의 앞·뒤, 단일 아이템 위(into = 그 아이템과 그룹 만들기), 그룹 안 at 번째 */
export type ItemTarget =
  | { kind: 'before' | 'after'; index: number }
  | { kind: 'into'; index: number }
  | { kind: 'member'; index: number; at: number };

/** 끌어 놓기 — paths 를 target 에 넣는다. from 이 있고 copy 가 아니면 출처에서 뗀다 (이동). 대상 평면에
 *  이미 있는 경로는 넣지 않는다 — "같은 평면 복사 = 무동작, 이동·복사 병합 = 옮겨 온 쪽 소멸, 원래
 *  아이템 자리 유지" (relay 정규화가 같은 규칙으로 한 번 더 거른다). into 는 대상 단일 아이템을
 *  [대상, ...paths] 그룹으로 바꾼다 (대상의 pin 은 그룹이 이어받는다). 최상위 아이템을
 *  최상위 안에서 옮길 때는 그 아이템(pin 상태·그룹 별칭)이 통째로 옮겨진다 */
export function dropItems(host: string, paths: string[], target: ItemTarget, from?: ItemSource, copy = false): Promise<void> {
  const items = itemsOf(host);
  let moved: RemoteItem | null = null;
  let index = target.index;
  let at = target.kind === 'member' ? target.at : 0;
  if (from !== undefined && !copy) {
    const src = items[from.index];
    if (src === undefined) return Promise.resolve();
    if (from.member === undefined) {
      // 자기 자신 위에 놓기 — 무동작
      if (from.index === index && target.kind !== 'before' && target.kind !== 'after') return Promise.resolve();
      moved = items.splice(from.index, 1)[0]!;
      if (from.index < index) index -= 1;
    } else if (isGroup(src)) {
      const mi = src.paths.indexOf(from.member);
      src.paths = src.paths.filter((p) => p !== from.member);
      if (target.kind === 'member' && from.index === index && mi >= 0 && mi < at) at -= 1;
    }
  }
  const dst = items[index];
  const single = (path: string): PathItem => ({ path, pinned: false });
  switch (target.kind) {
    case 'before':
    case 'after': {
      const pos = target.kind === 'before' ? index : index + 1;
      const top = new Set(items.filter((i) => !isGroup(i)).map((i) => (i as PathItem).path));
      const fresh: RemoteItem[] = moved !== null ? [moved] : paths.filter((p) => !top.has(p)).map(single);
      items.splice(pos, 0, ...fresh);
      break;
    }
    case 'into': {
      if (dst === undefined || isGroup(dst)) break;
      const rest = paths.filter((p) => p !== dst.path);
      if (rest.length > 0) items[index] = { paths: [dst.path, ...rest], pinned: dst.pinned };
      break;
    }
    case 'member': {
      if (dst === undefined || !isGroup(dst)) break;
      dst.paths.splice(at, 0, ...paths.filter((p) => !dst.paths.includes(p)));
      break;
    }
  }
  return setItems(host, items);
}
