import { reactive } from '@vue/reactivity';
import { backendApiUrl, openFolder } from './host';
import type { OpenMode } from './sessions';

/**
 * 원격 탐색기 (SSH) 모델 — 백엔드 머신의 ~/.ssh/config 호스트 목록에 superlight 자체
 * 상태(즐겨찾기·고정·최근 폴더)를 합친 것. 세션과 무관한 앱 전역 상태다.
 *
 * FAVORITE: 사용자가 고른 host (즐겨찾기 순). 고정(fix)은 즐겨찾기에서만 — 고정 시점의
 * config 블록을 백엔드가 저장하고 접속에 그 저장본을 쓴다 (config 에서 사라져도 접속된다).
 * 저장본과 현재 config 가 다르면 drift (이탤릭). 고정 안 한 즐겨찾기가 config 에서 사라지면
 * missing (이탤릭, 접속 불가).
 * ALL: ~/.ssh/config 전체 (config 순), 즐겨찾기인 항목은 별 아이콘.
 * 최근 폴더: 호스트 행을 펼치면 그 호스트에서 연 폴더가 나온다 (VS Code Remote Explorer 의
 * 호스트 하위 폴더) — 클릭이 곧 그 폴더로 접속. relay 가 attach 성공 시 기록한다.
 * pane 접힘 상태는 전역 지속 (백엔드 파일) — 즐겨찾기가 비면 저장값과 무관하게 FAVORITE 닫힘·
 * ALL 열림으로 온다.
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

export interface HostList {
  favorites: RemoteHost[];
  all: RemoteHost[];
  panes: { favorite: boolean; all: boolean };
  /** host → 최근 연 폴더 (원격 절대 경로, 최신순) */
  recent: Record<string, string[]>;
}

export type RemoteOp = 'fav' | 'unfav' | 'pin' | 'unpin' | 'ack' | 'refresh' | 'forget' | 'pane';

export const remote = reactive({
  favorites: [] as RemoteHost[],
  all: [] as RemoteHost[],
  panes: { favorite: true, all: true },
  recent: {} as Record<string, string[]>,
  loaded: false,
  error: null as string | null,
});

function apply(list: HostList): void {
  remote.favorites = list.favorites;
  remote.all = list.all;
  remote.panes = list.panes;
  remote.recent = list.recent;
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
 *  extra 는 forget 의 path / pane 의 open. 실패는 목록 위 오류 줄에 (다음 성공 응답이 지운다) */
export async function setHostState(
  op: RemoteOp,
  host: string,
  extra: Record<string, string> = {},
): Promise<void> {
  try {
    const url = backendApiUrl('/ssh/state', { op, host, ...extra });
    if (url === null) throw new Error('원격 미지원 환경');
    const res = await fetch(url, { method: 'POST' });
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

/** 호스트에 접속 — 경로 없는 `ssh://host` 로 원격 빈 세션(시작 페이지)을 연다. 폴더는 그
 *  세션의 '폴더 열기'가 원격을 탐색해 고른다 (VS Code "Connect to Host" 와 동일).
 *  mode 'replace'=현재 탭 대체(→, "현재 창에 연결") / 'new'=항상 새 탭(새 창 아이콘 — 활성
 *  탭이 빈 세션이어도 대체하지 않는다) */
export function connectHost(host: string, mode: OpenMode): void {
  openFolder(`ssh://${host}`, { mode });
}

/** 최근 폴더로 바로 접속 — path 는 원격 절대 경로 */
export function openRecent(host: string, path: string, mode: OpenMode): void {
  openFolder(`ssh://${host}${path}`, { mode });
}
