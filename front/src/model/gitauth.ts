/**
 * git 인증 (ticket scm-subrepo-credential) — https 원격의 사용자명·토큰을 클라이언트(이 브라우저·앱)에만
 * 보관하고, git 이 credential helper 규약으로 보내는 요청(host.ts handleRequest 'credential' — 데몬 실행
 * 파일이 helper 로 등록돼 get/store/erase 를 중계)에 답한다. 그 머신의 helper(Git for Windows 의 GCM
 * 등)가 목록 앞에 있어 먼저 답하고, 비었을 때만 여기 차례다 (VS Code 동일 — 2026-09-07 결정). 성공하면
 * store, 인증 실패면 erase 가 와서 잘못 기억한 자격은 자동으로 지워진다 (2026-09-08).
 *
 * 저장은 relay 의 /git/credentials (gitcred 모듈 — 사용자 머신의 OS 키체인, 없으면 0600 파일로 강등).
 * 앱은 relay 를 내장하고 웹은 relay 에 붙으므로 앱·웹이 같은 저장소를 쓰고, 브라우저 저장소에는 토큰이
 * 남지 않는다 — git 이 물을 때마다 받아 메모리로만 쓴다 (VS Code SecretStorage 수준, 2026-09-08 결정;
 * 종전 localStorage 는 접속한 브라우저마다 사본이 남고 XSS 로 읽혔다). 여기 드는 목록(credentials)은
 * 호스트·사용자명·라벨뿐이다. GitHub 는 device flow 로 로그인 (OAuth App client ID 는 사용자가 등록 —
 * 비밀이 아니라 localStorage), 그 외 호스트는 수동 등록. 대화상자는 ScmView 의 GitAuthDialog 가 이
 * 모듈의 상태(prompt·device·manual)를 보고 띄운다. mock(백엔드 없음)은 메모리 목록.
 *
 * ponytail: 호스트별 계정 하나 (같은 호스트에 계정 둘은 나중 것이 덮는다).
 */
import { reactive } from '@vue/reactivity';
import { backendApiUrl } from './host';
import { errText, notify } from './notifications';
import { showViewlet } from './workbench';

export interface GitCredential {
  /** 원격 호스트 (URL host — "github.com", "gitlab.example.com:8443") */
  host: string;
  username: string;
  /** 비밀번호 또는 토큰 */
  secret: string;
  /** 표시용 출처 — GitHub 로그인은 "GitHub", 수동은 없음 */
  label?: string;
}

/** 목록 항목 — 토큰 없음. insecure: 키체인 부재로 백엔드 머신의 파일에 저장된 항목 */
export interface GitCredentialInfo {
  host: string;
  username: string;
  label?: string;
  insecure: boolean;
}

/** git 의 credential get 이 기다리는 프롬프트 하나 — 대화상자의 확정/취소가 resolve/reject 를 부른다 */
export interface AskPrompt {
  host: string;
  /** 원격 URL 에 박힌 사용자명 (없으면 '') — 입력란 초기값 */
  username: string;
  resolve(answer: PromptAnswer): void;
  reject(e: Error): void;
}

/** git credential 규약의 요청 (데몬 credential_main 이 stdin 을 해석해 보낸다) */
export interface CredentialRequest {
  action: 'get' | 'store' | 'erase';
  protocol?: string;
  host?: string;
  username?: string;
  path?: string;
}

export interface PromptAnswer {
  username: string;
  secret: string;
  /** relay 저장소(OS 키체인)에 기억 (git 이 store 를 보낸 뒤 addCredential) — 아니면 이번 명령이 끝날 때까지만 (transient) */
  remember: boolean;
}

export type DeviceFlow =
  | { step: 'clientId' }
  | { step: 'code'; userCode: string; verificationUri: string }
  | { step: 'error'; message: string };

const CLIENT_ID_KEY = 'superlite.githubClientId';

export const gitAuth = reactive({
  /** 저장된 자격 목록 (토큰 없음) — refreshCredentials 가 relay 에서 받는다 */
  credentials: [] as GitCredentialInfo[],
  /** 백엔드 머신에 OS 키체인이 있는지 — null 은 아직 모름. 대화상자의 '기억' 안내 문구 */
  keychain: null as boolean | null,
  githubClientId: localStorage.getItem(CLIENT_ID_KEY) ?? '',
  prompt: null as AskPrompt | null,
  device: null as DeviceFlow | null,
  /** 수동 등록 대화상자 열림 */
  manual: false,
});

