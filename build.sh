#!/bin/sh
# Windows 배포 빌드 — front dist → cross-compile → <ws>/build/ 에 설치 파일 하나만 놓는다.
#   Superlite_<ver>_x64-setup.exe  NSIS 설치 파일 — 사용자별(%LOCALAPPDATA%\Superlite)로 아래를
#                               설치하고 폴더 컨텍스트 메뉴를 등록 (app/installer-hooks.nsh)
# 설치본 배치 (낱개로는 더 이상 내놓지 않는다 — 2026-09-07 사용자 결정):
#   superlite.exe, WebView2Loader.dll
#   daemon/windows-x86_64.exe   앱이 로컬에서 띄우는 데몬
#   daemon/linux-x86_64         musl 정적 linux 데몬 — linux 원격(ssh)에 올려 실행
#   daemon/cli/superlite.exe    셸 심 `superlite <동사>` (sl.exe 는 같은 파일 복사) — 데몬이 PTY PATH 앞에 cli/ 를 넣는다
#   daemon/cli-linux-x86_64     musl 정적 셸 심 — linux 원격에 데몬과 함께 cli/superlite (+sl 링크) 로 올린다
#   daemon/tmux-linux-x86_64    musl 정적 tmux (고정 버전 릴리스 바이너리) — 내장 터미널 서버, 데몬과 함께
#                               원격에 올린다 (ticket term-list-reconnect). Windows 는 tmux 없음 (터미널 보존 없음)
# 데몬은 앱 옆 daemon/<os>-<arch>[.exe] 한 규칙으로 찾는다 (backend/relay lib.rs
# daemon_bin_for — 이름은 rust std::env::consts::OS·ARCH 값 그대로). tmux 는 daemon/tmux-<os>-<arch>
# (relay tmux_bin_for — 원격 업로드용. 데몬 자신은 자기 옆의 tmux / tmux-<os>-<arch> / PATH 순으로 찾는다).
# 어느 빌드인지(버전·커밋·빌드 시각)는 끝의 echo 로 — 방금 만든 데몬 자신의 --version.
# 사전 준비: rustup target add x86_64-pc-windows-gnu x86_64-unknown-linux-musl
#           cargo install tauri-cli --version '^2' --locked ; apt install nsis (리눅스 makensis 로 cross 생성)
# main 은 워크스페이스 루트의 build/ 에, 다른 브랜치는 build/<워크트리 폴더명>/ 에
# 넣는다 — 병행 워커끼리 서로 덮어쓰는 사고 방지.
# 순서 주의: front 를 고쳤으면 이 스크립트로 dist 부터 다시 — dist 재빌드 없이
# cargo 만 돌리면 옛 프론트가 exe 에 박힌다.
#
#   ./build.sh                dev 채널 빌드 (기본, 2026-09-08 사용자 결정 — 평소 빌드는 전부 dev) —
#                             app/tauri.dev.conf.json 을 얹고(productName "Superlite-Dev"·identifier·
#                             exe 이름) SUPERLITE_CHANNEL=dev 로 common 을 구워(소켓·파이프·캐시·
#                             설정 폴더 이름 접미) stable 설치본과 한 PC 에 공존한다 (ticket
#                             release-channel). 산출물은 Superlite-Dev_<ver>_x64-setup.exe
#   ./build.sh --stable       stable 채널 빌드 — 내부 배포용. 산출물은 Superlite_<ver>_x64-setup.exe
#   ./build.sh --channel X    다른 채널 overlay(app/tauri.X.conf.json)
#   ./build.sh --clean        자기 출력 폴더 정리만 하고 종료 — 워크트리에서는
#                             build/<워크트리 폴더명>/ 삭제, main 에서는 안전을 위해 아무것도 안 함
set -eu
cd "$(dirname "$0")"

channel=dev
clean=false
while [ $# -gt 0 ]; do
    case "$1" in
        --clean) clean=true ;;
        --stable) channel= ;;
        --channel) channel=$2; shift ;;
        *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
    esac
    shift
done

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

if $clean; then
    if $on_main; then
        echo "main: 공용 build/ 는 정리하지 않는다 (아무것도 안 함)"
    else
        rm -rf "$out"
        echo "정리됨: $out/"
    fi
    exit 0
fi

# 채널 overlay — 없는 채널 이름은 여기서 막는다. productName 은 overlay 에서 읽어 설치 파일 이름에 쓴다
# stable 은 기본 설정의 productName — 채널과 같은 sed 로 읽어 출처를 하나로
product=$(sed -n 's/.*"productName": *"\([^"]*\)".*/\1/p' app/tauri.conf.json)
tauri_cfg="--config tauri.bundle.conf.json"
if [ -n "$channel" ]; then
    overlay=app/tauri.$channel.conf.json
    [ -f "$overlay" ] || { echo "채널 overlay 없음: $overlay" >&2; exit 2; }
    product=$(sed -n 's/.*"productName": *"\([^"]*\)".*/\1/p' "$overlay")
    tauri_cfg="$tauri_cfg --config tauri.$channel.conf.json"
    export SUPERLITE_CHANNEL=$channel
