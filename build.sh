#!/bin/sh
# Windows 배포 세트 빌드 — front dist → cross-compile → <ws>/build/ 에 아래 배치.
#   superlite.exe, WebView2Loader.dll
#   daemon/windows-x86_64.exe   앱이 로컬에서 띄우는 데몬
#   daemon/linux-x86_64         musl 정적 linux 데몬 — linux 원격(ssh)에 올려 실행
#   VERSION                     "0.1.0 (8700a11, built …, wire 13)" 한 줄 — 어느 빌드인지 식별
# 데몬은 앱 옆 daemon/<os>-<arch>[.exe] 한 규칙으로 찾는다 (backend/relay lib.rs
# daemon_bin_for — 이름은 rust std::env::consts::OS·ARCH 값 그대로).
# 사전 준비: rustup target add x86_64-pc-windows-gnu x86_64-unknown-linux-musl
# main 은 워크스페이스 루트의 build/ 에, 다른 브랜치는 build/<워크트리 폴더명>/ 에
# 넣는다 — 병행 워커끼리 서로 덮어쓰는 사고 방지.
# 순서 주의: front 를 고쳤으면 이 스크립트로 dist 부터 다시 — dist 재빌드 없이
# cargo 만 돌리면 옛 프론트가 exe 에 박힌다.
#
#   ./build.sh          빌드
#   ./build.sh --clean  자기 출력 폴더 정리만 하고 종료 — 워크트리에서는
#                       build/<워크트리 폴더명>/ 삭제, main 에서는 안전을 위해 아무것도 안 함
set -eu
cd "$(dirname "$0")"

# <ws> = 주 저장소(.git 이 있는 체크아웃)의 부모 — worktree 에서도 동일하게 잡힌다
common=$(git rev-parse --path-format=absolute --git-common-dir)
out=$(dirname "$(dirname "$common")")/build
# main 이 아니면 워크트리 폴더명 하위로 분리 (detached HEAD 도 비-main 취급)
on_main=false
if [ "$(git branch --show-current)" = "main" ]; then
    on_main=true
else
    out="$out/$(basename "$(pwd)")"
fi

if [ "${1:-}" = "--clean" ]; then
    if $on_main; then
        echo "main: 공용 build/ 는 정리하지 않는다 (아무것도 안 함)"
    else
        rm -rf "$out"
        echo "정리됨: $out/"
    fi
    exit 0
fi

(cd front && npm run build)
# 빌드 정보(커밋·dirty·시각)는 common 의 build.rs 가 굽는다 — 재실행 조건이 HEAD 변경뿐이라
# 배포 빌드는 touch 로 강제 재실행해 현재 트리 상태를 정확히 박는다
touch backend/common/build.rs
cargo build --release --target x86_64-pc-windows-gnu -p superlite -p superlite-daemon
cargo build --release --target x86_64-unknown-linux-musl -p superlite-daemon

rel=target/x86_64-pc-windows-gnu/release
mkdir -p "$out/daemon"
cp "$rel/superlite.exe" "$rel/WebView2Loader.dll" "$out/"
cp "$rel/superlite-daemon.exe" "$out/daemon/windows-x86_64.exe"
cp target/x86_64-unknown-linux-musl/release/superlite-daemon "$out/daemon/linux-x86_64"
# VERSION 은 방금 만든 바이너리 자신의 --version 출력에서 — 별도 계산이 없어 어긋날 수 없다
"$out/daemon/linux-x86_64" --version | sed 's/^superlite-daemon //' > "$out/VERSION"
echo "→ $out/ (superlite.exe, WebView2Loader.dll, daemon/windows-x86_64.exe, daemon/linux-x86_64, VERSION: $(cat "$out/VERSION"))"