/** mock(백엔드 없음) 의 메모리 저장소 — 새로고침에 사라진다 */
const memory = new Map<string, GitCredential>();

function api(query: Record<string, string>): string | null {
  return backendApiUrl('/git/credentials', query);
}

/** 목록 재조회 — SCM 뷰가 열릴 때·저장/삭제 뒤 */
export async function refreshCredentials(): Promise<void> {
  const url = api({});
  if (url === null) {
    gitAuth.credentials = [...memory.values()].map((c) => ({ host: c.host, username: c.username, label: c.label, insecure: true }));
    gitAuth.keychain = false;
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const v = (await res.json()) as { keychain: boolean; items: GitCredentialInfo[] };
    gitAuth.credentials = v.items;
    gitAuth.keychain = v.keychain;
  } catch (e) {
    notify('error', `Failed to load git credentials: ${errText(e)}`);
  }
}

/** 호스트의 토큰까지 — git 이 물을 때만 받는다 (메모리 밖에 남기지 않는다) */
async function fetchSecret(host: string): Promise<GitCredential | null> {
  const url = api({ host });
  if (url === null) return memory.get(host) ?? null;
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  const v = (await res.json()) as { username: string; secret: string; label?: string } | null;
  return v ? { host, ...v } : null;
}

/** 저장 (호스트별 하나 — 같은 호스트는 덮음). 키체인 부재면 파일 강등 — 한 번 알린다 */
export async function addCredential(cred: GitCredential): Promise<void> {
  const url = api({ action: 'set', host: cred.host, username: cred.username, ...(cred.label ? { label: cred.label } : {}) });
  if (url === null) {
    memory.set(cred.host, cred);
  } else {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: cred.secret });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const v = (await res.json()) as { insecure: boolean };
    if (v.insecure) notify('warning', `No OS keychain on the backend machine — the token for ${cred.host} was saved to a private file instead`);
  }
  await refreshCredentials();
}

export async function removeCredential(host: string): Promise<void> {
  const url = api({ action: 'delete', host });
  if (url === null) memory.delete(host);
  else {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  }
  await refreshCredentials();
}

// ---- git credential helper (get / store / erase)

/** get 에서 대화상자로 받은 자격 — store 가 오면 remember 에 따라 영속, erase 면 폐기 */
const transient = new Map<string, GitCredential & { remember: boolean }>();

let queue: Promise<unknown> = Promise.resolve();

/**
 * git credential 요청 하나에 답한다. get: 저장·임시 자격이 있으면 대화상자 없이, 없으면 SCM 뷰를 열고
 * 대화상자로 묻는다 (취소는 null — git 은 다음 수단으로: 터미널이면 자기 프롬프트, 데몬 실행이면 실패).
 * store: 대화상자 답이 성공했다는 뜻 — remember 면 relay 저장소(addCredential)에. erase: 그 자격이 거부됐다 — 저장·
 * 임시 모두 지우고 알린다 (다음 시도는 다시 묻는다). 대화상자는 한 번에 하나 — 동시 요청은 줄 세운다
 */
export function credential(req: CredentialRequest): Promise<{ username: string; password: string } | null> {
  const run = queue.then(() => credentialOne(req));
  queue = run.catch(() => {});
  return run;
}

async function credentialOne(req: CredentialRequest): Promise<{ username: string; password: string } | null> {
  const host = req.host ?? '';
  if (!host) return null;
  if (req.action === 'store') {
    const t = transient.get(host);
    if (t && t.username === req.username) {
      if (t.remember) await addCredential({ host, username: t.username, secret: t.secret }).catch((e) => notify('error', `Failed to save git credentials: ${errText(e)}`));
      transient.delete(host);
    }
    return null;
  }
  if (req.action === 'erase') {
    const stored = await fetchSecret(host).catch(() => null);
    if (stored && (req.username === undefined || stored.username === req.username)) {
      await removeCredential(host).catch(() => {});
      notify('warning', `Git credentials for ${host} (${stored.username}) were rejected and forgotten`);
    }
    transient.delete(host);
    return null;
  }
  const known = (await fetchSecret(host).catch((e) => { notify('error', `Failed to read git credentials: ${errText(e)}`); return null; })) ?? transient.get(host);
  if (known && (!req.username || req.username === known.username)) {
    return { username: known.username, password: known.secret };
  }
  showViewlet('scm');
  let answer: PromptAnswer;
  try {
    answer = await new Promise<PromptAnswer>((resolve, reject) => {
      gitAuth.prompt = { host, username: req.username ?? '', resolve, reject };
    });
  } catch {
    return null;
  } finally {
    gitAuth.prompt = null;
  }
  const username = answer.username || req.username || '';
  transient.set(host, { host, username, secret: answer.secret, remember: answer.remember });
  return { username, password: answer.secret };
}

