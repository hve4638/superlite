import { tauri } from './tauri';

/** native 가 창 페이지에 주는 부팅 정보 (app/src/main boot_info) — 세션 항목은 sessions.SessionTab 과 같은 모양 */
export type BootInfo = {
  /** relay 의 /ws 주소 (토큰 포함) */
  ws: string;
  /** 이 창의 부팅 세션 목록 — native 레지스트리가 발급한 id 만 relay 가 허용한다 (복원이면 여럿, 마지막이 활성) */
  sessions: { id: string; name: string; root: string | null; renamed?: boolean; mirror?: string }[];
  /** 'Open Folder' 경로 퀵인풋의 시작 경로 — Windows 는 드라이브 루트(예: 'C:/'), 그 외 '/' */
  openRoot: string;
  /** 이 창의 Tauri label */
  window: string;
  /** 서브 창의 소속 메인 label — 메인 창은 null */
  owner: string | null;
  /** 묶음의 현재 활성 세션 — set_active_session 이 온 적 없는 새 창은 null */
  active: string | null;
};

// WHY: 종전엔 native 가 initialization_script 로 window.__SUPERLITE_* 전역을 심었는데, Windows(WebView2)는
//      초기화 스크립트를 iframe 서브프레임에도 주입해 URL 탭에 연 자기 웹 프론트까지 앱 모드로 부팅했다
//      (ticket app-boot-globals-iframe-leak). 대신 IPC 로 한 번 묻는다 — 앱 오리진의 최상위 프레임에서만
//      성립하고(tauri 는 서브프레임에서 undefined), 거부·실패는 웹 모드로 떨어진다.
//      최상위 await: 부팅 세션 생성이 UI 모듈 평가보다 앞서야 하는 규약(main.ts 의 import 순서)을 지키려면
//      이 모듈을 import 하는 그래프 전체가 응답을 기다려야 한다
export const boot: BootInfo | null = tauri
  ? await tauri.core.invoke('boot_info').then(
      (r) => r as BootInfo,
      (e: unknown) => {
        console.warn('boot_info 실패 — 웹 모드로 부팅:', e);
        return null;
      },
    )
  : null;
