/**
 * 세션 컨텍스트 조립 — 세션(워크스페이스) 하나가 쓰는 model 모듈 인스턴스 일습을
 * 백엔드 연결 하나에 묶는다. 세션 탭 = 이 컨텍스트 여럿이 한 페이지에 사는 것이고,
 * 전환은 activeCtx(ctx.ts) 교체다. 배경 세션도 연결·이벤트 소비가 계속 살아 있어
 * 에디터·터미널 상태가 전환에도 온전히 유지된다.
 */
import type { ThinBackend } from '../backend/types';
import { createEditors } from './editors';
import { createFileops } from './fileops';
import { createFiles } from './files';
import { createScm } from './scm';
import { createSearch } from './search';
import { createTerminals } from './terminal';
import { createWatch } from './watch';
import { createWorkbench } from './workbench';

export interface SessionCtx {
  backend: ThinBackend;
  files: ReturnType<typeof createFiles>;
  editors: ReturnType<typeof createEditors>;
  scm: ReturnType<typeof createScm>;
  search: ReturnType<typeof createSearch>;
  workbench: ReturnType<typeof createWorkbench>;
  terminals: ReturnType<typeof createTerminals>;
  fileops: ReturnType<typeof createFileops>;
  watch: ReturnType<typeof createWatch>;
}

export function createSessionCtx(backend: ThinBackend): SessionCtx {
  const files = createFiles(backend);
  const editors = createEditors(backend);
  const scm = createScm(backend, editors);
  const search = createSearch(backend);
  const workbench = createWorkbench(backend);
  const terminals = createTerminals(backend, workbench);
  const fileops = createFileops(backend, editors, files, scm);
  const watch = createWatch(backend, editors, files, scm, search);
  return { backend, files, editors, scm, search, workbench, terminals, fileops, watch };
}
