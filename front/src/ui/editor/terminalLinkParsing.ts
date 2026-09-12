/*---------------------------------------------------------------------------------------------
 *  Ported from VS Code src/vs/workbench/contrib/terminalContrib/links/browser/terminalLinkParsing.ts
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See THIRD-PARTY.md (VS Code terminal link parsing).
 *--------------------------------------------------------------------------------------------*/

// 터미널 한 줄의 텍스트에서 경로 후보를 뽑는다 (ticket terminal-path-links). 실존 검증은 하지 않는다 —
// 그것은 terminalPathLinks 가 데몬 stat 으로 한다. VS Code 원본에서 가져온 것: 줄·컬럼 접미 정규식
// (`:12:3`, `(12,3)`, ` line 12` …)과 유닉스·Windows 경로 절. 버린 것: git diff 접두 보정·괄호 안 재시도
// (ponytail — 필요해지면 원본에서 다시 가져온다). 순수 함수라 node --test 로 검증한다 (front/test)

export type LinkOs = 'unix' | 'windows';

export interface ParsedLink {
  /** 줄 안 시작 오프셋 (0 기반) — 밑줄 범위의 시작 */
  index: number;
  /** 밑줄 범위 전체 텍스트 (경로 + 접미) */
  text: string;
  /** 경로 부분만 (접미·따옴표 제외) */
  path: string;
  row?: number;
  col?: number;
}

let ri = 0;
let ci = 0;
let rei = 0;
let cei = 0;
const r = (): string => `(?<row${ri++}>\\d+)`;
const c = (): string => `(?<col${ci++}>\\d+)`;
const re = (): string => `(?<rowEnd${rei++}>\\d+)`;
const ce = (): string => `(?<colEnd${cei++}>\\d+)`;

// 원본 주석의 범례: Path=foo, Row=339, Col=12, RowEnd=341, ColEnd=789. ' 와 ", () 와 [] 는 서로 바꿔 쓸 수 있다
const lineAndColumnRegexClauses = [
  // foo:339 / foo:339:12 / foo:339:12-789 / foo:339:12-341.789 / foo:339.12 / foo 339 / foo 339:12 / foo#339 /
  // "foo",339 / "foo",339:12 / "foo",339.12-341.789
  `(?::|#| |['"],|, )${r()}([:.]${c()}(?:-(?:${re()}\\.)?${ce()})?)?`,
  // "foo", line 339 / "foo", line 339, col 12 / "foo":line 339 / "foo" on line 339, column 12 /
  // "foo", line 339, characters 12-789 / "foo", lines 339-341
  `['"]?(?:,? |: ?| on )lines? ${r()}(?:-${re()})?(?:,? (?:col(?:umn)?|characters?) ${c()}(?:-${ce()})?)?`,
  // foo(339) / foo(339,12) / foo (339, 12) / foo: (339) / foo(339:12)
  `:? ?[\\[\\(]${r()}(?:(?:, ?|:)${c()})?[\\]\\)]`,
];
const suffixClause = lineAndColumnRegexClauses.join('|').replace(/ /g, '[\u00A0 ]');
const linkSuffixRegex = new RegExp(`(${suffixClause})`, 'g');

