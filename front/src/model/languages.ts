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

/**
 * 앞에 있는 정의가 우선 — 특수(파일명·패턴) 정의를 확장자 정의보다 앞에 둔다.
 * 두 구획: (1) 커스텀 — ui/editor/languages 가 토크나이저를 등록하는 id, (2) 내장 — monaco 가 번들에 싣고 있는 id
 * (editor.main 이 전부 등록하므로 매핑만 있으면 색이 난다). 줄을 더할 때 내장인지 확인하는 기준은
 * monaco-editor/esm/vs/languages/definitions/<id>/ 폴더 존재. 사용자 설정(files.associations)은 아직 없다 —
 * 생기면 이 표 앞에 끼워 넣는 자리다.
 */
export const LANGUAGES: LanguageDef[] = [
  // ---- 커스텀 (ui/editor/languages) ----
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
  { id: 'toml', label: 'TOML', extensions: ['toml'], filenames: ['Cargo.lock', 'Pipfile', 'poetry.lock', 'uv.lock'] },
  {
    id: 'nginx',
    label: 'NGINX Conf',
    filenames: ['nginx.conf'],
    extensions: ['nginx'],
    // /etc/nginx/ 아래 *.conf 와 sites-available·sites-enabled·conf.d 의 파일 — 내장 ini 의 conf 보다 앞
    patterns: [/(^|\/)nginx\/(?:.*\/)?[^/]+\.conf$/, /(^|\/)nginx\/(?:sites-(?:available|enabled)|conf\.d)\/[^/]+$/],
  },
  { id: 'makefile', label: 'Makefile', filenames: ['Makefile', 'makefile', 'GNUmakefile'], extensions: ['mk', 'mak'] },
  // ---- 내장 (monaco 번들) — VS Code 기본 연관 기준 ----
  {
    id: 'shell',
    label: 'Shell Script',
    extensions: ['sh', 'bash', 'zsh', 'ksh'],
    filenames: ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_aliases', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', 'PKGBUILD'],
  },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['dockerfile'], filenames: ['Dockerfile', 'Containerfile'], patterns: [/(^|\/)(Dockerfile|Containerfile)\.[\w-]+$/] },
  { id: 'ignore', label: 'Ignore', extensions: ['gitignore', 'dockerignore', 'npmignore', 'eslintignore', 'prettierignore'], filenames: ['.ignore'] },
  {
    id: 'ini',
    label: 'Ini',
    // systemd unit 도 ini 문법 — 내장 ini 로 충분히 색이 난다. .env 는 KEY=VALUE 라 ini 로 (shell 이 아니라 export 없음)
    extensions: ['ini', 'cfg', 'conf', 'properties', 'editorconfig', 'gitconfig', 'gitmodules', 'gitattributes', 'npmrc', 'yarnrc', 'desktop', 'service', 'socket', 'timer', 'target', 'mount', 'path', 'slice', 'env'],
    patterns: [/(^|\/)\.env\.[\w-]+$/, /(^|\/)\.git\/config$/],
  },
  { id: 'yaml', label: 'YAML', extensions: ['yml', 'yaml'], filenames: ['.clang-format', '.clang-tidy'] },
  { id: 'typescript', label: 'TypeScript', extensions: ['ts', 'tsx', 'mts', 'cts'] },
  { id: 'javascript', label: 'JavaScript', extensions: ['js', 'jsx', 'mjs', 'cjs', 'es6'] },
  { id: 'json', label: 'JSON', extensions: ['json', 'jsonc', 'json5', 'webmanifest', 'har'], filenames: ['.eslintrc', '.babelrc', '.prettierrc', '.swcrc', 'composer.lock'] },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn'] },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm', 'xhtml', 'shtml'] },
  { id: 'css', label: 'CSS', extensions: ['css'] },
  { id: 'scss', label: 'SCSS', extensions: ['scss'] },
  { id: 'less', label: 'Less', extensions: ['less'] },
  { id: 'xml', label: 'XML', extensions: ['xml', 'svg', 'xsl', 'xslt', 'xsd', 'plist', 'csproj', 'pom', 'wsdl', 'xaml', 'rss', 'atom'] },
  { id: 'python', label: 'Python', extensions: ['py', 'pyw', 'pyi'], filenames: ['SConstruct', 'SConscript'] },
  { id: 'rust', label: 'Rust', extensions: ['rs'] },
  { id: 'go', label: 'Go', extensions: ['go'] },
  { id: 'java', label: 'Java', extensions: ['java'] },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'] },
  { id: 'c', label: 'C', extensions: ['c', 'h'] },
  { id: 'cpp', label: 'C++', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'inl'] },
  { id: 'objective-c', label: 'Objective-C', extensions: ['m', 'mm'] },
  { id: 'csharp', label: 'C#', extensions: ['cs', 'csx'] },
  { id: 'swift', label: 'Swift', extensions: ['swift'] },
  { id: 'dart', label: 'Dart', extensions: ['dart'] },
  { id: 'scala', label: 'Scala', extensions: ['scala', 'sbt'] },
  { id: 'ruby', label: 'Ruby', extensions: ['rb', 'gemspec', 'rake'], filenames: ['Gemfile', 'Rakefile', 'Vagrantfile', 'Podfile'] },
  { id: 'php', label: 'PHP', extensions: ['php', 'phtml'] },
  { id: 'lua', label: 'Lua', extensions: ['lua'] },
  { id: 'perl', label: 'Perl', extensions: ['pl', 'pm', 't'] },
  { id: 'r', label: 'R', extensions: ['r'] },
  { id: 'julia', label: 'Julia', extensions: ['jl'] },
  { id: 'elixir', label: 'Elixir', extensions: ['ex', 'exs'] },
  { id: 'clojure', label: 'Clojure', extensions: ['clj', 'cljs', 'cljc', 'edn'] },
  { id: 'fsharp', label: 'F#', extensions: ['fs', 'fsi', 'fsx'] },
  { id: 'sql', label: 'SQL', extensions: ['sql'] },
  { id: 'graphql', label: 'GraphQL', extensions: ['graphql', 'gql'] },
  { id: 'proto', label: 'Protocol Buffers', extensions: ['proto'] },
  { id: 'hcl', label: 'HCL', extensions: ['hcl', 'tf', 'tfvars'] },
  { id: 'powershell', label: 'PowerShell', extensions: ['ps1', 'psm1', 'psd1'] },
  { id: 'bat', label: 'Batch', extensions: ['bat', 'cmd'] },
  { id: 'tcl', label: 'Tcl', extensions: ['tcl'] },
  { id: 'restructuredtext', label: 'reStructuredText', extensions: ['rst'] },
  { id: 'coffeescript', label: 'CoffeeScript', extensions: ['coffee'] },
  { id: 'handlebars', label: 'Handlebars', extensions: ['hbs', 'handlebars'] },
  { id: 'pug', label: 'Pug', extensions: ['pug', 'jade'] },
  { id: 'wgsl', label: 'WGSL', extensions: ['wgsl'] },
  { id: 'plaintext', label: 'Plain Text', extensions: ['txt', 'log', 'text'], filenames: ['LICENSE', 'COPYING', 'AUTHORS', 'CHANGELOG', 'README'] },
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
