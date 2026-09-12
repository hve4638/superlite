// URL 열기 분기 규칙 (ticket user-settings) — host 를 내부 목록·외부 목록과 대조해 내부 URL 탭인지
// 외부 브라우저인지 정한다. 순수 함수 — 설정 저장소(settings)와 무관, Node 로 바로 검증한다 (check-urlrules.mjs).
//
// 줄 하나 = host 하나. 서브도메인 포함(google.com 이 docs.google.com 도), 포트는 URL 파싱이 이미 뗐다.
// 예약어: `[IP]` = IP 주소 형태 전부, `[DOMAIN]` = 도메인 이름 형태 전부, `*` = 무엇이든.
// 두 목록이 다 맞으면 더 구체적인 줄이 이긴다 (정확 일치 > 서브도메인 일치 > [IP]·[DOMAIN] > *) — 외부
// 목록이 내부 `*` 의 예외 목록 노릇을 하고 그 반대도 된다. 같은 구체성이면 내부. 어느 쪽에도 없으면 외부
// (사용자 결정 2026-09-12). 빈 줄·`#` 주석 줄은 무시.

export type UrlTarget = 'internal' | 'external';

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]*:[0-9a-f:]*\]?)$/i;

/** 줄 하나의 구체성 — 0 은 불일치 */
function specificity(host: string, line: string): number {
  if (line === '*') return 1;
  if (line === '[IP]') return IP_RE.test(host) ? 2 : 0;
  if (line === '[DOMAIN]') return !IP_RE.test(host) ? 2 : 0;
  const l = line.toLowerCase();
  if (host === l) return 4;
  return host.endsWith(`.${l}`) ? 3 : 0;
}

function best(host: string, lines: string[]): number {
  let max = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    max = Math.max(max, specificity(host, line));
  }
  return max;
}

/** url 의 host 를 두 목록과 대조 — 파싱 불가한 url 은 외부 */
export function urlTarget(url: string, internal: string[], external: string[]): UrlTarget {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'external';
  }
  const i = best(host, internal);
  return i > 0 && i >= best(host, external) ? 'internal' : 'external';
}
