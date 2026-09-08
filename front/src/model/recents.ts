import { effect, reactive } from '@vue/reactivity';
import { notify } from './notifications';
import { openFolder } from './host';
import { isRemoteEmpty, remoteHost, sessions, sessionsKind } from './sessions';
import { tauri } from './tauri';

/**
 * 시작 페이지의 목록 (ticket start-page-recents → start-page-redesign) — 최근 연 폴더 MRU(개별 root)와
 * 사용자가 고정한 그룹(Pinned). 자동 복원은 없다(app-empty-session) — 사용자가 여기서 골라 명시적으로
 * 다시 연다.
 *
 * Pinned 는 그룹 목록이고 그룹은 root 하나여도 그룹이다 (2026-09-07 사용자 결정 — 종전 세션 묶음 이력을
 * 대체). 고정된 root 는 MRU 에 들어오지 않고(pin 하면 빠지고 다시 열어도 안 들어옴), × 는 목록에서만
 * 지운다. pin·unpin·순서·그룹 간 이동·별칭은 front 가 결과 목록을 계산해 통째로 저장한다 (setPinned).
 *
 * 저장소는 환경별 (decision/state-persistence.md version 2):
 * - 앱: native 가 state.json 에 소유·갱신한다. 여기는 list_recents 사영과 forget_recent·set_pinned·
 *   open_group·open_groups invoke 만.
 * - 웹: 앱 데이터 디렉터리가 없으므로 front 가 같은 스키마를 localStorage 에 둔다 (세션 목록이
 *   front 소유인 것과 같은 이유). 웹은 검증 경로 — 이 환경에서 목록 동작을 볼 수 있어야 한다.
 * - mock: 없음 (목록 비어 있음).
 */

export type RecentEntry = { root: string; missing: boolean };
export type PinGroup = { alias: string | null; roots: RecentEntry[] };
export const recents = reactive({ recents: [] as RecentEntry[], pinned: [] as PinGroup[] });

const RECENTS_MAX = 64;
const WEB_KEY = 'superlite.state';

/** 표시 이름 — root 의 마지막 요소 (host 없이). 원격 표기는 시작 페이지가 "이름 from host" 로 잇는다
 *  (탭 라벨의 "이름 [host]" 와 다른 시작 페이지 한정 표기 — 2026-09-07 start-page-redesign) */
export function recentName(root: string): string {
  const host = remoteHost(root);
  const path = host === null ? root : root.slice(`ssh://${host}`.length);
  return path.split('/').filter((s) => s !== '').pop() ?? path;
}

/** 그룹 제목 — 별칭, 없으면 첫 멤버 이름에 나머지 수를 붙인다 */
export function groupTitle(g: PinGroup): string {
  if (g.alias !== null) return g.alias;
  const first = g.roots[0] ? recentName(g.roots[0].root) : '';
  return g.roots.length > 1 ? `${first} +${g.roots.length - 1}` : first;
}

// ---- 웹 저장소 (native Persisted 와 같은 모양)

type WebGroup = { alias?: string; roots: string[] };
/** workspaces 는 workspaceState.ts 가 같은 키 안에 두는 워크스페이스별 상태 — 여기서는 통과만 시킨다 */
type WebState = { version: number; recents: string[]; pinned: WebGroup[]; workspaces?: unknown };

function loadWeb(): WebState {
  try {
    const p = JSON.parse(localStorage.getItem(WEB_KEY) ?? '') as WebState;
    if (p.version === 2) return { version: 2, recents: p.recents ?? [], pinned: p.pinned ?? [], workspaces: p.workspaces };
  } catch {
    // 없음·파싱 실패 — 빈 상태
  }
  return { version: 2, recents: [], pinned: [] };
}

function saveWeb(p: WebState): void {
  localStorage.setItem(WEB_KEY, JSON.stringify(p));
}

function isPinnedIn(pinned: WebGroup[], root: string): boolean {
  return pinned.some((g) => g.roots.includes(root));
}

/** 워크스페이스 root 인가 — 빈 세션(null·원격 빈 세션)과 웹 부팅 세션의 서버 기본 root('')는 제외 */
function isWorkspaceRoot(root: string | null): root is string {
  return root !== null && root !== '' && !isRemoteEmpty(root);
}

