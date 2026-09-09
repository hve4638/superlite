---
name: superlite
purpose: VS Code UX 를 레퍼런스로 한 초경량 SSH workspace GUI — Vue 3 프론트 + ThinBackend 계약
entry: [src/main.ts, src/backend/types.ts]
when:
  - 워크벤치 셸/뷰 UI 를 추가·수정할 때
  - ThinBackend 계약이나 mock 구현을 바꿀 때
---

## Domain Terms

- **ThinBackend** — 프론트가 원격에 요구하는 유일한 계약 (`src/backend/types.ts`). 이후 Rust core 로 구현 교체 예정.
- **spec** — ws repo `code-superlight-ws/tools/refspec/spec/`(이 repo 밖, 생성기 `extract.mjs` 도 같은 곳) 의 레퍼런스(Code OSS 1.134.0, Dark Modern) 추출물. geometry/computed-style JSON + 스크린샷. UI 수치는 추측하지 말고 spec 에서 가져온다.
- **tokens.css** — spec 에서 생성된 `--vscode-*` 3181개 변수 (`src/theme/tokens.css`). 색은 반드시 이 변수로만 지정한다.
- **viewlet** — 사이드바에 표시되는 뷰 (explorer/search/scm/remote/terminals — `model/workbench.ts` ViewletId). activity bar 가 전환한다.
- **preview 탭** — 트리 단일 클릭으로 열린 이탤릭 탭. 다른 preview 가 열리면 교체된다.
