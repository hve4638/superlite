import { effect, reactive } from '@vue/reactivity';
import { notify } from './notifications';
import { openFolder } from './host';
import { isRemoteEmpty, remoteHost, sessions, sessionsKind, withHost } from './sessions';
import { tauri } from './tauri';

/**
 * 시작 페이지의 최근 목록 (ticket start-page-recents) — 최근 연 폴더 MRU(개별 root)와 세션
 * 묶음(한 창에 함께 열려 있던 root 집합) 이력. 자동 복원은 없다(app-empty-session) — 사용자가
 * 여기서 골라 명시적으로 다시 연다.
 *
 * 저장소는 환경별 (decision/state-persistence.md version 2):
 * - 앱: native 가 state.json 에 소유·갱신한다 (레지스트리 변경마다). 여기는 list_recents 사영과
 *   forget_*·open_bundle invoke 만.
 * - 웹: 앱 데이터 디렉터리가 없으므로 front 가 같은 스키마를 localStorage 에 둔다 (세션 목록이
 *   front 소유인 것과 같은 이유). 웹은 검증 경로 — 이 환경에서 목록 동작을 볼 수 있어야 한다.
 * - mock: 없음 (목록 비어 있음).
 */

export type RecentEntry = { root: string; missing: boolean };
export const recents = reactive({ recents: [] as RecentEntry[], bundles: [] as RecentEntry[][] });

const RECENTS_MAX = 10;
const BUNDLES_MAX = 5;
const WEB_KEY = 'superlite.state';


/** 표시 이름 — root 의 마지막 요소, 원격은 "이름 [host]" (세션 탭 라벨과 같은 규칙, withHost) */
export function recentLabel(root: string): string {
  const host = remoteHost(root);
  const path = host === null ? root : root.slice(`ssh://${host}`.length);
  const base = path.split('/').filter((s) => s !== '').pop() ?? path;
  return withHost(base, root);
}

// ---- 웹 저장소 (native Persisted 와 같은 모양)

type WebState = { version: number; recents: string[]; bundles: string[][] };

function loadWeb(): WebState {
  try {
    const p = JSON.parse(localStorage.getItem(WEB_KEY) ?? '') as WebState;
    if (p.version === 2) return { version: 2, recents: p.recents ?? [], bundles: p.bundles ?? [] };
  } catch {
    // 없음·파싱 실패 — 빈 상태
  }
  return { version: 2, recents: [], bundles: [] };
}

function saveWeb(p: WebState): void {
  localStorage.setItem(WEB_KEY, JSON.stringify(p));
}

function isSubset(a: string[], b: string[]): boolean {
  return a.every((x) => b.includes(x));
}

/** native note_bundle 과 같은 규칙 — 부분집합이면 기존을 앞으로, 상위집합이면 부분집합들을 대체.
 *  한 작업 흐름의 최대 구성만 남는다 (탭을 열고 닫는 중간 구성이 이력을 채우지 않게) */
function noteBundle(bundles: string[][], roots: string[]): void {
  if (roots.length < 2) return;
  const i = bundles.findIndex((b) => isSubset(roots, b));
  if (i !== -1) {
    const [b] = bundles.splice(i, 1);
    bundles.unshift(b);
    return;
  }
  const kept = bundles.filter((b) => !isSubset(b, roots));
  bundles.splice(0, bundles.length, roots, ...kept);
  bundles.length = Math.min(bundles.length, BUNDLES_MAX);
}

/** 워크스페이스 root 인가 — 빈 세션(null·원격 빈 세션)과 웹 부팅 세션의 서버 기본 root('')는 제외 */
function isWorkspaceRoot(root: string | null): root is string {
  return root !== null && root !== '' && !isRemoteEmpty(root);
}

/** 웹 기록 — 세션 목록 변화를 따라간다. 새로 나타난 root 는 MRU 앞으로, 현재 root 집합은 묶음 이력에 */
function trackWeb(): void {
  let prev = new Set<string>();
  effect(() => {
    const roots = sessions.list.map((t) => t.root).filter(isWorkspaceRoot);
    const p = loadWeb();
    for (const r of roots) {
      if (prev.has(r)) continue;
      p.recents = [r, ...p.recents.filter((x) => x !== r)].slice(0, RECENTS_MAX);
    }
    noteBundle(p.bundles, roots);
    saveWeb(p);
    prev = new Set(roots);
  });
}

// ---- 공개 동작

/** 목록 새로 읽기 — 시작 페이지가 뜰 때와 세션 목록이 바뀔 때 (소실 여부는 앱만 native 가 검사) */
export async function refreshRecents(): Promise<void> {
  const kind = sessionsKind();
  if (kind === 'app' && tauri) {
    const r = (await tauri.core.invoke('list_recents')) as { recents: RecentEntry[]; bundles: RecentEntry[][] };
    recents.recents = r.recents;
    recents.bundles = r.bundles;
  } else if (kind === 'web') {
    const p = loadWeb();
    recents.recents = p.recents.map((root) => ({ root, missing: false }));
    recents.bundles = p.bundles.map((b) => b.map((root) => ({ root, missing: false })));
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

/** 묶음 이력에서 지우기 (×) — 같은 집합인 묶음 */
export async function forgetBundle(roots: string[]): Promise<void> {
  if (sessionsKind() === 'app') await tauri?.core.invoke('forget_bundle', { roots });
  else if (sessionsKind() === 'web') {
    const p = loadWeb();
    p.bundles = p.bundles.filter((b) => !(b.length === roots.length && isSubset(b, roots)));
    saveWeb(p);
  }
  await refreshRecents();
}

/** 묶음 열기 — 앱은 native open_bundle (이 창이 전부 빈 탭이면 이 창에, 아니면 새 창에 — 사용자
 *  결정). 웹은 창이 하나뿐이라 이 페이지에 탭으로 더한다 (첫 root 는 활성 빈 탭을 제자리 교체,
 *  나머지는 새 탭 — openFolder 의 기본·'new' 규칙) */
export function openBundle(roots: string[]): void {
  if (sessionsKind() === 'app') {
    void tauri?.core.invoke('open_bundle', { roots }).catch((e) => notify('error', `묶음을 열 수 없습니다: ${String(e)}`));
    return;
  }
  // 이미 열린 root 는 건너뛴다 (앱 native 와 같은 규칙) — 첫 새 root 가 활성 빈 탭을 차지해 빈 탭이 남지 않게
  const open = new Set(sessions.list.map((t) => t.root));
  roots.filter((r) => !open.has(r)).forEach((r, i) => openFolder(r, i === 0 ? {} : { mode: 'new' }));
}

/** 부팅 시 1회 (main.ts) — 웹은 세션 목록 추적을 건다. 앱은 native 가 기록하므로 할 일 없음 */
export function initRecents(): void {
  if (sessionsKind() === 'web') trackWeb();
}
