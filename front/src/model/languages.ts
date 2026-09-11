// 편집기 언어 판정 레지스트리 (ticket config-editors) — 경로 하나를 monaco 언어 id 로 잇는 단일 표.
// 확장자 표 하나에 한 줄씩 덧붙이던 방식을 버리고 언어마다 정의(LanguageDef)를 두어, 파일명·확장자·경로 패턴
// 어느 쪽으로든 잡히게 했다. 새 언어 = 이 목록에 정의 하나 (+ monaco 내장이 아니면 ui/editor/languages 에
// 토크나이저 하나). 프레임워크 독립 — monaco 는 모른다, id 문자열만 낸다.

export interface LanguageDef {
  /** monaco 언어 id — 내장(typescript·json…)이거나 ui/editor/languages 가 등록하는 것(tmux·ssh_config) */
  id: string;
  /** statusbar 표시 이름 */
  label: string;
  /** 확장자 (점 없이, 소문자) — 점으로 시작하는 파일명(.gitignore)은 이름 전체가 확장자로 취급된다 */
  extensions?: string[];
  /** 파일명 그대로 (대소문자 구분) */
  filenames?: string[];
  /** 경로 전체에 대한 패턴 — 가상 경로(superlite:/…)·폴더 규칙(.ssh/config) 용 */
  patterns?: RegExp[];
}

/** 앞에 있는 정의가 우선 — 특수(파일명·패턴) 정의를 확장자 정의보다 앞에 둔다 */
export const LANGUAGES: LanguageDef[] = [
  {
    id: 'tmux',
    label: 'tmux Config',
    filenames: ['tmux.conf', '.tmux.conf'],
    extensions: ['tmux'],
    // 클라이언트 tmux 프로필 탭(configfiles) 과 *.tmux.conf
    patterns: [/^superlite:\/tmux\/[^/]+\.conf$/, /\.tmux\.conf$/],
  },
  {
    id: 'ssh_config',
    label: 'SSH Config',
    filenames: ['ssh_config', 'sshd_config'],
    // 클라이언트 ~/.ssh/config 탭(configfiles) 과 워크스페이스 안 .ssh/config
    patterns: [/^superlite:\/ssh\/config$/, /(^|\/)\.ssh\/config$/],
  },
  { id: 'typescript', label: 'TypeScript', extensions: ['ts'] },
  { id: 'javascript', label: 'JavaScript', extensions: ['js'] },
  { id: 'json', label: 'JSON', extensions: ['json'] },
  { id: 'markdown', label: 'Markdown', extensions: ['md'] },
  { id: 'css', label: 'CSS', extensions: ['css'] },
  { id: 'html', label: 'HTML', extensions: ['html'] },
  { id: 'shell', label: 'Shell Script', extensions: ['sh'] },
  { id: 'ignore', label: 'Ignore', extensions: ['gitignore'] },
];

const PLAIN: LanguageDef = { id: 'plaintext', label: 'Plain Text' };

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function defOf(path: string): LanguageDef {
  const name = baseName(path);
  const ext = (name.startsWith('.') ? name.slice(1) : name.slice(name.lastIndexOf('.') + 1)).toLowerCase();
  for (const d of LANGUAGES) {
    if (d.filenames?.includes(name)) return d;
    if (d.patterns?.some((p) => p.test(path))) return d;
    if (d.extensions?.includes(ext)) return d;
  }
  return PLAIN;
}

/** 경로 → monaco 언어 id — 순수 함수, 세션 무관 */
export function languageOf(path: string): string {
  return defOf(path).id;
}

/** statusbar 표시용 언어 이름 — 순수 함수, 세션 무관 */
export function languageLabel(path: string): string {
  return defOf(path).label;
}
