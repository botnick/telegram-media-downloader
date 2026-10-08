#!/usr/bin/env bash
# Small restart guard for the pure-Go server. Docker/systemd users should
# prefer their supervisor; this remains useful for a bare-metal install.
set -u
SERVER_BIN=${TGDL_SERVER_BIN:-./core-service/tgdl-server}
MAX_CRASHES=10
RESET_WINDOW=60
LOG_DIR="${TGDL_DATA_DIR:-data}/logs"
LOG_FILE="$LOG_DIR/protection_log.txt"
mkdir -p "$LOG_DIR"

count=0
while true; do
    start=$(date +%s)
    "$SERVER_BIN"
    code=$?
    elapsed=$(( $(date +%s) - start ))
    if [ "$code" = "0" ]; then
        exit 0
    fi
    printf '[%s] tgdl-server exited with code %d\n' "$(date -u +%FT%TZ)" "$code" >> "$LOG_FILE"
    if [ "$elapsed" -gt "$RESET_WINDOW" ]; then
        count=0
    else
        count=$((count + 1))
    fi
    if [ "$count" -ge "$MAX_CRASHES" ]; then
        exit 1
    fi
    delay=$((5 * (count + 1)))
    [ "$delay" -gt 60 ] && delay=60
    sleep "$delay"
done
