#!/usr/bin/env bash
# Universal watchdog runner — POSIX equivalent of runner.js / watchdog.ps1.
# Restarts the chosen subcommand with exponential backoff up to MAX_CRASHES.
#
#   ./runner.sh               # uses TGDL_RUN env (default: monitor)
#   TGDL_RUN=history ./runner.sh

set -u
COMMAND=${TGDL_RUN:-monitor}
# libuv's worker pool (fs, crypto, dns, sharp thumbnails) is sized once at
# process start; the default of 4 is easily saturated.
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"
MAX_CRASHES=10
RESET_WINDOW=60
LOG_DIR="data/logs"
LOG_FILE="$LOG_DIR/protection_log.txt"
mkdir -p "$LOG_DIR"

count=0
while true; do
    start=$(date +%s)
    printf '\n\033[32m🚀 Launching (attempt #%d, command: %s)\033[0m\n' "$((count+1))" "$COMMAND"
    node src/index.js $COMMAND
    code=$?
    elapsed=$(( $(date +%s) - start ))
    if [ "$code" = "0" ]; then
        echo "✅ Process exited cleanly."
        exit 0
    fi
    printf '[%s] Crashed with exit code %d\n' "$(date -u +%FT%TZ)" "$code" >> "$LOG_FILE"
    printf '\033[31m❌ Crash code %d\033[0m\n' "$code"

    if [ "$elapsed" -gt "$RESET_WINDOW" ]; then
        count=0
    else
        count=$((count + 1))
    fi
    if [ "$count" -ge "$MAX_CRASHES" ]; then
        echo "⛔ Too many crashes — stopping."
        exit 1
    fi
    delay=$(( 5 * (count + 1) ))
    [ "$delay" -gt 60 ] && delay=60
    printf '⏳ Restart in %ds…\n' "$delay"
    sleep "$delay"
done
