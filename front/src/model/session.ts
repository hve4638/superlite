/**
 * 세션 컨텍스트 조립 — 세션(워크스페이스) 하나가 쓰는 model 모듈 인스턴스 일습을
 * 백엔드 연결 하나에 묶는다. 세션 탭 = 이 컨텍스트 여럿이 한 페이지에 사는 것이고,
 * 전환은 activeCtx(ctx.ts) 교체다. 배경 세션도 연결·이벤트 소비가 계속 살아 있어
 * 에디터·터미널 상태가 전환에도 온전히 유지된다.
 */
import type { ThinBackend } from '../backend/types';
import { activeCtx } from './ctx';
import { createEditors, type EditorsSnapshot } from './editors';
import { createFileops } from './fileops';
import { createFiles } from './files';
import { createScm } from './scm';
import { createSearch } from './search';
import { createTerminals, type TerminalSnapshot } from './terminal';
import { createWatch } from './watch';
import { createWorkbench, type WorkbenchSnapshot } from './workbench';

/** 세션 탭이 창을 옮길 때 나르는 front 상태 한 덩어리 (JSON 직렬화 가능). 연결·트리·SCM 은
 *  새 창이 같은 session id 로 다시 붙어 스스로 로드한다 — 여기 없는 것은 재로드로 복원되는 것들 */
export interface SessionSnapshot {
  editors: EditorsSnapshot;
  workbench: WorkbenchSnapshot;
  terminals: TerminalSnapshot[];
}

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
  /** 창 이동 핸드오프 — 출처 창이 만든다 */
  snapshot(): SessionSnapshot;
  /** 창 이동 핸드오프 적용 — 새 창의 (같은 session id 로 붙은) 컨텍스트에 덮어쓴다.
   *  터미널은 같은 세션 소유라 로컬 핸들만 재구성한다 (adoptTerminals, from 없음) */
  restore(s: SessionSnapshot): void;
}

/** browseOnly: 원격 빈 세션 — 연결은 열되 트리·SCM 로드는 하지 않는다 (시작 페이지만,
 *  폴더 열기 퀵인풋의 browseDir 만 쓴다). 워크스페이스 정보는 접속 확인용으로 받는다 */
export function createSessionCtx(backend: ThinBackend, browseOnly = false): SessionCtx {
  // WHY: 훅(applyExternalEdit 등)은 활성 세션에서만 발화해야 한다 — 배경 세션의 재로드가
  //      같은 경로를 가진 활성 세션의 monaco 모델을 덮으면 안 된다. 컨텍스트 완성 후
  //      비교되도록 지연 평가 클로저로 넘긴다.
  const isActive = () => activeCtx.value === sessionCtx;
  const files = createFiles(backend);
  const editors = createEditors(backend, isActive);
  const scm = createScm(backend, editors);
  files.onDirLoaded(scm.noteDirEntries);
  const search = createSearch(backend);
  const workbench = createWorkbench(backend);
  const terminals = createTerminals(backend, editors);
  const fileops = createFileops(backend, editors, files, scm);
  const watch = createWatch(backend, editors, files, scm, search);
  let initP: Promise<void> | null = null;
  let connectionInit = false;
  const sessionCtx: SessionCtx = {
    backend, files, editors, scm, search, workbench, terminals, fileops, watch,
    init: () => {
      if (initP === null) {
        // 연결 상태 구독은 한 번 — 재시도 init 이 핸들러를 다시 걸 필요는 없다
        if (!connectionInit) {
          connectionInit = true;
          watch.initConnection();
        }
        initP = browseOnly
          ? workbench.initWorkbench()
          : Promise.all([
              workbench.initWorkbench(),
              files.initFiles(),
              scm.refreshScm(),
            ]).then(() => watch.initWatch());
        // 실패(원격 접속 실패로 첫 요청이 reject)하면 다음 init 이 처음부터 다시 — Retry 가
        // 백엔드를 다시 연 뒤 init 을 재호출한다 (ticket remote-connect-retry)
        initP.catch(() => {
          initP = null;
        });
      }
      return initP;
    },
    snapshot: () => ({
      editors: editors.snapshot(),
      workbench: workbench.snapshot(),
      terminals: terminals.snapshot(),
    }),
    restore: (s) => {
      workbench.restore(s.workbench);
      editors.restore(s.editors);
      terminals.adoptTerminals(s.terminals);
    },
  };
  return sessionCtx;
}
