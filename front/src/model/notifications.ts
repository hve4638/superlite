/**
 * 알림 토스트 상태 — VS Code notifications 근사. model 계층의 backend 실패가 notify 로
 * 표면화된다. ponytail: 알림 센터(벨) 없음 — 토스트가 사라지면 끝. 필요해지면 dismiss 를
 * 보관으로 바꾸고 상태바 벨을 단다.
 */
import { reactive } from '@vue/reactivity';

export type Severity = 'error' | 'warning' | 'info';
export interface Notification {
  id: number;
  severity: Severity;
  message: string;
}

// VS Code notificationsToasts.ts 실측값 — 심각도별 자동 숨김(ms), 동시 표시 상한 3
const PURGE_TIMEOUT: Record<Severity, number> = { info: 10000, warning: 12000, error: 15000 };
const MAX_VISIBLE = 3;

export const notifications = reactive({ list: [] as Notification[] });

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Error 던지기 관례가 아닌 값(문자열 reject 등)도 표시 가능한 문자열로 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function notify(severity: Severity, message: string): void {
  const id = nextId++;
  notifications.list.push({ id, severity, message });
  // 상한 초과분은 오래된 것부터 밀어낸다 — VS Code 는 큐에 대기시키지만 알림 센터가 없어
  // 대기시킬 곳이 없다 (ponytail). hover 로 정지된 토스트(timers 에 없음)는 읽는 중이므로
  // 건너뛴다 — 전부 정지 상태면 상한을 잠시 넘긴다 (VS Code 의 hover 중 purge 유예와 동일)
  while (notifications.list.length > MAX_VISIBLE) {
    const oldest = notifications.list.find((n) => timers.has(n.id));
    if (!oldest) break;
    dismissNotification(oldest.id);
  }
  resumeNotification(id);
}

/** 수동 닫기 (X·Escape) — 자동 숨김 타이머도 해제 */
export function dismissNotification(id: number): void {
  pauseNotification(id);
  const i = notifications.list.findIndex((n) => n.id === id);
  if (i !== -1) notifications.list.splice(i, 1);
}

/** hover 중 자동 숨김 정지 (VS Code isMouseOverToast 동일) */
export function pauseNotification(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

/** hover 해제 시 전체 시간으로 재시작 — VS Code hideAfterTimeout 동일 */
export function resumeNotification(id: number): void {
  const n = notifications.list.find((x) => x.id === id);
  if (!n) return;
  pauseNotification(id);
  timers.set(id, setTimeout(() => dismissNotification(id), PURGE_TIMEOUT[n.severity]));
}
