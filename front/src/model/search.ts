import { reactive } from '@vue/reactivity';
import { backend } from './host';
import type { FileSearchResult } from '../backend/types';

export const search = reactive({
  query: '',
  caseSensitive: false,
  results: [] as FileSearchResult[],
  /** 접힌 파일 경로 (기본 전부 펼침) */
  collapsed: new Set<string>(),
  done: false,
});

let timer: ReturnType<typeof setTimeout> | undefined;
// WHY: 실제 백엔드는 왕복 지연이 있어 응답이 뒤섞일 수 있다 — 시퀀스 토큰으로
//      "지운 쿼리의 결과가 나중에 도착해 빈 입력 밑에 결과가 남는" 문제를 막는다.
let seq = 0;

/** 입력 디바운스 200ms — VS Code 검색 뷰와 동일한 체감 */
export function setQuery(q: string): void {
  search.query = q;
  clearTimeout(timer);
  if (!q) {
    seq += 1; // 진행 중 검색 무효화
    search.results = [];
    search.done = false;
    return;
  }
  timer = setTimeout(runSearch, 200);
}

async function execSearch(preserveCollapsed: boolean): Promise<void> {
  if (!search.query) return;
  const mySeq = ++seq;
  const results = await backend.search(search.query, { caseSensitive: search.caseSensitive });
  if (mySeq !== seq) return; // 그 사이 새 검색/클리어가 발생
  search.results = results;
  if (!preserveCollapsed) search.collapsed = new Set();
  search.done = true;
}

export function runSearch(): Promise<void> {
  return execSearch(false);
}

/** 파일 변경에 의한 자동 재실행 — 결과가 떠 있을 때만. 사용자가 접어 둔 파일은 그대로
 *  둔다 (자동 갱신이 접힘을 풀면 성가시다 — VS Code 동일). 250ms 디바운스는 watch 몫 */
export function autoRerunSearch(): Promise<void> {
  if (!search.done) return Promise.resolve();
  return execSearch(true);
}

export function matchCount(): number {
  return search.results.reduce((n, f) => n + f.matches.reduce((m, x) => m + x.ranges.length, 0), 0);
}

export function toggleCase(): void {
  search.caseSensitive = !search.caseSensitive;
  if (search.query) void runSearch();
}

/** 타이틀 액션 Clear — 질의·결과·접힘을 초기 상태로 */
export function clearSearch(): void {
  clearTimeout(timer);
  seq += 1; // 진행 중 검색 무효화
  search.query = '';
  search.results = [];
  search.collapsed = new Set();
  search.done = false;
}

/** 타이틀 액션 Collapse All — 결과의 모든 파일 그룹을 접는다 */
export function collapseAllResults(): void {
  search.collapsed = new Set(search.results.map((f) => f.path));
}

export function toggleFileCollapsed(path: string): void {
  if (search.collapsed.has(path)) search.collapsed.delete(path);
  else search.collapsed.add(path);
}
