/**
 * 세션 컨텍스트 조립 — 세션(워크스페이스) 하나가 쓰는 model 모듈 인스턴스 일습을
 * 백엔드 연결 하나에 묶는다. 세션 탭 = 이 컨텍스트 여럿이 한 페이지에 사는 것이고,
 * 전환은 activeCtx(ctx.ts) 교체다. 배경 세션도 연결·이벤트 소비가 계속 살아 있어
 * 에디터·터미널 상태가 전환에도 온전히 유지된다.
 */
import type { ThinBackend } from '../backend/types';
import { activeCtx } from './ctx';
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
  /** 초기 로드 (워크스페이스 정보·트리·SCM) + 감시 구독 — 멱등 (한 번만 실행) */
  init(): Promise<void>;
}

export function createSessionCtx(backend: ThinBackend): SessionCtx {
  // WHY: 훅(applyExternalEdit 등)은 활성 세션에서만 발화해야 한다 — 배경 세션의 재로드가
  //      같은 경로를 가진 활성 세션의 monaco 모델을 덮으면 안 된다. 컨텍스트 완성 후
  //      비교되도록 지연 평가 클로저로 넘긴다.
  const isActive = () => activeCtx.value === sessionCtx;
  const files = createFiles(backend);
  const editors = createEditors(backend, isActive);
  const scm = createScm(backend, editors);
  const search = createSearch(backend);
  const workbench = createWorkbench(backend);
  const terminals = createTerminals(backend, workbench);
  const fileops = createFileops(backend, editors, files, scm);
  const watch = createWatch(backend, editors, files, scm, search);
  let initP: Promise<void> | null = null;
  const sessionCtx: SessionCtx = {
    backend, files, editors, scm, search, workbench, terminals, fileops, watch,
    init: () =>
      (initP ??= Promise.all([
        workbench.initWorkbench(),
        files.initFiles(),
        scm.refreshScm(),
      ]).then(() => watch.initWatch())),
  };
  return sessionCtx;
}
