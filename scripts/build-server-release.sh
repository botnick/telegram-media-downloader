#!/bin/sh
# Cross-build the application, without an installer or JavaScript toolchain.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GO=${GO:-go}
MODULE="$PROJECT_DIR/core-service"
DIST=${TGDL_RELEASE_DIR:-$MODULE/dist}
version=$("$GO" -C "$MODULE" run ./cmd/tgdl-server version | awk '{print $2}')
case "$version" in ''|*[!0-9A-Za-z.+-]*) echo 'Invalid application version' >&2; exit 1;; esac
if [ -n "${RELEASE_VERSION:-}" ] && [ "$RELEASE_VERSION" != "$version" ]; then
    echo "Tag version $RELEASE_VERSION does not match source version $version" >&2
    exit 1
fi
mkdir -p "$DIST"
DIST=$(CDPATH= cd -- "$DIST" && pwd)
STAGE=$(mktemp -d "$DIST/.server-build.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
: > "$STAGE/SHA256SUMS"
for target in ${TGDL_RELEASE_TARGETS:-linux/amd64 linux/arm64 linux/arm linux/386 windows/amd64 windows/arm64 darwin/amd64 darwin/arm64}; do
    case "$target" in linux/amd64|linux/arm64|linux/arm|linux/386|windows/amd64|windows/arm64|darwin/amd64|darwin/arm64) ;;
        *) echo "Unsupported release target: $target" >&2; exit 1;;
    esac
    target_os=${target%/*}
    target_arch=${target#*/}
    executable=tgdl-server
    [ "$target_os" != windows ] || executable=tgdl-server.exe
    archive="tgdl-server-v$version-$target_os-$target_arch.tar.gz"
    CGO_ENABLED=0 GOOS=$target_os GOARCH=$target_arch GOARM=7 \
        "$GO" -C "$MODULE" build -trimpath -ldflags '-s -w' -o "$STAGE/$executable" ./cmd/tgdl-server
    tar -czf "$STAGE/$archive" -C "$STAGE" "$executable" -C "$PROJECT_DIR" LICENSE
    mv "$STAGE/$archive" "$DIST/$archive"
    (cd "$DIST" && sha256sum "$archive") >> "$STAGE/SHA256SUMS"
    rm "$STAGE/$executable"
    echo "Built $archive"
done
mv "$STAGE/SHA256SUMS" "$DIST/SHA256SUMS"