/** 웹 기록 — 세션 목록 변화를 따라간다. 새로 나타난 root 는 MRU 앞으로 (고정된 root 는 제외) */
function trackWeb(): void {
  let prev = new Set<string>();
  effect(() => {
    const roots = sessions.list.map((t) => t.root).filter(isWorkspaceRoot);
    const p = loadWeb();
    for (const r of roots) {
      if (prev.has(r) || isPinnedIn(p.pinned, r)) continue;
      p.recents = [r, ...p.recents.filter((x) => x !== r)].slice(0, RECENTS_MAX);
    }
    saveWeb(p);
    prev = new Set(roots);
  });
}

/** native normalize_pinned 와 같은 규칙 — 그룹 안 중복은 앞의 것만, 빈 그룹 제거, 빈 별칭은 없음 */
function normalize(groups: WebGroup[]): WebGroup[] {
  return groups
    .map((g) => {
      const alias = g.alias?.trim();
      return { ...(alias ? { alias } : {}), roots: g.roots.filter((r, i) => g.roots.indexOf(r) === i) };
    })
    .filter((g) => g.roots.length > 0);
}

// ---- 공개 동작

/** 목록 새로 읽기 — 시작 페이지가 뜰 때와 세션 목록이 바뀔 때 (소실 여부는 앱만 native 가 검사) */
export async function refreshRecents(): Promise<void> {
  const kind = sessionsKind();
  if (kind === 'app' && tauri) {
    const r = (await tauri.core.invoke('list_recents')) as { recents: RecentEntry[]; pinned: PinGroup[] };
    recents.recents = r.recents;
    recents.pinned = r.pinned;
  } else if (kind === 'web') {
    const p = loadWeb();
    recents.recents = p.recents.map((root) => ({ root, missing: false }));
    recents.pinned = p.pinned.map((g) => ({ alias: g.alias ?? null, roots: g.roots.map((root) => ({ root, missing: false })) }));
  }
}

/** 최근 폴더에서 지우기 (×) */
export async function forgetRecent(root: string): Promise<void> {
  if (sessionsKind() === 'app') await tauri?.core.invoke('forget_recent', { root });
  else if (sessionsKind() === 'web') {
    const p = loadWeb();
    p.recents = p.recents.filter((r) => r !== root);
    saveWeb(p);
  }
  await refreshRecents();
}

/** 고정 그룹 목록 통째로 저장 — 편집 함수들이 현재 목록의 사본을 고쳐 여기로 보낸다. 고정된 root 는
 *  MRU 에서 빠진다 (앱은 native set_pinned 가, 웹은 여기서) */
async function setPinned(groups: WebGroup[]): Promise<void> {
  groups = normalize(groups);
  if (sessionsKind() === 'app') await tauri?.core.invoke('set_pinned', { groups });
  else if (sessionsKind() === 'web') {
    const p = loadWeb();
    p.pinned = groups;
    p.recents = p.recents.filter((r) => !isPinnedIn(groups, r));
    saveWeb(p);
  }
  await refreshRecents();
}

function snapshot(): WebGroup[] {
  return recents.pinned.map((g) => ({ ...(g.alias !== null ? { alias: g.alias } : {}), roots: g.roots.map((e) => e.root) }));
}

/** 드래그 출처 — Pinned 안의 그룹(멤버 없음) 또는 멤버. 밖(Recent·원격 탐색기)에서 온 것은 undefined */
export type PinSource = { group: number; member?: string };

/** 그룹 목록에서 출처를 떼어낸다 — 옮기는 동작의 전반부. 반환은 떼어낸 뒤 목록과 떼어낸 그룹 */
function detach(groups: WebGroup[], from: PinSource | undefined): WebGroup | null {
  if (from === undefined) return null;
  const g = groups[from.group];
  if (g === undefined) return null;
  if (from.member === undefined) {
    groups.splice(from.group, 1);
    return g;
  }
  g.roots = g.roots.filter((r) => r !== from.member);
  return null;
}

