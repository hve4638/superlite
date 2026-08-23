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
import { editors, reloadDocFromDisk } from './editors';
import { loadedDirPaths, parentOf, refreshAllFiles, refreshDir } from './files';
import { refreshScm } from './scm';

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

const reload = consumer<Set<string>>(
  100,
  (paths) => {
    for (const path of paths) {
      const doc = editors.docs.get(path);
      // dirty 는 안 건드린다 — readFile 전에 거르고, 적용 시점에 reloadDocFromDisk 가 재확인
      if (!doc || doc.content !== doc.savedContent) continue;
      const issuedSaved = doc.savedContent;
      swallow(backend.readFile(path).then(({ content, etag }) => {
        // WHY: 왕복 중 저장이 끝났으면 이 스냅샷이 더 낡다 — 적용하면 방금 저장을 되돌리고
        //      etag 도 되감겨 다음 저장이 스퓨리어스 충돌을 낸다
        if (editors.docs.get(path)?.savedContent !== issuedSaved) return;
        reloadDocFromDisk(path, content, etag);
      }));
    }
  },
  () => new Set(),
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

function onBatch(changes: FsChange[], overflow: boolean): void {
  if (overflow) {
    fullRefresh();
    return;
  }
  for (const c of changes) {
    git.add(() => {}); // 워킹트리든 .git 내부든 git status 신호다
    // .git 컴포넌트가 낀 경로(서브모듈 sub/.git 포함)는 SCM 신호일 뿐 — 트리·에디터와 무관
    if (c.path.split('/').includes('.git')) continue;
    // ponytail: 외부 삭제된 열린 파일의 탭 표시(orphan) 없음 — 탭과 내용은 그대로 남는다
    //           (VS Code 기본 closeOnFileDelete=false 와 동일). 표시가 필요해지면 그때.
    if (c.kind !== 'delete') reload.add((a) => a.add(c.path));
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
  reload.add((a) => {
    for (const path of editors.docs.keys()) a.add(path);
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

// ponytail: 검색 결과 자동 재실행(VS Code 250ms) 미구현 — 검색은 실행 시점 스냅샷.
