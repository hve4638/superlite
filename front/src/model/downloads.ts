import { computed, reactive } from 'vue';
import type { ThinBackend } from '../backend/types';
import { baseName, openDownloads } from './editors';
import { errText } from './notifications';
import { downloadEntry } from './transfer';

/**
 * 셸 심 `superlite download <경로>` 의 확인 대기열 (ticket cli-control-discussion) — 다운로드는
 * 반드시 사용자가 묻고 실행한다 (사용자 결정 2026-09-11). 요청은 탐색기 아래 Download 뷰에 한
 * 줄로 뜨고 확인·취소로 답한다. 심은 기본으로 바로 돌아가고(host.ts 'queued'), `--wait` 일 때만 답이 올
 * 때까지 기다린다 (타임아웃 없음 — 프론트 연결이 끊기면 데몬이 에러 회신). 목록은 페이지 전역 — 항목이 자기
 * 세션의 backend 를 들고 있어 사용자가 다른 탭으로 옮겨 가 확인해도 요청한 세션에서 받는다.
 * 정렬(ordered): 선택이 필요한 대기 항목이 항상 위, 그 안과 나머지는 최신순 — 답하면 최신순
 * 자리로 돌아간다 (2026-09-12 사용자 요구). 전체 기록은 에디터 탭(DownloadsView, 크롬의 "모든
 * 다운로드 보기"). ponytail: 끝난 항목은 × 로 지운다, 자동 정리 없음
 */
export type DownloadState = 'pending' | 'running' | 'done' | 'cancelled' | 'failed';

export interface DownloadItem {
  id: number;
  path: string;
  name: string;
  kind: 'file' | 'directory';
  /** 요청이 온 세션 표시용 */
  session: string;
  /** 요청 시각 (epoch ms) */
  at: number;
  state: DownloadState;
  error: string | null;
  /** @internal 확인·취소가 심의 응답을 푼다 */
  settle: (ok: boolean) => void;
  backend: ThinBackend;
}

/** items 는 최신이 앞 (unshift) */
export const downloads = reactive({ items: [] as DownloadItem[] });

/** 표시 순서 — 대기 항목 먼저(최신순), 그 뒤 나머지(최신순) */
export const orderedDownloads = computed<DownloadItem[]>(() => [
  ...downloads.items.filter((d) => d.state === 'pending'),
  ...downloads.items.filter((d) => d.state !== 'pending'),
]);

export const pendingDownloads = computed(() => downloads.items.filter((d) => d.state === 'pending').length);

let nextId = 1;
/** 확인된 전송의 직렬 큐 — 실패해도 다음이 이어진다 (각 항목이 자기 결과를 받는다) */
let chain: Promise<unknown> = Promise.resolve();

/** 요청 등록 — 사용자가 확인하면 전송까지 끝난 뒤 resolve, 취소·실패면 reject (심에 에러로 간다) */
export function requestDownload(
  backend: ThinBackend,
  session: string,
  path: string,
  kind: 'file' | 'directory',
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // reactive 로 만든 뒤 push — settle 이 이 참조로 state 를 바꾸므로 원본 객체면 뷰가 갱신되지 않는다
    const item: DownloadItem = reactive({
      id: nextId++,
      path,
      name: baseName(path),
      kind,
      session,
      at: Date.now(),
      state: 'pending',
      error: null,
      backend,
      settle: (ok) => {
        if (!ok) {
          item.state = 'cancelled';
          reject(new Error('사용자가 취소했다'));
          return;
        }
        item.state = 'running';
        // 전송 슬롯이 하나(transfer.run)라 직렬 큐 — 일괄 허용이 동시에 여럿을 밀어 넣어도 차례로 받는다
        chain = chain.then(() => downloadEntry(path, kind, backend)).then(
          (got) => {
            if (got) {
              item.state = 'done';
              resolve();
            } else {
              item.state = 'cancelled'; // 저장 대화상자 취소 또는 전송 거절·실패 (사유는 알림으로 이미 나갔다)
              reject(new Error('다운로드가 진행되지 않았다'));
            }
          },
          (e) => {
            item.state = 'failed';
            item.error = errText(e);
            reject(e instanceof Error ? e : new Error(item.error));
          },
        );
      },
    });
    downloads.items.unshift(item);
  });
}

export function confirmDownload(id: number): void {
  const it = downloads.items.find((i) => i.id === id);
  if (it?.state === 'pending') it.settle(true);
}

export function cancelDownload(id: number): void {
  const it = downloads.items.find((i) => i.id === id);
  if (it?.state === 'pending') it.settle(false);
}

/** 일괄 다운로드 허용 — 대기 중 전부 확인 (전송은 transfer 슬롯이 하나라 차례로 돈다) */
export function confirmAllDownloads(): void {
  for (const it of downloads.items) if (it.state === 'pending') it.settle(true);
}

/** 끝난 항목 제거 (× ) — 대기·진행 중은 남긴다 */
export function clearDownload(id: number): void {
  const i = downloads.items.findIndex((d) => d.id === id && d.state !== 'pending' && d.state !== 'running');
  if (i >= 0) downloads.items.splice(i, 1);
}

/** 전체 다운로드 기록 — 에디터 탭 (창에 하나) */
export function showAllDownloads(): void {
  openDownloads();
}
