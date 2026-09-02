#!/bin/sh
# Windows 배포 세트 빌드 — front dist → cross-compile → <ws>/build/ 에 3파일.
# main 은 워크스페이스 루트의 build/ 에, 다른 브랜치는 build/<워크트리 폴더명>/ 에
# 넣는다 — 병행 워커끼리 서로 덮어쓰는 사고 방지.
# 순서 주의: front 를 고쳤으면 이 스크립트로 dist 부터 다시 — dist 재빌드 없이
# cargo 만 돌리면 옛 프론트가 exe 에 박힌다.
set -eu
cd "$(dirname "$0")"

# <ws> = 주 저장소(.git 이 있는 체크아웃)의 부모 — worktree 에서도 동일하게 잡힌다
common=$(git rev-parse --path-format=absolute --git-common-dir)
out=$(dirname "$(dirname "$common")")/build
# main 이 아니면 워크트리 폴더명 하위로 분리 (detached HEAD 도 비-main 취급)
if [ "$(git branch --show-current)" != "main" ]; then
    out="$out/$(basename "$(pwd)")"
fi

(cd front && npm run build)
cargo build --release --target x86_64-pc-windows-gnu -p superlight-app -p superlight-daemon

rel=target/x86_64-pc-windows-gnu/release
mkdir -p "$out"
cp "$rel/superlight-app.exe" "$rel/superlight-daemon.exe" "$rel/WebView2Loader.dll" "$out/"
echo "→ $out/ (superlight-app.exe, superlight-daemon.exe, WebView2Loader.dll)"
