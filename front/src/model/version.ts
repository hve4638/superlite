/**
 * 빌드 정보 — relay 의 GET /version (버전·커밋·빌드 시각·WIRE_VERSION·데몬 경로). 데몬 와이어
 * 밖 HTTP 라 웹·앱이 같은 경로를 타고 WIRE_VERSION 은 불변 (ticket release-versioning).
 * 명령 팔레트 "Help: About" 다이얼로그와 시작 페이지 하단 표기가 쓴다. mock(backendApiUrl null)
 * 은 info 가 영영 null — 표기 자리는 비운다.
 */
import { reactive } from '@vue/reactivity';
import { backendApiUrl } from './host';

export interface VersionInfo {
  version: string;
  commit: string;
  builtAt: string;
  wire: number;
  daemonBin: string;
}

export const version = reactive({
  info: null as VersionInfo | null,
  error: null as string | null,
  aboutOpen: false,
});

let fetched: Promise<void> | null = null;

/** 한 번만 조회 — 빌드 정보는 프로세스 수명 동안 불변이다 */
export function loadVersion(): Promise<void> {
  if (fetched) return fetched;
  fetched = (async () => {
    const url = backendApiUrl('/version');
    if (url === null) return;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
      version.info = (await res.json()) as VersionInfo;
    } catch (e) {
      version.error = e instanceof Error ? e.message : String(e);
    }
  })();
  return fetched;
}

/** 시작 페이지 하단 한 줄 — "0.1.0 (8700a11)" */
export function shortVersion(): string | null {
  const v = version.info;
  return v ? `${v.version} (${v.commit})` : null;
}

/** About 본문 — 다이얼로그 표시와 클립보드 복사가 같은 텍스트를 쓴다 */
export function aboutText(): string {
  const v = version.info;
  if (!v) return version.error ? `Build info unavailable: ${version.error}` : 'Build info unavailable (no backend)';
  return [
    `Version: ${v.version}`,
    `Commit: ${v.commit}`,
    `Built: ${v.builtAt}`,
    `Wire: ${v.wire}`,
    `Daemon: ${v.daemonBin}`,
  ].join('\n');
}

export function showAbout(): void {
  void loadVersion();
  version.aboutOpen = true;
}

export function closeAbout(): void {
  version.aboutOpen = false;
}
