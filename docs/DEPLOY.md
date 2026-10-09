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
TGDL_UID=$(id -u) TGDL_GID=$(id -g) docker compose up --build -d
docker compose logs -f telegram-downloader
```

The image listens on port `3000` and stores all mutable state under `/app/data`.
Override the host port with `TGDL_PORT` and persist that directory. The image
runs as a non-root user (image UID/GID 1000) and its healthcheck calls `GET /health`.
Compose builds this checkout locally and never pulls the old published runtime.
The bind directory must exist; Compose refuses to create a root-owned empty
directory. Set `TGDL_UID`/`TGDL_GID` to its owner and preserve those values in
`.env` for later starts. No launcher changes ownership of an existing library. Both manifests allow
60 seconds for HTTP draining and worker cleanup before a forced stop.

For Synology, copy `docker-compose.synology.yml`, adjust the data volume, and
run the same command. The manifest builds the same Go image on amd64 and arm64.
Set the UID/GID to the owner of the selected NAS directory.

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

`./runner.sh` (or `watchdog.ps1` on Windows) launches the Go binary directly.
The default binary and data paths are resolved against the checkout, so invoking
it from another directory is safe. `TGDL_SERVER_BIN` and `TGDL_DATA_DIR` override
them. There is no shell retry loop; configure restart supervision in the OS.

## Environment

| Variable | Default | Meaning |
|---|---:|---|
| `TGDL_DATA_DIR` | required | SQLite database, sessions, downloads, logs and backups. The directory is created with mode 0700. |
| `PORT` | `3000` | HTTP and WebSocket listen port. |
| `TGDL_SESSION_TTL_DAYS` | `7` | Lifetime of a newly issued web session, from 1 to 3650 days. |
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
docker compose build --pull
docker compose up -d
```

Migrations are idempotent and run before `/health` becomes ready. Create an
SQLite snapshot from the dashboard maintenance action or copy the generated
file under `data/backups/` after the server is stopped. Each Go snapshot
contains a byte count and SHA-256 digest.
