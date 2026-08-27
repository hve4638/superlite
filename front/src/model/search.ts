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

export async function runSearch(): Promise<void> {
  if (!search.query) return;
  const mySeq = ++seq;
  const results = await backend.search(search.query, { caseSensitive: search.caseSensitive });
  if (mySeq !== seq) return; // 그 사이 새 검색/클리어가 발생
  search.results = results;
  search.collapsed = new Set();
  search.done = true;
}

export function matchCount(): number {
  return search.results.reduce((n, f) => n + f.matches.reduce((m, x) => m + x.ranges.length, 0), 0);
}

export function toggleCase(): void {
  search.caseSensitive = !search.caseSensitive;
  if (search.query) void runSearch();
}

export function toggleFileCollapsed(path: string): void {
  if (search.collapsed.has(path)) search.collapsed.delete(path);
  else search.collapsed.add(path);
}