fi

# 정적 tmux — mjakob-gh/build-static-tmux 릴리스(musl·ncurses·libevent 정적, ISC/BSD/MIT — THIRD-PARTY.md)
# 를 고정 버전·해시로 내려받아 target/tmux/ 에 둔다. 버전을 올릴 때는 해시와 THIRD-PARTY.md 도 함께
tmux_ver=3.7b
tmux_sha=a3b6f89a3630655204c322e8960226a0132f225aba3ab2677812ec9b04567c27
tmux_gz=target/tmux-$tmux_ver.linux-amd64.gz
tmux_bin=target/tmux/tmux-linux-x86_64
if [ ! -f "$tmux_bin" ]; then
    mkdir -p target/tmux
    [ -f "$tmux_gz" ] || curl -fsSL -o "$tmux_gz" "https://github.com/mjakob-gh/build-static-tmux/releases/download/v$tmux_ver/tmux.linux-amd64.gz"
    echo "$tmux_sha  $tmux_gz" | sha256sum -c - >/dev/null || { echo "tmux.linux-amd64.gz 해시 불일치" >&2; rm -f "$tmux_gz"; exit 2; }
    gunzip -c "$tmux_gz" > "$tmux_bin"
    chmod +x "$tmux_bin"
fi

(cd front && npm run build)

# Neovim 은 동봉하지 않는다 — vim 모드를 처음 켤 때 relay 가 GitHub 릴리스에서 캐시 폴더로
# 내려받는다 (backend/relay nvim.rs ensure_nvim, ticket nvim-on-demand).
# 빌드 정보(커밋·dirty·시각)는 common 의 build.rs 가 굽는다 — 재실행 조건이 HEAD 변경뿐이라
# 배포 빌드는 touch 로 강제 재실행해 현재 트리 상태를 정확히 박는다
touch backend/common/build.rs
cargo build --release --target x86_64-pc-windows-gnu -p superlite-daemon -p superlite-cli
cargo build --release --target x86_64-unknown-linux-musl -p superlite-daemon -p superlite-cli
# 셸 심 (ticket cli-control-discussion): 로컬 Windows 는 daemon/cli/{superlite,sl}.exe (심볼릭 링크 대신
# 복사 — Windows 링크는 권한이 필요하다), 원격용 musl 은 daemon/cli-linux-x86_64 (relay 가 cli/superlite
# + sl 링크로 올린다). 데몬이 자기 옆 cli/ 를 PTY PATH 앞에 넣는다.
# crate 의 bin 이름은 superlite-cli — 앱 stable bin `superlite` 와 같은 target/…/release/ 에 나오므로
# 이름이 같으면 서로 덮어쓴다 (ticket cli-bin-name-collision, 0.4.0 번들에 앱 본체 35MB 가 심 자리에
# 들어감). 설치본 이름은 여기서 target/cli/ 로 복사하며 붙이고, 번들 리소스는 그 사본을 가리킨다
mkdir -p target/cli
cp target/x86_64-pc-windows-gnu/release/superlite-cli.exe target/cli/superlite.exe
cp target/x86_64-pc-windows-gnu/release/superlite-cli.exe target/cli/sl.exe
cp target/x86_64-unknown-linux-musl/release/superlite-cli target/cli/cli-linux-x86_64
# 앱은 tauri-cli 로 — 같은 --release --target 이라 target/ 산출물은 위와 같은 자리에 나오고,
# 이어서 NSIS 설치 파일을 묶는다. 번들 설정은 tauri.bundle.conf.json 에만 두고 --config 로
# 얹는다: 데몬 바이너리를 리소스로 동봉하는데(설치본에서도 앱 옆 daemon/<os>-<arch> 규칙 유지)
# tauri-build 가 컴파일 시점에 리소스 존재를 요구해 평소 cargo build 까지 데몬을 먼저 요구하게
# 되면 안 되기 때문 — 그래서 데몬 두 개를 먼저 만든다.
# shellcheck disable=SC2086 — tauri_cfg 는 의도한 단어 분리
(cd app && cargo tauri build --target x86_64-pc-windows-gnu $tauri_cfg)

mkdir -p "$out"
# 번들러 산출물 이름은 <productName>_<ver>_x64-setup.exe — 채널별 productName 과 현재 버전으로
# 경로를 고정한다. 버전 자리를 글로브로 두면 nsis/ 에 남은 옛 버전 파일까지 잡혀 cp 가 깨진다
# (0.1.0→0.2.0 인상 때 실제로 발생). 버전은 단일 출처인 루트 Cargo.toml [workspace.package] 에서 읽는다
ver=$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version = "\([^"]*\)".*/\1/p}' Cargo.toml)
src=target/x86_64-pc-windows-gnu/release/bundle/nsis/"$product"_"$ver"_x64-setup.exe
[ -f "$src" ] || { echo "산출물 없음: $src" >&2; exit 2; }
dst=$out/$(basename "$src")
cp "$src" "$dst"
echo "→ $dst — $(target/x86_64-unknown-linux-musl/release/superlite-daemon --version | sed 's/^superlite-daemon //')"
