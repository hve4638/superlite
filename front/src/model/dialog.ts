/**
 * 확인 다이얼로그의 단일 진입점 (ticket native-confirm-dialog) — 삭제·이동·dirty 닫기 같은
 * 확인은 모두 confirm() 하나로 묻는다. 앱(Tauri)은 VS Code 처럼 OS 메시지 다이얼로그(native
 * confirm_dialog — rfd, 요청한 창을 부모로 모달), 웹은 내장 ConfirmDialog (Workbench 가 pending
 * 으로 띄운다). 호출부는 환경을 모른다.
 *
 * 버튼은 확인·(선택) 보조·Cancel 의 최대 셋 — OS 다이얼로그가 지원하는 상한. "다시 묻지 않기"
 * 체크박스는 OS 창에 없어 보조 버튼("종료, 다시 묻지 않기")으로 대신한다 (사용자 결정 2026-09-11).
 */
import { shallowReactive } from '@vue/reactivity';
import { tauri } from './tauri';

export type ConfirmChoice = 'confirm' | 'secondary' | 'cancel';

export interface ConfirmOpts {
  message: string;
  detail?: string;
  /** 확인 버튼 라벨 (Save·Delete·Move …) */
  confirmLabel: string;
  /** 있으면 3버튼 (Save / Don't Save / Cancel 류) */
  secondaryLabel?: string;
}

/** 웹 내장 창의 상태 — pending 이 있으면 Workbench 가 ConfirmDialog 를 띄운다 (모달 하나) */
export const dialog = shallowReactive({
  pending: null as (ConfirmOpts & { resolve: (choice: ConfirmChoice) => void }) | null,
});

/** 확인을 묻고 답을 기다린다 — 앱은 OS 창, 웹은 내장 창. 웹에서 이미 하나가 떠 있으면 cancel */
export async function confirm(opts: ConfirmOpts): Promise<ConfirmChoice> {
  if (tauri) {
    const buttons = [opts.confirmLabel, ...(opts.secondaryLabel ? [opts.secondaryLabel] : []), 'Cancel'];
    const idx = (await tauri.core.invoke('confirm_dialog', { message: opts.message, detail: opts.detail ?? null, buttons })) as number;
    if (idx === 0) return 'confirm';
    if (idx === 1 && opts.secondaryLabel) return 'secondary';
    return 'cancel';
  }
  if (dialog.pending) return 'cancel';
  return new Promise((resolve) => {
    dialog.pending = { ...opts, resolve };
  });
}

/** 내장 창의 답 (ConfirmDialog 이벤트) */
export function answerConfirm(choice: ConfirmChoice): void {
  const p = dialog.pending;
  dialog.pending = null;
  p?.resolve(choice);
}

/** 확인 창이 떠 있는가 — 뷰의 키 입력 가드용 (앱의 OS 모달은 입력이 오지 않아 웹만 의미 있다) */
export const confirming = (): boolean => dialog.pending !== null;
