#!/bin/sh
# Windows 배포 빌드 — front dist → cross-compile → <ws>/build/ 에 설치 파일 하나만 놓는다.
#   Superlite_<ver>_x64-setup.exe  NSIS 설치 파일 — 사용자별(%LOCALAPPDATA%\Superlite)로 아래를
#                               설치하고 폴더 컨텍스트 메뉴를 등록 (app/installer-hooks.nsh)
# 설치본 배치 (낱개로는 더 이상 내놓지 않는다 — 2026-09-07 사용자 결정):
#   superlite.exe, WebView2Loader.dll
#   daemon/windows-x86_64.exe   앱이 로컬에서 띄우는 데몬
#   daemon/linux-x86_64         musl 정적 linux 데몬 — linux 원격(ssh)에 올려 실행
#   nvim/windows-x86_64/        편집기 vim 모드용 Neovim (고정 버전, 릴리스 zip 그대로 — bin/·share/)
#   daemon/tmux-linux-x86_64    musl 정적 tmux (고정 버전 릴리스 바이너리) — 내장 터미널 서버, 데몬과 함께
#                               원격에 올린다 (ticket term-list-reconnect). Windows 는 tmux 없음 (터미널 보존 없음)
# 데몬은 앱 옆 daemon/<os>-<arch>[.exe] 한 규칙으로 찾는다 (backend/relay lib.rs
# daemon_bin_for — 이름은 rust std::env::consts::OS·ARCH 값 그대로). tmux 는 daemon/tmux-<os>-<arch>
# (relay tmux_bin_for — 원격 업로드용. 데몬 자신은 자기 옆의 tmux / tmux-<os>-<arch> / PATH 순으로 찾는다).
# 어느 빌드인지(버전·커밋·와이어)는 끝의 echo 로 — 방금 만든 데몬 자신의 --version.
# 사전 준비: rustup target add x86_64-pc-windows-gnu x86_64-unknown-linux-musl
#           cargo install tauri-cli --version '^2' --locked ; apt install nsis (리눅스 makensis 로 cross 생성)
# main 은 워크스페이스 루트의 build/ 에, 다른 브랜치는 build/<워크트리 폴더명>/ 에
# 넣는다 — 병행 워커끼리 서로 덮어쓰는 사고 방지.
# 순서 주의: front 를 고쳤으면 이 스크립트로 dist 부터 다시 — dist 재빌드 없이
# cargo 만 돌리면 옛 프론트가 exe 에 박힌다.
#
#   ./build.sh                빌드 (stable 채널)
#   ./build.sh --channel dev  dev 채널 빌드 — app/tauri.dev.conf.json 을 얹고(productName
#                             "Superlite-Dev"·identifier·exe 이름) SUPERLITE_CHANNEL=dev 로
#                             common 을 구워(소켓·파이프·캐시·설정 폴더 이름 접미) stable 설치본과
#                             한 PC 에 공존한다 (ticket release-channel). 산출물은
#                             Superlite-Dev_<ver>_x64-setup.exe
#   ./build.sh --clean        자기 출력 폴더 정리만 하고 종료 — 워크트리에서는
#                             build/<워크트리 폴더명>/ 삭제, main 에서는 안전을 위해 아무것도 안 함
set -eu
cd "$(dirname "$0")"

channel=
clean=false
while [ $# -gt 0 ]; do
    case "$1" in
        --clean) clean=true ;;
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
product=Superlite
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

# 편집기 vim 모드(ticket editor-vim-mode)의 Neovim — 고정 버전 릴리스 zip 을 받아 sha256 검증 후
# target/nvim/windows-x86_64/ 에 풀어 리소스로 동봉한다 (앱은 실행 파일 옆 nvim/<os>-<arch>/bin/nvim.exe
# 를 찾는다 — backend/relay nvim.rs nvim_bin). 버전을 올릴 때는 nvim.rs 의 NVIM_VERSION·해시와 함께.
nvim_ver=0.12.5
nvim_sha=de8625ba8cf65ebf40eb80a388ba1ec8e9c15b30218821e2c639119b05920de1
nvim_zip=target/nvim-win64-$nvim_ver.zip
nvim_dir=target/nvim/windows-x86_64
if [ ! -f "$nvim_dir/bin/nvim.exe" ]; then
    [ -f "$nvim_zip" ] || curl -fsSL -o "$nvim_zip" "https://github.com/neovim/neovim/releases/download/v$nvim_ver/nvim-win64.zip"
    echo "$nvim_sha  $nvim_zip" | sha256sum -c - >/dev/null || { echo "nvim-win64.zip 해시 불일치" >&2; rm -f "$nvim_zip"; exit 2; }
    rm -rf "$nvim_dir" target/nvim-win64
    mkdir -p target/nvim
    unzip -q "$nvim_zip" -d target/nvim-win64
    mv target/nvim-win64/nvim-win64 "$nvim_dir"
    rmdir target/nvim-win64
fi
# 빌드 정보(커밋·dirty·시각)는 common 의 build.rs 가 굽는다 — 재실행 조건이 HEAD 변경뿐이라
# 배포 빌드는 touch 로 강제 재실행해 현재 트리 상태를 정확히 박는다
touch backend/common/build.rs
cargo build --release --target x86_64-pc-windows-gnu -p superlite-daemon
cargo build --release --target x86_64-unknown-linux-musl -p superlite-daemon
# 앱은 tauri-cli 로 — 같은 --release --target 이라 target/ 산출물은 위와 같은 자리에 나오고,
# 이어서 NSIS 설치 파일을 묶는다. 번들 설정은 tauri.bundle.conf.json 에만 두고 --config 로
# 얹는다: 데몬 바이너리를 리소스로 동봉하는데(설치본에서도 앱 옆 daemon/<os>-<arch> 규칙 유지)
# tauri-build 가 컴파일 시점에 리소스 존재를 요구해 평소 cargo build 까지 데몬을 먼저 요구하게
# 되면 안 되기 때문 — 그래서 데몬 두 개를 먼저 만든다.
# shellcheck disable=SC2086 — tauri_cfg 는 의도한 단어 분리
(cd app && cargo tauri build --target x86_64-pc-windows-gnu $tauri_cfg)

mkdir -p "$out"
# 번들러 산출물 이름은 <productName>_<ver>_x64-setup.exe — 채널별 productName 으로 고른다
src=$(ls target/x86_64-pc-windows-gnu/release/bundle/nsis/"$product"_*_x64-setup.exe)
dst=$out/$(basename "$src")
cp "$src" "$dst"
echo "→ $dst — $(target/x86_64-unknown-linux-musl/release/superlite-daemon --version | sed 's/^superlite-daemon //')"
