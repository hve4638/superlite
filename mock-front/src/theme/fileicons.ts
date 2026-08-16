// Seti 아이콘 최소 매핑 — vs-seti-icon-theme.json 에서 픽스처에 필요한 항목만 발췌.
// 문자 코드는 seti.woff 의 PUA 코드포인트다.

interface IconDef {
  char: string;
  color: string;
}

const DEFAULT_ICON: IconDef = { char: '', color: '#d4d7d6' };

const BY_NAME: Record<string, IconDef> = {
  'readme.md': { char: '', color: '#519aba' },
  '.gitignore': { char: '', color: '#41535b' },
};

const BY_EXT: Record<string, IconDef> = {
  ts: { char: '', color: '#519aba' },
  js: { char: '', color: '#cbcb41' },
  json: { char: '', color: '#cbcb41' },
  md: { char: '', color: '#519aba' },
  sh: { char: '', color: '#8dc149' },
  html: { char: '', color: '#519aba' },
  css: { char: '', color: '#519aba' },
};

export function fileIcon(name: string): IconDef {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  return BY_EXT[ext] ?? DEFAULT_ICON;
}
