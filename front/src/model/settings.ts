// 사용자 설정 (ticket user-settings) — 클라이언트 머신의 `config_dir()/settings.json` 하나를 relay HTTP
// /settings 로 읽고 쓴다 (configfiles 의 tmux·ssh 와 같은 경로, 데몬 와이어 밖). 앱·웹이 같은 relay 를 타므로
// 같은 파일을 본다. 항목별 기본값은 여기 코드(DEFAULTS)에 두고 JSON 에는 기본값과 다른 항목만 적는다
// (VS Code settings.json 방식). 세션 무관 모듈 싱글턴 — 부팅 때 loadSettings 한 번.
// 편집기 JSON 탭(superlite:/settings.json, configfiles)이 저장하면 applySettingsText 로 같은 원장을 갱신한다.
import { reactive } from '@vue/reactivity';
import { backendApiUrl } from './host';
import { errText, notify } from './notifications';
import { urlTarget, type UrlTarget } from './urlRules';

export interface Settings {
  /** URL 열기 분기 — 한 줄에 host 하나 (urlRules 규칙). 내부 = URL 탭, 외부 = OS 브라우저(웹은 새 탭) */
  urlOpen: { internal: string[]; external: string[] };
  /** 언어 id(languages.LanguageDef.id) → 새 편집기 탭의 자동 줄바꿈 기본값. 없는 언어는 끔 */
  wordWrap: Record<string, boolean>;
  /** 비정상 종료(컴퓨터 꺼짐·강제 종료·업데이트) 뒤 시작 때 열려 있던 창을 되살리는 범위 — VS Code window.restoreWindows.
   *  none 없음 / one 마지막 포커스 창(세션 탭 전부) / all 모든 창. 정상 종료(창 X) 뒤에는 늘 빈 세션. 앱 전용 —
   *  native 가 시작 때 settings.json 에서 이 키를 직접 읽는다 (app/src/main restore_mode) */
  restoreWindows: RestoreWindows;
  /** HTML 파일을 열 때 기본 탭 종류 (ticket html-open-as-preview) — preview 미리보기 탭 / source 편집기 탭.
   *  Ctrl+Shift+V 제자리 전환은 어느 쪽이든 그대로 */
  htmlOpen: HtmlOpen;
}
export type RestoreWindows = 'none' | 'one' | 'all';
export type HtmlOpen = 'preview' | 'source';

export const DEFAULTS: Settings = {
  urlOpen: { internal: ['localhost', '[IP]'], external: [] },
  wordWrap: { markdown: true },
  restoreWindows: 'one',
  htmlOpen: 'preview',
};

function cloneDefaults(): Settings {
  return JSON.parse(JSON.stringify(DEFAULTS)) as Settings;
}

export const settings = reactive<Settings>(cloneDefaults());

function strList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** JSON 원문 → settings. 모르는 키·틀린 형태는 무시(기본값 유지), 파싱 실패는 경고 알림 뒤 기본값 */
export function applySettingsText(text: string): void {
  let raw: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) raw = p as Record<string, unknown>;
  } catch (e) {
    notify('warning', `settings.json is not valid JSON, using defaults: ${errText(e)}`);
  }
  const d = cloneDefaults();
  const u = raw.urlOpen as { internal?: unknown; external?: unknown } | undefined;
  settings.urlOpen = {
    internal: strList(u?.internal) ?? d.urlOpen.internal,
    external: strList(u?.external) ?? d.urlOpen.external,
  };
  const w = raw.wordWrap;
  settings.wordWrap = w !== null && typeof w === 'object' && !Array.isArray(w)
    ? Object.fromEntries(Object.entries(w as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
    : d.wordWrap;
  const r = raw.restoreWindows;
  settings.restoreWindows = r === 'none' || r === 'one' || r === 'all' ? r : d.restoreWindows;
  const h = raw.htmlOpen;
  settings.htmlOpen = h === 'preview' || h === 'source' ? h : d.htmlOpen;
}

/** 기본값과 다른 항목만 담은 JSON 원문 — 저장 형태 */
export function settingsText(): string {
  const out: Partial<Settings> = {};
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (JSON.stringify(settings[k]) !== JSON.stringify(DEFAULTS[k])) (out as Record<string, unknown>)[k] = settings[k];
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** relay 가 닿을 때만 (mock·주입 없는 앱 창은 기본값으로만 동작) */
export function settingsEnabled(): boolean {
  return backendApiUrl('/settings') !== null;
}

/** 부팅 때 한 번 — 실패는 알림 뒤 기본값 */
export async function loadSettings(): Promise<void> {
  const url = backendApiUrl('/settings');
  if (url === null) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    applySettingsText(await res.text());
  } catch (e) {
    notify('warning', `Failed to load settings: ${errText(e)}`);
  }
}

/** 설정 UI 가 값을 바꾼 뒤 — 현재 settings 를 파일로. 저장 뒤 후속(열린 JSON 탭 갱신)은 configfiles 몫 */
export async function saveSettings(): Promise<void> {
  const url = backendApiUrl('/settings');
  if (url === null) return notify('warning', 'Settings cannot be saved in this window');
  try {
    const res = await fetch(url, { method: 'PUT', body: settingsText() });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    onSaved?.(settingsText());
  } catch (e) {
    notify('error', `Failed to save settings: ${errText(e)}`);
  }
}

/** 저장 뒤 훅 — configfiles 가 등록해 열린 superlite:/settings.json 탭의 문서를 새 원문으로 맞춘다 */
let onSaved: ((text: string) => void) | null = null;
export function setSettingsSaved(fn: (text: string) => void): void {
  onSaved = fn;
}

/** URL 열기 분기 — window.openUrl 이 부른다 */
export function urlTargetOf(url: string): UrlTarget {
  return urlTarget(url, settings.urlOpen.internal, settings.urlOpen.external);
}

/** 언어별 줄바꿈 기본값 — 새 편집기 탭·override 없는 탭이 쓴다 */
export function wordWrapDefault(languageId: string): boolean {
  return settings.wordWrap[languageId] === true;
}
