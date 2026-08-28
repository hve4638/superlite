/**
 * 파일시스템 변경 소비 — 데몬 워처의 fsChanges 배치를 받아 소비자별로 디바운스해 반영한다.
 *
 * 전송(데몬 75ms 집계)과 UI 반영의 디바운스는 별개 관심사다 (VS Code 동일):
 * 에디터 재로드 100ms / 탐색기 500ms / git 1000ms. 안전망으로 창 포커스 시 전체 리프레시
 * (워처는 이벤트를 놓칠 수 있다는 전제).
 */
import { reactive } from '@vue/reactivity';
import type { FsChange } from '../backend/types';
import { backend } from './host';
import { editors, reloadDocFromDisk, setOrphaned } from './editors';
import { loadedDirPaths, parentOf, refreshAllFiles, refreshDir } from './files';
import { refreshScm } from './scm';
import { autoRerunSearch } from './search';

/** fire-and-forget — 리프레시 실패(삭제 경합, 연결 끊김)는 다음 이벤트·포커스가 복구한다 */
const swallow = (p: Promise<unknown>): void => void p.catch(() => {});

/** 소비자별 누적분 + 고정 창: 첫 이벤트에서 ms 뒤 flush (지연 연장 없음 — 폭주 중에도 주기 반영) */
function consumer<T>(ms: number, flush: (acc: T) => void, empty: () => T) {
  let acc = empty();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    add(fn: (acc: T) => void) {
      fn(acc);
      timer ??= setTimeout(() => {
        timer = null;
        const batch = acc;
        acc = empty();
        flush(batch);
      }, ms);
    },
  };
}

// 값 = 실존 검증 필요 여부 (창 안에 삭제 이벤트가 있었다). 검증은 dirty 여도 나간다 —
// 재로드가 아니라 orphan 판정이 목적이다 (dirty 는 내용이 적용될 일이 없어 경량 stat 으로)
const reload = consumer<Map<string, boolean>>(
  100,
  (paths) => {
    for (const [path, verify] of paths) {
      const doc = editors.docs.get(path);
      if (!doc) continue;
      if (doc.content !== doc.savedContent) {
        // dirty 는 안 건드린다 — 실존 재검증만 남는데, 내용이 필요 없으므로 stat 으로.
        // 단 orphan 경로는 verify 가 아니어도 검사한다 — 재생성 이벤트(create·coalesce 된
        // change)가 해제로 이어져야 한다 (레퍼런스는 ADDED 를 재검증 없이 즉시 해제)
        if (!verify && !editors.orphaned.has(path)) continue;
        swallow(backend.stat(path).then(() => setOrphaned(path, false)).catch(() => {
          // 끊김 중 reject 는 삭제가 아니다 — 아래 readFile 경로의 catch 와 같은 논리
          if (verify && connection.ok) setOrphaned(path, true);
        }));
        continue;
      }
      const issuedSaved = doc.savedContent;
      swallow(backend.readFile(path).then(({ content, etag }) => {
        // 읽혔다 = 디스크에 있다 (삭제 이벤트가 가짜였거나 재생성됨 — VS Code 의 재검증과 동일)
        setOrphaned(path, false);
        // WHY: 왕복 중 저장이 끝났으면 이 스냅샷이 더 낡다 — 적용하면 방금 저장을 되돌리고
        //      etag 도 되감겨 다음 저장이 스퓨리어스 충돌을 낸다
        if (editors.docs.get(path)?.savedContent !== issuedSaved) return;
        reloadDocFromDisk(path, content, etag);
      }).catch(() => {
        // 끊김 중 reject(진행 중 요청 일괄 실패)는 삭제가 아니다 — onclose 가 connHandler(false)
        // 를 동기 선행하므로 이 catch 시점에는 connection.ok 가 이미 false 다. 재검증은
        // 재연결 fullRefresh 몫 (레퍼런스도 NotFound 외 실패에는 orphan 을 세우지 않는다)
        if (verify && connection.ok) setOrphaned(path, true);
      }));
    }
  },
  () => new Map(),
);

const tree = consumer<{ dirs: Set<string>; list: boolean; all: boolean }>(
  500,
  (acc) => {
    const dirs = acc.all ? loadedDirPaths() : [...acc.dirs];
    for (const d of dirs) void refreshDir(d); // refreshDir 는 내부에서 실패를 삼킨다
    if (acc.list || acc.all) swallow(refreshAllFiles());
  },
  () => ({ dirs: new Set(), list: false, all: false }),
);

// 외부 커밋의 diff original 캐시 무효화는 refreshScm 이 가져오는 HEAD 해시(scm.head)가
// 담당한다 — .git 이벤트 → refreshScm → head 변화 → monaco 캐시 키 불일치
const git = consumer<null>(
  1000,
  () => swallow(refreshScm()),
  () => null,
);

// 검색 결과 자동 재실행 — 결과가 떠 있으면 마지막 변경 후 250ms 에 한 번 (VS Code 동일)
const searchRerun = consumer<null>(
  250,
  () => swallow(autoRerunSearch()),
  () => null,
);

function onBatch(changes: FsChange[], overflow: boolean): void {
  if (overflow) {
    fullRefresh();
    return;
  }
  for (const c of changes) {
    git.add(() => {}); // 워킹트리든 .git 내부든 git status 신호다
    // .git 컴포넌트가 낀 경로(서브모듈 sub/.git 포함)는 SCM 신호일 뿐 — 트리·에디터와 무관
    if (c.path.split('/').includes('.git')) continue;
    searchRerun.add(() => {});
    // 삭제도 reload 소비자로 — 실존 재검증을 거쳐 열린 탭에 orphan 표시 (탭·내용은 유지,
    // VS Code closeOnFileDelete=false). 같은 창에서 delete→create 가 겹쳐도 읽기가 판정한다
    reload.add((a) => a.set(c.path, (a.get(c.path) ?? false) || c.kind === 'delete'));
    tree.add((a) => {
      a.dirs.add(parentOf(c.path));
      if (c.kind !== 'change') a.list = true;
    });
  }
}

function fullRefresh(): void {
  tree.add((a) => {
    a.all = true;
  });
  git.add(() => {});
  searchRerun.add(() => {});
  reload.add((a) => {
    // verify=true — 안전망은 이벤트를 놓쳤다는 전제이므로 끊김·비포커스 중 삭제도 잡는다
    for (const path of editors.docs.keys()) a.set(path, true);
  });
}

/** 백엔드 연결 상태 — 상태바 표시용 (mock 은 항상 true) */
export const connection = reactive({ ok: true });

export function initWatch(): void {
  backend.onConnection?.((ok) => {
    connection.ok = ok;
    // 끊김 중의 fsChanges 는 이미 놓쳤다 — overflow 와 같은 전체 리프레시로 재동기화
    if (ok) fullRefresh();
  });
  if (!backend.onFsChanges) return; // mock — 외부 변경이 없다
  backend.onFsChanges(onBatch);
  window.addEventListener('focus', fullRefresh);
  // 파일 목록·git 은 폴링하지 않는다 — 이벤트 + 포커스 안전망이 전부다
}
