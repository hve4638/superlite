# code-superlight

이 repo 는 intentir 를 쓴다. 프로젝트 파악은 소스보다 `.itir/` 트리를 먼저 읽는 것으로 시작한다.

- 의도가 바뀌는 변경(공개 표면, 모듈 간 의존, port/boundary)은 코드보다 `.itir` 를 먼저 고친다.
- 커밋 전에 `itir check` 를 통과시킨다 (error 0).
- `.vue` 는 추출기에 안 보인다 — ui 계층의 "model 만 호출" 규율은 리뷰로 지킨다.
- 와이어 계약(프론트↔데몬 JSON-RPC)은 import 가 아니라 itir 로 강제되지 않는다 — TS 쪽 사영은 `.itir/mock-front/src/backend/types.itir` 의 `port ThinBackend`, rust 쪽은 `.itir/daemon/src/`.