/** 새 그룹으로 고정 — Recent 의 pin 아이콘, 그룹 사이·목록 끝 드롭. index 는 떼어내기 전 목록 기준.
 *  출처가 그룹이면 그 그룹(별칭 포함)을 그대로 옮긴다 (순서 변경) */
export function pinAsGroup(roots: string[], index: number, from?: PinSource): Promise<void> {
  const groups = snapshot();
  const moved = detach(groups, from);
  if (from !== undefined && from.member === undefined && from.group < index) index -= 1;
  groups.splice(index, 0, moved ?? { roots });
  return setPinned(groups);
}

/** 기존 그룹에 멤버 추가 — 그룹 위에 드롭은 끝에, 멤버 줄 위·아래에 드롭은 그 자리(at — 떼어내기 전
 *  그 그룹의 인덱스)에. 출처가 그룹이면 그 멤버들이 합쳐진다. 같은 그룹 안 이동은 순서 변경 */
export function pinIntoGroup(roots: string[], group: number, from?: PinSource, at?: number): Promise<void> {
  if (from !== undefined && from.group === group && from.member === undefined) return Promise.resolve();
  const groups = snapshot();
  const target = groups[group];
  let index = at ?? target.roots.length;
  if (from?.group === group && from.member !== undefined && target.roots.indexOf(from.member) < index) index -= 1;
  detach(groups, from);
  target.roots.splice(index, 0, ...roots);
  return setPinned(groups);
}

/** 그룹 통째로 지우기 (제목 줄 ×) — Recent 로 되돌리지 않는다 */
export function unpinGroup(group: number): Promise<void> {
  const groups = snapshot();
  groups.splice(group, 1);
  return setPinned(groups);
}

/** 멤버 하나 지우기 (멤버 줄 ×) — 마지막 멤버면 그룹도 사라진다 */
export function unpinMember(group: number, root: string): Promise<void> {
  const groups = snapshot();
  groups[group].roots = groups[group].roots.filter((r) => r !== root);
  return setPinned(groups);
}

/** 별칭 지정 — 빈 문자열은 없음 */
export function setGroupAlias(group: number, alias: string): Promise<void> {
  const groups = snapshot();
  groups[group].alias = alias;
  return setPinned(groups);
}

/** 그룹 열기 (제목 클릭) — 앱은 native open_group (이 창이 전부 빈 탭이면 이 창에, 아니면 새 창에 — 사용자
 *  결정). 웹은 창이 하나뿐이라 이 페이지에 탭으로 더한다 (첫 root 는 활성 빈 탭을 제자리 교체,
 *  나머지는 새 탭 — openFolder 의 기본·'new' 규칙) */
export function openGroup(roots: string[]): void {
  if (sessionsKind() === 'app') {
    void tauri?.core.invoke('open_group', { roots }).catch((e) => notify('error', `그룹을 열 수 없습니다: ${String(e)}`));
    return;
  }
  // 이미 열린 root 는 건너뛴다 (앱 native 와 같은 규칙) — 첫 새 root 가 활성 빈 탭을 차지해 빈 탭이 남지 않게
  const open = new Set(sessions.list.map((t) => t.root));
  roots.filter((r) => !open.has(r)).forEach((r, i) => openFolder(r, i === 0 ? {} : { mode: 'new' }));
}

/** 일괄 열기 (시작 페이지 "Open Selected", ticket window-virtual-desktop) — 번호 순서의 그룹들을 native
 *  open_groups 로 한꺼번에 연다 (그룹마다 open_group 의 창 배분 규칙, desktop 은 Windows 가상 데스크톱
 *  순번 — null 이면 옮기지 않음). 앱 전용 — 웹은 선택 자체가 불가능해 호출되지 않는다 */
export function openGroups(groups: { roots: string[]; desktop: number | null }[]): void {
  if (sessionsKind() !== 'app') return;
  void tauri?.core.invoke('open_groups', { groups }).catch((e) => notify('error', `그룹을 열 수 없습니다: ${String(e)}`));
}

/** 부팅 시 1회 (main.ts) — 웹은 세션 목록 추적을 건다. 앱은 native 가 기록하므로 할 일 없음 */
export function initRecents(): void {
  if (sessionsKind() === 'web') trackWeb();
}