// 접미 앞의 경로 문자 — 첫 [] 는 경로가 시작할 수 없는 문자, 둘째 [] 는 경로 안에 올 수 없는 문자
const linkWithSuffixPathCharacters = /(?<path>(?:file:\/\/\/)?[^\s|<>[({][^\s|<>]*)$/;

// '":; 는 경로에 올 수 있지만 대개 구분자라 제외한다. \\ 는 백트래킹 폭주(#24795) 방지로 유닉스 절에서 제외
const PathPrefix = '(?:\\.\\.?|\\~|file:\\/\\/)';
const PathSeparatorClause = '\\/';
const ExcludedPathCharactersClause = '[^\\0<>\\?\\s!`&*()\'":;\\\\]';
const ExcludedStartPathCharactersClause = '[^\\0<>\\?\\s!`&*()\\[\\]\'":;\\\\]';
const WinOtherPathPrefix = '\\.\\.?|\\~';
const WinPathSeparatorClause = '(?:\\\\|\\/)';
const WinExcludedPathCharactersClause = '[^\\0<>\\?\\|\\/\\s!`&*()\'":;]';
const WinExcludedStartPathCharactersClause = '[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]\'":;]';

/** `/foo`, `~/foo`, `./foo`, `../foo`, `foo/bar` */
const unixLocalLinkClause =
  '(?:(?:' + PathPrefix + '|(?:' + ExcludedStartPathCharactersClause + ExcludedPathCharactersClause + '*))?(?:' +
  PathSeparatorClause + '(?:' + ExcludedPathCharactersClause + ')+)+)';
/** `C:`, `c:`, `file:///c:`, `\\?\C:` */
const winDrivePrefix = '(?:\\\\\\\\\\?\\\\|file:\\/\\/\\/)?[a-zA-Z]:';
/** `\\?\c:\foo`, `c:\foo`, `~\foo`, `.\foo`, `..\foo`, `foo\bar` */
const winLocalLinkClause =
  '(?:(?:' + `(?:${winDrivePrefix}|${WinOtherPathPrefix})` + '|(?:' + WinExcludedStartPathCharactersClause +
  WinExcludedPathCharactersClause + '*))?(?:' + WinPathSeparatorClause + '(?:' + WinExcludedPathCharactersClause + ')+)+)';
const unixPathRegex = new RegExp(unixLocalLinkClause, 'g');
const winPathRegex = new RegExp(winLocalLinkClause, 'g');

/** 한 줄의 경로 후보 — 접미 있는 것을 먼저 찾고, 접미 없는 경로는 겹치지 않는 것만 더한다.
 *  구분자 없는 낱말(`itir.toml`)은 후보가 아니다 — 경로인지 모호해 난잡하다는 사용자 결정 2026-09-12, `./itir.toml` 은 잡힌다 */
export function detectLinks(line: string, os: LinkOs): ParsedLink[] {
  const results = detectLinksViaSuffix(line);
  for (const p of detectPathsNoSuffix(line, os)) {
    const end = p.index + p.text.length;
    if (!results.some((q) => p.index < q.index + q.text.length && q.index < end)) results.push(p);
  }
  return results.sort((a, b) => a.index - b.index);
}

function parseIntOptional(v: string | undefined): number | undefined {
  return v === undefined ? undefined : parseInt(v);
}

function detectLinksViaSuffix(line: string): ParsedLink[] {
  const results: ParsedLink[] = [];
  linkSuffixRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = linkSuffixRegex.exec(line)) !== null) {
    const groups = match.groups ?? {};
    const suffixIndex = match.index;
    const suffixText = match[0];
    // 접미 뒤에 `/` 가 오면 경로의 일부다 (git diff 의 `1/` 접두 등)
    if (line[suffixIndex + suffixText.length] === '/') continue;
    const before = line.substring(0, suffixIndex);
    const m = before.match(linkWithSuffixPathCharacters);
    if (!m || m.index === undefined || !m.groups?.path) continue;
    let start = m.index;
    let path = m.groups.path;
    // 여는 따옴표는 경로가 아니다 (밑줄에도 넣지 않는다 — 원본과 달리 prefix 를 따로 들지 않는다)
    const prefix = path.match(/^['"]+/)?.[0] ?? '';
    if (prefix) {
      path = path.substring(prefix.length);
      start += prefix.length;
      if (path.trim().length === 0) continue;
    }
    results.push({
      index: start,
      text: path + suffixText,
      path,
      row: parseIntOptional(groups.row0 || groups.row1 || groups.row2),
      col: parseIntOptional(groups.col0 || groups.col1 || groups.col2),
    });
  }
  return results;
}

function detectPathsNoSuffix(line: string, os: LinkOs): ParsedLink[] {
  const results: ParsedLink[] = [];
  const regex = os === 'windows' ? winPathRegex : unixPathRegex;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const text = match[0];
    if (!text) break;
    // 원본과 다른 점: `//host/x` 는 URL(`https://host/x`)의 잔해라 버린다 — 웹 링크 제공자 몫이고 stat 만 낭비한다
    if (text.startsWith('//')) continue;
    results.push({ index: match.index, text, path: text });
  }
  return results;
}
