// monaco 내장이 아닌 언어의 등록 진입점 (ticket config-editors; toml·nginx·makefile 은 editor-language-coverage). 언어 하나 = 이 폴더의 파일 하나
// (id·언어 설정·monarch 토크나이저) + 아래 CUSTOM 목록의 항목 하나. 판정(경로 → id)은 model/languages 가 하고,
// 여기는 그 id 를 monaco 가 알게 만드는 쪽이다. 토큰 이름은 테마의 공통 규칙(monaco.ts superlite-dark)만 쓴다 —
// 언어를 더할 때 테마를 건드리지 않게.
import * as monaco from 'monaco-editor';
import { tmux } from './tmux';
import { sshConfig } from './sshconfig';
import { toml } from './toml';
import { nginx } from './nginx';
import { makefile } from './makefile';

export interface CustomLanguage {
  /** model/languages 의 LanguageDef.id 와 같은 값 */
  id: string;
  configuration: monaco.languages.LanguageConfiguration;
  monarch: monaco.languages.IMonarchLanguage;
}

const CUSTOM: CustomLanguage[] = [tmux, sshConfig, toml, nginx, makefile];

/** 부팅 시 한 번 — 첫 모델이 만들어지기 전에 (monaco.ts 가 부른다) */
export function registerCustomLanguages(): void {
  for (const l of CUSTOM) {
    monaco.languages.register({ id: l.id });
    monaco.languages.setLanguageConfiguration(l.id, l.configuration);
    monaco.languages.setMonarchTokensProvider(l.id, l.monarch);
  }
}
