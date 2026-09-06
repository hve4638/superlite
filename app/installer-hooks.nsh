; Superlite NSIS 설치 훅 — Tauri 번들러 템플릿(installer.nsi)이 Section Install / Uninstall 의
; 앞뒤에 끼워 넣는다. tauri.bundle.conf.json 의 bundle.windows.nsis.installerHooks.
;
; 1. 실행 중인 데몬 처리 (app-installer 결정, 2026-09-07): 설치 시점에 superlite-daemon.exe 는
;    앱과 별개로 살아 있는 경우가 대부분이다 (daemon-lifetime-detach — 터미널 세션 보존).
;    Windows 는 실행 중인 exe 덮어쓰기는 막지만 이름 변경은 허용하므로, 죽이지 않고
;    .old-<시각> 으로 비켜 둔 뒤 새 파일을 쓴다. 옛 데몬과 터미널은 그대로 살고, 새 앱은
;    (소켓 이름이 WIRE_VERSION 을 포함하므로) 필요하면 새 데몬을 띄운다. 옛·새 데몬 공존
;    정리 규칙은 update-compat 몫. 비켜 둔 파일은 다음 설치·제거 때 지운다 — 아직 실행
;    중이면 Delete 가 조용히 실패하고 다음 기회에 지워진다.
; 2. 폴더 컨텍스트 메뉴 "Superlite로 열기": HKCU\Software\Classes 아래 Directory\shell
;    (폴더 아이콘 우클릭) 과 Directory\Background\shell (폴더 안 빈 곳 우클릭). 사용자별
;    설치라 HKCU 로 충분하고 관리자 권한이 필요 없다. %V 는 두 위치 모두에서 대상 폴더
;    경로다. 앱은 argv[1] 을 루트로 열고, 이미 떠 있으면 single-instance 로 그 창에 세션을
;    더한다 (app/src/main.rs open_second_instance). Windows 11 에서는 "추가 옵션 표시"
;    아래에 나온다 (클래식 메뉴 — 새 메뉴 등록은 패키징·서명이 필요해 범위 밖).

!define SL_DAEMON "$INSTDIR\daemon\windows-x86_64.exe"
!define SL_MENU "Software\Classes\Directory\shell\Superlite"
!define SL_MENU_BG "Software\Classes\Directory\Background\shell\Superlite"

!macro NSIS_HOOK_PREINSTALL
  ; 템플릿의 "앱 실행 중 → 종료할까요?" 확인은 이 훅 *뒤*에 온다. 거기서 취소하면 Abort 로
  ; 설치가 멈추는데 데몬은 이미 비켜 둔 뒤라 다음 실행이 깨진다 (실기 확인 2026-09-07).
  ; 같은 확인을 먼저 돌려 취소가 이름 변경 앞에서 나게 한다 — 템플릿의 두 번째 확인은
  ; 앱이 이미 없어 조용히 지나간다.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  Delete "${SL_DAEMON}.old-*"
  ${If} ${FileExists} "${SL_DAEMON}"
    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
    Rename "${SL_DAEMON}" "${SL_DAEMON}.old-$2$1$0-$4$5$6"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "${SL_MENU}" "" "Superlite로 열기"
  WriteRegStr HKCU "${SL_MENU}" "Icon" "$\"$INSTDIR\superlite.exe$\""
  WriteRegStr HKCU "${SL_MENU}\command" "" "$\"$INSTDIR\superlite.exe$\" $\"%V$\""
  WriteRegStr HKCU "${SL_MENU_BG}" "" "Superlite로 열기"
  WriteRegStr HKCU "${SL_MENU_BG}" "Icon" "$\"$INSTDIR\superlite.exe$\""
  WriteRegStr HKCU "${SL_MENU_BG}\command" "" "$\"$INSTDIR\superlite.exe$\" $\"%V$\""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "${SL_MENU}"
  DeleteRegKey HKCU "${SL_MENU_BG}"
  ; 템플릿은 자기가 설치한 파일만 지운다 — 비켜 둔 데몬과 빈 폴더는 여기서
  Delete "${SL_DAEMON}.old-*"
  RMDir "$INSTDIR\daemon"
  RMDir "$INSTDIR"
!macroend
