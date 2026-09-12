// 클라이언트(relay 가 도는 머신) 설정 파일을 편집기 탭으로 (ticket config-editors) — tmux 프로필과
// ~/.ssh/config. 워크스페이스 파일이 아니라 가상 경로 `superlite:/...` 로 탭·문서를 열고, editors 가
// 이 경로를 만나면 데몬 readFile/writeFile 대신 여기의 readConfig/writeConfig(relay HTTP)를 탄다.
// 원격 세션에서 열어도 원격 머신이 아니라 클라이언트 머신의 파일이다 — 탭 툴팁이 실제 경로를 보인다.
// tmux 프로필: 목록·active 는 relay 가 원장(`config_dir()/tmux/`), 여기는 사이드바 폼용 캐시.
// 사용자 설정 원문 탭 `superlite:/settings.json` 도 같은 방식 (relay /settings, ticket user-settings) — 저장하면
// model/settings 원장을 갱신하고, 설정 폼이 저장하면 열린 원문 탭을 따라 맞춘다.
import { reactive } from '@vue/reactivity';
import { ctx } from './ctx';
import { backendApiUrl } from './host';
import { allSessionCtxs } from './sessions';
import { refreshHosts } from './remote';
import { errText, notify } from './notifications';
import { applySettingsText, setSettingsSaved } from './settings';

const PREFIX = 'superlite:/';
const TMUX_PREFIX = `${PREFIX}tmux/`;
export const SSH_CONFIG_PATH = `${PREFIX}ssh/config`;
export const SETTINGS_PATH = `${PREFIX}settings.json`;

export function tmuxProfilePath(name: string): string {
  return `${TMUX_PREFIX}${name}.conf`;
}
export function isConfigPath(path: string): boolean {
  return path.startsWith(PREFIX);
}
/** 가상 경로의 tmux 프로필 이름 — tmux 프로필이 아니면 null */
export function tmuxProfileOf(path: string): string | null {
  return path.startsWith(TMUX_PREFIX) && path.endsWith('.conf') ? path.slice(TMUX_PREFIX.length, -'.conf'.length) : null;
}

/** 탭 라벨 — "tmux.conf (default)" · "ssh config" · "settings.json" */
export function configLabel(path: string): string {
  const prof = tmuxProfileOf(path);
  if (prof !== null) return `tmux.conf (${prof})`;
  return path === SSH_CONFIG_PATH ? 'ssh config' : path.slice(PREFIX.length);
}

/** 읽기 전용 문서 — default 프로필은 내장 기본 설정 원문이라 편집·저장이 없다 (사용자 결정 2026-09-10) */
export function configReadOnly(path: string): boolean {
  return tmuxProfileOf(path) === 'default';
}

/** 탭 툴팁 — 클라이언트 머신의 실제 경로 (목록을 아직 못 읽었으면 종류만). default 는 내장값임을 밝힌다 */
export function configTooltip(path: string): string {
  const prof = tmuxProfileOf(path);
  if (prof === 'default') return 'Built-in default tmux.conf (read-only) — new profiles start from this';
  const real = prof !== null
    ? tmuxProfiles.dir && `${tmuxProfiles.dir}/${prof}.conf`
    : path === SSH_CONFIG_PATH ? tmuxProfiles.sshConfig : path === SETTINGS_PATH ? tmuxProfiles.settings : '';
  return `This machine (not the remote): ${real || configLabel(path)}`;
}

/** 편집 가능 여부 — relay HTTP 가 닿을 때만 (mock·주입 없는 앱 창은 불가) */
export function configEnabled(): boolean {
  return backendApiUrl('/tmux-conf') !== null;
}

function urlOf(path: string): string {
  const prof = tmuxProfileOf(path);
  const url = prof !== null ? backendApiUrl('/tmux-conf', { profile: prof })
    : path === SETTINGS_PATH ? backendApiUrl('/settings') : backendApiUrl('/ssh-config');
  if (url === null) throw new Error('backend config files are not available here');
  return url;
}

export async function readConfig(path: string): Promise<string> {
  const res = await fetch(urlOf(path));
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.text();
}

/** 저장 뒤 후속: active tmux 프로필이면 접속 중인 모든 데몬에 즉시 적용, ssh config 면 호스트 목록 갱신,
 *  settings.json 이면 설정 원장 갱신 */
export async function writeConfig(path: string, content: string): Promise<void> {
  const res = await fetch(urlOf(path), { method: 'PUT', body: content });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const prof = tmuxProfileOf(path);
  if (path === SETTINGS_PATH) {
    applySettingsText(content);
  } else if (prof === null) {
    void refreshHosts();
  } else if (prof === tmuxProfiles.active) {
    await applyTmuxConf(content);
  }
}

