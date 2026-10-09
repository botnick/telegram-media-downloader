#!/bin/sh
# Installed as /usr/local/bin/node. There is no Node runtime in 3.x; this
# only keeps compose files written for 2.x working after an image pull:
#   healthcheck: node scripts/healthcheck.js
#   command:     node src/web/server.js   (Synology compose, runner.js)
case "${1:-}" in
    scripts/healthcheck.js | /app/scripts/healthcheck.js)
        exec wget -qO /dev/null "http://127.0.0.1:${PORT:-3000}/health"
        ;;
    src/web/server.js | /app/src/web/server.js | runner.js | /app/runner.js)
        exec /usr/local/bin/tgdl-server
        ;;
    *)
        echo "node: not available — Telegram Media Downloader 3.x is a native Go server (tgdl-server). This shim only accepts the 2.x healthcheck and start commands." >&2
        exit 127
        ;;
esac
