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
docker compose up -d
docker compose logs -f telegram-downloader
```

The image listens on port `3000` and stores all mutable state under `/app/data`.
Override the host port with `TGDL_PORT` and persist that directory. The image
runs as a non-root `tgdl` user and its healthcheck calls `GET /health`.

For Synology, copy `docker-compose.synology.yml`, adjust the data volume, and
run the same command. The manifest uses the same pure-Go image on amd64 and
arm64.

## Bare metal

Install Go 1.22 or newer and ffmpeg, then build and run:

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

`runner.sh` is available for hosts without systemd, but a native supervisor is
preferred because it handles signals and logs directly.

## Environment

| Variable | Default | Meaning |
|---|---:|---|
| `TGDL_DATA_DIR` | required | SQLite database, sessions, downloads, logs and backups. The directory is created with mode 0700. |
| `PORT` | `3000` | HTTP and WebSocket listen port. |
| `TGDL_SESSION_TTL_DAYS` | `30` | Lifetime of a newly issued web session, from 1 to 3650 days. |
| `FFMPEG_PATH` | `ffmpeg` | Explicit ffmpeg path for video operations. |
| `TZ` | host | Log and display timezone. |

The old `TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `TGDL_CORE_BIN` and
`TGDL_CORE_RELEASE_URL` variables are ignored by the pure-Go server. Leaving
them in an existing `.env` is harmless, but they no longer select a fallback.

## Reverse proxy

Forward the same port to the proxy and preserve `Upgrade` / `Connection`
headers for WebSocket. Terminate TLS at the proxy and set a secure cookie
policy there. The application binds to the address supplied by the container;
keep it private when the proxy is on another host.

## Upgrade and backup

```sh
docker compose pull
docker compose up -d
```

Migrations are idempotent and run before `/health` becomes ready. Create an
SQLite snapshot from the dashboard maintenance action or copy the generated
file under `data/backups/` after the server is stopped. Each Go snapshot
contains a byte count and SHA-256 digest.