// 설정 폼이 저장하면 열린 원문 탭(어느 세션이든)을 새 원문으로 — 미저장 편집 중인 탭은 건드리지 않는다 (reloadDocFromDisk 규칙)
setSettingsSaved((text) => {
  for (const c of allSessionCtxs()) c.editors.reloadDocFromDisk(SETTINGS_PATH, { content: text, etag: '' });
});

// ---- tmux 프로필 폼 (사이드바 터미널 뷰)

export const tmuxProfiles = reactive({
  active: 'default',
  names: ['default'] as string[],
  /** 프로필 폴더의 실제 경로 — 툴팁용. 목록을 읽기 전엔 '' */
  dir: '',
  sshConfig: '',
  /** settings.json 실제 경로 — 툴팁용 */
  settings: '',
});

function takeList(l: { active: string; names: string[]; dir: string; sshConfig: string; settings: string }): void {
  tmuxProfiles.active = l.active;
  tmuxProfiles.names = l.names;
  tmuxProfiles.dir = l.dir;
  tmuxProfiles.sshConfig = l.sshConfig;
  tmuxProfiles.settings = l.settings;
}

export async function refreshTmuxProfiles(): Promise<void> {
  const url = backendApiUrl('/tmux-conf/profiles');
  if (url === null) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  takeList(await res.json());
}

/** create(빈 파일)·clone(from 복사)·delete — 응답 목록으로 갈아끼운다. delete 가 active 를 지웠으면
 *  relay 가 default 로 돌리므로 그 내용을 데몬에 다시 적용한다 */
export async function updateTmuxProfiles(op: 'create' | 'clone' | 'delete', name: string, from?: string): Promise<void> {
  const url = backendApiUrl('/tmux-conf/profiles', { op, name, ...(from ? { from } : {}) });
  if (url === null) return;
  const before = tmuxProfiles.active;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  takeList(await res.json());
  if (op === 'delete') {
    ctx().editors.closePathTabs(tmuxProfilePath(name));
    if (before !== tmuxProfiles.active) await applyTmuxConf(await readConfig(tmuxProfilePath(tmuxProfiles.active)));
  }
}

/** 적용 프로필 전환 — relay 의 active 를 바꾸고 접속 중인 모든 데몬에 그 내용을 즉시 적용한다 */
export async function selectTmuxProfile(name: string): Promise<void> {
  const url = backendApiUrl('/tmux-conf/profiles', { op: 'select', name });
  if (url === null) return;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  takeList(await res.json());
  await applyTmuxConf(await readConfig(tmuxProfilePath(name)));
}

/** 열려 있는 모든 세션의 데몬(로컬·원격)에 tmuxConf — tmux 가 낸 경고는 알림으로. 이후 접속은 relay 가
 *  attach 직후 active 프로필을 밀어 넣는다 */
async function applyTmuxConf(content: string): Promise<void> {
  for (const c of allSessionCtxs()) {
    const msg = await c.backend.applyTmuxConf?.(content).catch((e) => errText(e));
    if (msg) notify('warning', `tmux.conf: ${msg}`);
  }
}

// ---- 진입점 (팔레트·사이드바)

/** 목록을 아직 안 읽었으면(사이드바 터미널 뷰를 열기 전) 읽어 둔다 — 적용 프로필 이름과 툴팁의 실제 경로용 */
async function ensureProfiles(): Promise<void> {
  if (!tmuxProfiles.dir) await refreshTmuxProfiles().catch(() => {});
}
/** 프로필 탭 열기 — name 생략은 적용 프로필 (목록을 먼저 읽는다 — 안 읽은 채 열면 늘 default 였다) */
export async function openTmuxConf(name?: string): Promise<void> {
  if (!configEnabled()) return notify('warning', 'tmux.conf is not editable in this window');
  await ensureProfiles();
  await ctx().editors.openFile(tmuxProfilePath(name ?? tmuxProfiles.active));
}
export function openSshConfig(): void {
  if (!configEnabled()) return notify('warning', 'SSH config is not editable in this window');
  void ensureProfiles();
  void ctx().editors.openFile(SSH_CONFIG_PATH);
}
/** "Preferences: Open Settings (JSON)" — 사용자 설정 원문 탭 (폼은 editors.openSettings) */
export function openSettingsJson(): void {
  if (!configEnabled()) return notify('warning', 'Settings are not editable in this window');
  void ensureProfiles();
  void ctx().editors.openFile(SETTINGS_PATH);
}
