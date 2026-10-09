#!/bin/sh
# Native launcher (Linux / macOS). Use systemd, PM2 or Docker for restarts.
#
# Upgrading from 2.x by `git pull`: there is no Node app any more. When
# core-service/tgdl-server is missing or older than this checkout, the
# launcher downloads the matching release archive, verifies it against the
# release SHA256SUMS and installs it. Set TGDL_SERVER_BIN to use your own build.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_BIN=${TGDL_SERVER_BIN:-$PROJECT_DIR/core-service/tgdl-server}
REPO=${TGDL_RELEASE_REPO:-botnick/telegram-media-downloader}

source_version() {
    sed -n 's/^var AppVersion = "\(.*\)"$/\1/p' "$PROJECT_DIR/core-service/internal/version/app.go"
}

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        echo "Neither curl nor wget is installed; cannot download tgdl-server." >&2
        return 1
    fi
}

install_release() {
    version=$1
    case "$(uname -s)" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) echo "Unsupported OS $(uname -s); build with: make -C \"$PROJECT_DIR\" build" >&2; return 1 ;;
    esac
    case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 ;;
        aarch64 | arm64) arch=arm64 ;;
        armv7* | armv6* | armhf) arch=arm ;;
        i386 | i686) arch=386 ;;
        *) echo "Unsupported CPU $(uname -m); build with: make -C \"$PROJECT_DIR\" build" >&2; return 1 ;;
    esac
    archive="tgdl-server-v$version-$os-$arch.tar.gz"
    base=${TGDL_RELEASE_BASE_URL:-https://github.com/$REPO/releases/download/v$version}
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    echo "Downloading tgdl-server $version ($os/$arch)…" >&2
    fetch "$base/$archive" "$tmp/$archive" || { echo "Release $version is not downloadable ($base/$archive)." >&2; return 1; }
    fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || return 1
    expected=$(awk -v f="$archive" '$2 == f || $2 == "*"f {print $1}' "$tmp/SHA256SUMS")
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
    else
        actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
    fi
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        echo "Checksum mismatch for $archive; refusing to install." >&2
        return 1
    fi
    tar -xzf "$tmp/$archive" -C "$tmp" tgdl-server
    chmod 0755 "$tmp/tgdl-server"
    mv -f "$tmp/tgdl-server" "$SERVER_BIN"
    rm -rf "$tmp"
    trap - EXIT
}

if [ -z "${TGDL_SERVER_BIN:-}" ]; then
    want=$(source_version)
    have=""
    if [ -x "$SERVER_BIN" ]; then
        have=$("$SERVER_BIN" version 2>/dev/null | awk '{print $2}' || true)
    fi
    if [ -n "$want" ] && [ "$have" != "$want" ]; then
        if ! install_release "$want"; then
            if [ -x "$SERVER_BIN" ]; then
                echo "Keeping the existing tgdl-server $have." >&2
            elif command -v go >/dev/null 2>&1; then
                echo "Building tgdl-server from source instead…" >&2
                make -C "$PROJECT_DIR" build
            else
                echo "tgdl-server is missing. Install Go 1.26 and run: make -C \"$PROJECT_DIR\" build" >&2
                exit 127
            fi
        fi
    fi
fi
if [ ! -x "$SERVER_BIN" ]; then
    echo "tgdl-server is missing or not executable: $SERVER_BIN" >&2
    exit 127
fi
TGDL_DATA_DIR=${TGDL_DATA_DIR:-$PROJECT_DIR/data}
export TGDL_DATA_DIR
exec "$SERVER_BIN" "$@"
