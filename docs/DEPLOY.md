---
title: "Deploy"
description: "Deploy the pure-Go Telegram media downloader."
nav_order: 2
---

# Deploy

Production is one `tgdl-server` process. The browser bundle is embedded in
its binary, so the container does not install or execute Node. ffmpeg and an
explicitly configured AI worker are the only optional external processes.

## Docker

```sh
mkdir -p data
curl -fsSLO https://raw.githubusercontent.com/botnick/telegram-media-downloader/main/docker-compose.yml
docker compose up -d
docker compose logs -f telegram-downloader
```

The image `ghcr.io/botnick/telegram-media-downloader` listens on port `3000`
and stores all mutable state under `/app/data`. Override the host port with
`TGDL_PORT`. The entrypoint starts as root only to fix ownership of the
bind-mounted data folder and to join the group of a passed-through `/dev/dri`,
then runs the server as the unprivileged `node` user (uid 1000, as in 2.x).
The healthcheck calls `GET /health`. Both manifests allow 60 seconds for HTTP
draining and worker cleanup before a forced stop.

The bundled `autoheal` service restarts a container that stops answering, and
the idle `watchtower` service backs **Settings → Maintenance → Install update**.

For Synology, copy `docker-compose.synology.yml`, adjust the data volume path,
and run the same command.

## First dashboard password

Create a private file readable only by your user, containing the chosen password
on one line (8 characters minimum, UTF-8, 4096 bytes maximum). With the server
running:

```sh
docker compose exec -T -u node telegram-downloader tgdl-server setup --password-stdin < /path/to/private-password-file
# Bare metal, beside the running server:
PORT=3000 ./core-service/tgdl-server setup --password-stdin < /path/to/private-password-file
```

Delete the private file after setup and sign in through the web dashboard. This
command uses the loopback interface inside the running container; it does not
accept passwords as command arguments, change an existing password, or enable
remote unauthenticated setup. A browser on the same bare-metal host can also
use the setup form directly. Behind Docker or a proxy, use the command above.

## Bare metal

Install Go 1.26.8 and ffmpeg, then build and run:

```sh
cd core-service
go build -trimpath -ldflags '-s -w' -o tgdl-server ./cmd/tgdl-server
TGDL_DATA_DIR=/var/lib/telegram-media-downloader PORT=3000 ./tgdl-server
```

A systemd unit can execute the binary directly:

```ini
[Unit]
Description=Telegram media downloader
After=network-online.target

[Service]
User=tgdl
Group=tgdl
WorkingDirectory=/opt/telegram-media-downloader/core-service
Environment=TGDL_DATA_DIR=/var/lib/telegram-media-downloader
Environment=PORT=3000
ExecStart=/opt/telegram-media-downloader/core-service/tgdl-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`./runner.sh` (or `run_safe.bat` / `watchdog.ps1` on Windows) runs the server
from a checkout. When `core-service/tgdl-server` is missing or older than the
checkout, it downloads the matching release archive, verifies it against the
release `SHA256SUMS` and installs it, so no Go toolchain is needed. `npm start`
and `pm2 start ecosystem.config.cjs` call the same launcher. `TGDL_SERVER_BIN`
selects your own build (and skips the download); `TGDL_DATA_DIR` defaults to
the checkout's `data/`. There is no shell retry loop; configure restart
supervision in the OS or PM2.

## Environment

| Variable | Default | Meaning |
|---|---:|---|
| `TGDL_DATA_DIR` | required (`/app/data` in Docker, `./data` with the launchers) | SQLite database, sessions, downloads, logs and backups. The directory is created with mode 0700. |
| `TGDL_DOWNLOADS_DIR` | `<data>/downloads` | Media on another disk (split-disk installs). Thumbnails and the database stay in the data directory. |
| `PORT` | `3000` | HTTP and WebSocket listen port. |
| `TGDL_SESSION_TTL_DAYS` | `7` | Lifetime of a newly issued web session, from 1 to 3650 days. |
| `FFMPEG_PATH` | `ffmpeg` | Explicit ffmpeg path for video operations. |
| `TZ` | host | Log and display timezone. |
| `TRUST_PROXY` | unset | Forwarded-header trust: `1` trusts one proxy hop, `loopback`, or empty for none. |
| `WATCHTOWER_URL` / `WATCHTOWER_HTTP_API_TOKEN` | unset / generated | One-click updates through the watchtower sidecar. The token is generated in `data/watchtower/api-token` when not set. |

2.x variables that no longer apply (`NODE_ENV`, `NODE_OPTIONS`, `TGDL_HEAP_MB`,
`TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `TGDL_CORE_BIN`, `TGDL_CORE_RELEASE_URL`,
`FFMPEG_HWACCEL`) are ignored. Leaving them in an existing `.env` is harmless.

## Reverse proxy

Forward the same port to the proxy and preserve `Upgrade` / `Connection`
headers for WebSocket. Terminate TLS at the proxy and set a secure cookie
policy there. The application binds to the address supplied by the container;
keep it private when the proxy is on another host.

## Updating

- **Dashboard:** Settings → Maintenance → **Install update**. It checks the
  database, saves a verified snapshot to `data/backups/db-pre-update-*.sqlite`
  and asks the watchtower sidecar to recreate the container.
- **Docker, manually:** `docker compose pull && docker compose up -d`
- **Bare metal:** `git pull`, then restart with `./runner.sh`, `npm start` or
  PM2; the launcher fetches the matching binary.

Migrations are idempotent and run before `/health` becomes ready.

### From 2.x to 3.0

Nothing has to change: the image name, port, `./data` folder, container user,
`.env`, dashboard password, sessions and Telegram logins carry over, and the
2.x compose files keep working (their `node scripts/healthcheck.js` check and
Synology's `node src/web/server.js` command are mapped to the Go server). Each
saved gramJS login is converted once to `data/sessions/native/`; the original
files are left in place. Re-downloading the compose file is optional.

Known gaps in 3.0: Google Drive and Dropbox backup destinations are not
available yet, and video thumbnails use the CPU (`FFMPEG_HWACCEL` is ignored).
To go back to 2.32.1, restore the pre-update snapshot from `data/backups/`.
