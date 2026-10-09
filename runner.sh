#!/bin/sh
# Direct launcher. Use Docker/systemd for automatic restart supervision.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_BIN=${TGDL_SERVER_BIN:-$PROJECT_DIR/core-service/tgdl-server}
if [ ! -x "$SERVER_BIN" ]; then
    echo "tgdl-server is missing or not executable: $SERVER_BIN" >&2
    echo "Build it with: make -C \"$PROJECT_DIR\" build" >&2
    exit 127
fi
TGDL_DATA_DIR=${TGDL_DATA_DIR:-$PROJECT_DIR/data}
export TGDL_DATA_DIR
exec "$SERVER_BIN" "$@"
