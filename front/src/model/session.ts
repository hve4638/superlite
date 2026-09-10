/**
 * 세션 컨텍스트 조립 — 세션(워크스페이스) 하나가 쓰는 model 모듈 인스턴스 일습을
 * 백엔드 연결 하나에 묶는다. 세션 탭 = 이 컨텍스트 여럿이 한 페이지에 사는 것이고,
 * 전환은 activeCtx(ctx.ts) 교체다. 배경 세션도 연결·이벤트 소비가 계속 살아 있어
 * 에디터·터미널 상태가 전환에도 온전히 유지된다.
 */
import { watch as watchRx } from '@vue/reactivity';
import type { ThinBackend } from '../backend/types';
import { activeCtx } from './ctx';
import { createEditors, type EditorsSnapshot } from './editors';
import { createFileops } from './fileops';
import { createFiles, type FilesSnapshot } from './files';
import { createScm, type ScmSnapshot } from './scm';
import { createSearch } from './search';
import { createTerminals, type TerminalSnapshot } from './terminal';
import { createWatch } from './watch';
import { createWorkbench, type WorkbenchSnapshot } from './workbench';

/** 세션 탭이 창을 옮길 때 나르는 front 상태 한 덩어리 (JSON 직렬화 가능). 연결은 새 창이 같은 session id
 *  로 다시 붙는다. 트리·SCM 은 새 창이 재조회를 기다리지 않고 즉시 그리도록 함께 나르고(ticket
 *  window-detach-reload), 붙은 뒤 배경 재동기화가 스냅샷 이후의 변경을 따라잡는다 */
export interface SessionSnapshot {
  editors: EditorsSnapshot;
  workbench: WorkbenchSnapshot;
  terminals: TerminalSnapshot[];
  files: FilesSnapshot;
  scm: ScmSnapshot;
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
  /** 트리·SCM 첫 로드 — 멱등. 'full' 은 init 이 부르고, 'lazy'(서브 창) 는 사이드바를 펼치거나
   *  diff 탭이 생길 때 부른다 (ticket window-detach-reload) */
  loadWorkspace(): Promise<void>;
  /** 창 이동 핸드오프 — 출처 창이 만든다 */
  snapshot(): SessionSnapshot;
  /** 창 이동 핸드오프 적용 — 새 창의 (같은 session id 로 붙은) 컨텍스트에 덮어쓴다.
   *  터미널은 같은 세션 소유라 로컬 핸들만 재구성한다 (adoptTerminals, from 없음) */
  restore(s: SessionSnapshot): void;
}

/** 초기 로드 범위 — 'full': 워크스페이스 정보·트리·SCM·감시. 'browse': 원격 빈 세션 — 연결은 열되
 *  트리·SCM·감시는 열지 않는다 (시작 페이지만, 폴더 열기 퀵인풋의 browseDir 만 쓴다). 'lazy': 서브 창의
 *  미러 세션 — 사이드바가 없으니 워크스페이스 정보·감시만 열고 트리·SCM 은 loadWorkspace 로 미룬다 */
export type SessionInitMode = 'full' | 'browse' | 'lazy';

export function createSessionCtx(backend: ThinBackend, mode: SessionInitMode = 'full'): SessionCtx {
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
  // lazy 는 트리·SCM 을 읽기 전엔 fs 이벤트로 트리·git 을 갱신하지 않는다 — 안 그러면 첫 변경 이벤트가
  // 미룬 로드를 그대로 되살린다 (루트 refreshDir·refreshScm). 편집기 재로드·검색 재실행은 그대로
  let workspaceLoaded = false;
  const watch = createWatch(backend, editors, files, scm, search, () => mode !== 'lazy' || workspaceLoaded);
  let workP: Promise<void> | null = null;
  const loadWorkspace = (): Promise<void> => {
    if (workP === null) {
      workP = Promise.all([files.initFiles(), scm.refreshScm()]).then(() => {
        workspaceLoaded = true;
      });
      workP.catch(() => {
        workP = null;
      });
    }
    return workP;
  };
  if (mode === 'lazy') {
    // diff 탭의 original 은 소속 저장소(scm.repoOf)로 읽는다 — 탭이 넘어오면 SCM 이 필요하다
    watchRx(
      () => editors.editors.groups.some((g) => g.tabs.some((t) => t.kind === 'diff')),
      (has) => {
        if (has) void loadWorkspace();
      },
    );
  }
  // 창 이동 핸드오프의 트리·SCM 스냅샷이 도착하면 초기 로드는 그것으로 끝난 것으로 본다 — init 이 재조회를
  // 기다리지 않아 탭 스피너가 attach·워크스페이스 정보 응답까지만 돈다. 재조회는 배경에서 계속 돌고 병합된다
  let restoredResolve: () => void = () => {};
  const restoredP = new Promise<void>((r) => {
    restoredResolve = r;
  });
  let initP: Promise<void> | null = null;
  let connectionInit = false;
  const sessionCtx: SessionCtx = {
    backend, files, editors, scm, search, workbench, terminals, fileops, watch, loadWorkspace,
    init: () => {
      if (initP === null) {
        // 연결 상태 구독은 한 번 — 재시도 init 이 핸들러를 다시 걸 필요는 없다
        if (!connectionInit) {
          connectionInit = true;
          watch.initConnection();
        }
        initP = mode === 'browse'
          ? workbench.initWorkbench()
          : mode === 'lazy'
            ? workbench.initWorkbench().then(() => watch.initWatch())
            : Promise.all([workbench.initWorkbench(), Promise.race([loadWorkspace(), restoredP])]).then(() => watch.initWatch());
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
      files: files.snapshot(),
      scm: scm.snapshot(),
    }),
    restore: (s) => {
      workbench.restore(s.workbench);
      editors.restore(s.editors);
      files.restore(s.files);
      scm.restore(s.scm);
      workspaceLoaded = true;
      restoredResolve();
      // 배경 재동기화 — 스냅샷 시점부터 새 연결의 워처가 붙기까지의 변경을 병합으로 따라잡는다. 감시 구독(init 완료)
      // 뒤에 돌아야 그 사이 이벤트와 겹치지 않는다. 실패는 재연결 리프레시 몫
      void initP?.then(() => Promise.all([files.refreshTree(), scm.refreshScm()])).catch(() => {});
      terminals.adoptTerminals(s.terminals);
    },
  };
  return sessionCtx;
}
