#!/usr/bin/env bash
# build-release.sh — cross-compile seekbar-service for every supported
# platform and produce tarballs under dist/.
#
# Usage:
#   ./build-release.sh              # build all platforms
#   ./build-release.sh linux-x64   # build a single named target
#
# Output layout:
#   dist/
#     tgdl-seekbar-win-x64.tar.gz        (contains .exe binaries)
#     tgdl-seekbar-linux-x64.tar.gz
#     ...
#
# Requirements: Go 1.22+, tar, gzip. No C toolchain — CGO is disabled.
set -euo pipefail

MODULE="github.com/botnick/telegram-media-downloader/seekbar-service"
SERVER="./cmd/server"
CLI="./cmd/cli"
BINDIR="bin"
DISTDIR="dist"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
LDFLAGS="-s -w -X ${MODULE}/internal/api.ServiceVersion=${VERSION}"

mkdir -p "$BINDIR" "$DISTDIR"

build_target() {
    local name="$1"   # e.g. linux-x64
    local goos="$2"
    local goarch="$3"
    local ext="${4:-}"  # ".exe" for windows, "" otherwise

    local server_bin="${BINDIR}/tgdl-seekbar-${name}${ext}"
    local cli_bin="${BINDIR}/tgdl-seekbar-cli-${name}${ext}"

    echo "  Building ${name}..."
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -ldflags "$LDFLAGS" -o "$server_bin" "$SERVER"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
        go build -trimpath -ldflags "$LDFLAGS" -o "$cli_bin" "$CLI"

    local tarball="${DISTDIR}/tgdl-seekbar-${name}.tar.gz"
    tar -czf "$tarball" \
        -C "$BINDIR" \
        "$(basename "$server_bin")" \
        "$(basename "$cli_bin")"
    echo "  => $tarball"
}

# Map target name → GOOS / GOARCH / exe-extension
declare -A TARGETS_GOOS TARGETS_GOARCH TARGETS_EXT
TARGETS_GOOS["win-x64"]="windows";     TARGETS_GOARCH["win-x64"]="amd64";   TARGETS_EXT["win-x64"]=".exe"
TARGETS_GOOS["win-arm64"]="windows";   TARGETS_GOARCH["win-arm64"]="arm64";  TARGETS_EXT["win-arm64"]=".exe"
TARGETS_GOOS["linux-x64"]="linux";     TARGETS_GOARCH["linux-x64"]="amd64";  TARGETS_EXT["linux-x64"]=""
TARGETS_GOOS["linux-arm64"]="linux";   TARGETS_GOARCH["linux-arm64"]="arm64"; TARGETS_EXT["linux-arm64"]=""
TARGETS_GOOS["linux-x86"]="linux";     TARGETS_GOARCH["linux-x86"]="386";    TARGETS_EXT["linux-x86"]=""
TARGETS_GOOS["mac-x64"]="darwin";      TARGETS_GOARCH["mac-x64"]="amd64";    TARGETS_EXT["mac-x64"]=""
TARGETS_GOOS["mac-arm64"]="darwin";    TARGETS_GOARCH["mac-arm64"]="arm64";   TARGETS_EXT["mac-arm64"]=""
TARGETS_GOOS["dsm-x64"]="linux";       TARGETS_GOARCH["dsm-x64"]="amd64";    TARGETS_EXT["dsm-x64"]=""
TARGETS_GOOS["dsm-arm64"]="linux";     TARGETS_GOARCH["dsm-arm64"]="arm64";   TARGETS_EXT["dsm-arm64"]=""

ALL_TARGETS=(win-x64 win-arm64 linux-x64 linux-arm64 linux-x86 mac-x64 mac-arm64 dsm-x64 dsm-arm64)

if [ $# -eq 0 ]; then
    SELECTED=("${ALL_TARGETS[@]}")
else
    SELECTED=("$@")
fi

echo "seekbar-service release build — version: ${VERSION}"
echo "Targets: ${SELECTED[*]}"
echo ""

for target in "${SELECTED[@]}"; do
    if [ -z "${TARGETS_GOOS[$target]+x}" ]; then
        echo "ERROR: unknown target '$target'" >&2
        echo "Valid targets: ${ALL_TARGETS[*]}" >&2
        exit 1
    fi
    build_target "$target" "${TARGETS_GOOS[$target]}" "${TARGETS_GOARCH[$target]}" "${TARGETS_EXT[$target]}"
done

echo ""
echo "Done. Archives written to ${DISTDIR}/:"
ls -lh "${DISTDIR}"/tgdl-seekbar-*.tar.gz 2>/dev/null || true