/** 대화상자 확정 */
export function answerPrompt(answer: PromptAnswer): void {
  gitAuth.prompt?.resolve(answer);
}

export function cancelPrompt(): void {
  gitAuth.prompt?.reject(new Error('cancelled'));
}

// ---- GitHub device flow

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}
interface TokenResponse {
  access_token?: string;
}

/** relay 의 GitHub 중계 (POST /github/oauth) — github.com 로그인 끝점은 CORS 가 없어 직접 못 부른다 */
async function oauth<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = backendApiUrl('/github/oauth', { path, ...params });
  if (url === null) throw new Error('no backend');
  const res = await fetch(url, { method: 'POST' });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // relay 자체 오류(403·400·502)는 평문
  }
  // GitHub 는 모르는 client_id 를 404 + {"error":"Not Found"} 로, 흐름 오류를 200 + error 필드로 낸다
  if (typeof body?.error === 'string') {
    throw new OAuthError(body.error, typeof body.error_description === 'string' ? body.error_description : body.error);
  }
  if (!res.ok || body === null) throw new Error(text || `HTTP ${res.status}`);
  return body as T;
}

/** GitHub 의 error 코드(authorization_pending·slow_down·expired_token…)를 메시지와 별도로 든다 */
class OAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

let deviceGen = 0;

/** 'Sign in to GitHub…' — client ID 가 없으면 입력 단계부터, 있으면 바로 코드 발급·폴링 */
export function signInGithub(): void {
  if (!gitAuth.githubClientId) {
    gitAuth.device = { step: 'clientId' };
    return;
  }
  void runDeviceFlow(gitAuth.githubClientId);
}

/** client ID 입력 확정 — 기억하고 흐름 시작 */
export function setGithubClientId(id: string): void {
  gitAuth.githubClientId = id.trim();
  localStorage.setItem(CLIENT_ID_KEY, gitAuth.githubClientId);
  if (gitAuth.githubClientId) void runDeviceFlow(gitAuth.githubClientId);
}

export function cancelDeviceFlow(): void {
  deviceGen++;
  gitAuth.device = null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** device flow 본체 — 코드 발급 → 사용자가 verification_uri 에서 입력하는 동안 interval 마다 토큰 폴링 →
 *  /user 로 로그인 이름을 받아 github.com 자격으로 저장. slow_down 은 간격 +5초 (GitHub 규약) */
async function runDeviceFlow(clientId: string): Promise<void> {
  const gen = ++deviceGen;
  try {
    const code = await oauth<DeviceCode>('device/code', { client_id: clientId, scope: 'repo' });
    if (gen !== deviceGen) return;
    gitAuth.device = { step: 'code', userCode: code.user_code, verificationUri: code.verification_uri };
    let interval = Math.max(code.interval, 5);
    const deadline = Date.now() + code.expires_in * 1000;
    let token = '';
    while (Date.now() < deadline) {
      await sleep(interval * 1000);
      if (gen !== deviceGen) return;
      // 대기 중·slow_down 은 오류가 아니라 계속 — 그 외 error 는 oauth 가 throw 한다
      const t = await oauth<TokenResponse>('oauth/access_token', {
        client_id: clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).catch((e: unknown) => e);
      if (t instanceof OAuthError) {
        if (t.code === 'slow_down') interval += 5;
        else if (t.code !== 'authorization_pending') throw t;
        continue;
      }
      if (t instanceof Error) throw t;
      const got = (t as TokenResponse).access_token;
      if (got) {
        token = got;
        break;
      }
    }
    if (!token) throw new Error('The code expired before authorization');
    let login = 'oauth2';
    try {
      const me = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}` } });
      if (me.ok) login = ((await me.json()) as { login?: string }).login ?? login;
    } catch {
      // 이름은 표시용 — 못 받아도 토큰은 유효하다 (GitHub 는 https 사용자명을 검사하지 않는다)
    }
    if (gen !== deviceGen) return;
    await addCredential({ host: 'github.com', username: login, secret: token, label: 'GitHub' });
    gitAuth.device = null;
    notify('info', `Signed in to GitHub as ${login}`);
  } catch (e) {
    if (gen === deviceGen) gitAuth.device = { step: 'error', message: errText(e) };
  }
}
