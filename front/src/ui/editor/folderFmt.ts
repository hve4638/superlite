import type { DirEntry } from '../../backend/types';

// 폴더 탭 자세히 보기·아이콘 보기의 표시 서식 — 순수 함수 (Windows 탐색기 열 근사)

/** 수정한 날짜 — 로컬 'YYYY-MM-DD HH:mm'. mtime 없으면 빈 문자열 */
export function fmtDate(ms: number | undefined): string {
  if (ms === undefined) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 크기 — KB 단위 올림 (Windows 탐색기 동일: 1 byte 도 '1 KB'). 없으면 빈 문자열 */
export function fmtSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024)).toLocaleString()} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 유형 — 폴더 / '<EXT> File' / 'File' */
export function typeOf(e: DirEntry): string {
  if (e.kind === 'directory') return 'File folder';
  const dot = e.name.lastIndexOf('.');
  return dot > 0 ? `${e.name.slice(dot + 1).toUpperCase()} File` : 'File';
}
