# code-superlight

이 repo 는 wtree 로 브랜치를 관리한다 (main ← feat/*·fix/*·refactor/*·docs/*·chore/*, squash 로만 합류 — dev 통합 라인은 2026-08-29 폐지). 브랜치 생성·merge·제거는 wtree 로만 하고, 관리 브랜치에 `git merge`/`git switch`/`git branch -d`/`git worktree` 를 직접 쓰지 않는다. 사용법은 `wtree llms.txt`.

이 repo 는 intentir 를 쓴다. 프로젝트 파악은 소스보다 `.itir/` 트리를 먼저 읽는 것으로 시작한다.

- 의도가 바뀌는 변경(공개 표면, 모듈 간 의존, port/boundary)은 코드보다 `.itir` 를 먼저 고친다.
- 커밋 전에 `itir check` 를 통과시킨다 (error 0).
- `.vue` 는 `<script>` 블록이 추출된다 — ui 계층의 모듈 의존은 itir 가 검사한다 (템플릿·스타일은 검사 밖).
- 와이어 계약(프론트↔데몬 JSON-RPC)은 import 가 아니라 itir 로 강제되지 않는다 — TS 쪽 사영은 `.itir/front/src/backend/types.itir` 의 `port ThinBackend`, rust 쪽은 `.itir/backend/daemon/src/`.
