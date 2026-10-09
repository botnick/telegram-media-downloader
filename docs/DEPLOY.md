---
title: "Install and deploy"
description: "Install Telegram Media Downloader with Docker Compose, a release binary or from source; set the first password, run behind a reverse proxy, and update."
nav_order: 2
---

# Install and deploy

Telegram Media Downloader is one `tgdl-server` process with the dashboard
embedded in the binary. ffmpeg (for thumbnails and video work) is the only
external program it calls. Pick one of the three ways to run it:

| Option | Best for | Needs |
|---|---|---|
| [Docker Compose](#docker-compose) | Servers, NAS, most people | Docker with Compose |
| [Release binary](#release-binary) | A plain Linux, Windows or macOS machine | ffmpeg |
| [From a git checkout](#from-a-git-checkout) | Upgraded 2.x checkouts, PM2 users | ffmpeg; Go only to build yourself |

All of them need a Telegram `apiId` and `apiHash` from
[my.telegram.org](https://my.telegram.org), which you paste into the dashboard
after the first sign-in.

## Docker Compose

```sh
mkdir telegram-media-downloader && cd telegram-media-downloader
mkdir -p data
curl -fsSLO https://raw.githubusercontent.com/botnick/telegram-media-downloader/main/docker-compose.yml
docker compose up -d
docker compose logs -f telegram-downloader
```

What you get:

- `telegram-downloader` runs the multi-arch image
  `ghcr.io/botnick/telegram-media-downloader:latest` (linux/amd64 and
  linux/arm64) on port `3000`. All state lives in `./data`, mounted at
  `/app/data`. Change the host port with `TGDL_PORT` in `.env`.
- `autoheal` restarts the container if `/health` stops answering.
- `watchtower` stays idle until you press **Install update** in the dashboard.
  It has no published port and only touches containers carrying its label.

The entrypoint starts as root only to fix ownership of the data folder and to
join the group of a passed-through `/dev/dri`, then runs the server as the
unprivileged `node` user (uid 1000, as in 2.x). Both the image and the Compose
file allow 60 seconds for a clean shutdown.

Optional settings go in a `.env` file next to `docker-compose.yml`; start from
[`.env.example`](https://github.com/botnick/telegram-media-downloader/blob/main/.env.example)
and see [Configuration](CONFIGURATION.md).

**Synology:** download `docker-compose.synology.yml` instead, adjust the data
volume path, and start it the same way (Container Manager project or
`docker compose -f docker-compose.synology.yml up -d`).

To build the image from source, replace the `image:` and `pull_policy:` lines
in `docker-compose.yml` with `build: .` inside a git checkout.

## First dashboard password

For safety, the first password can only be set from the machine itself.

- **Same machine, no Docker:** open `http://localhost:3000` and use the setup
  form.
- **Docker or a remote server:** put the password on one line in a private
  file (8 characters minimum, readable only by you) and run:

```sh
docker compose exec -T -u node telegram-downloader tgdl-server setup --password-stdin < /path/to/password-file
# Without Docker, next to the running server:
PORT=3000 ./tgdl-server setup --password-stdin < /path/to/password-file
```

Delete the file afterwards and sign in at `http://<host>:3000`. The command
talks to the running server over loopback. It never accepts a password as an
argument and cannot replace an existing password; change the password later
from the dashboard.

Then:

1. **Settings → Telegram API**: paste `apiId` and `apiHash`.
2. **Settings → Accounts → Add**: phone number, login code, optional 2FA.
3. **Chats**: turn on the monitor for a chat, start a backfill, or paste a
   `t.me/` link.

## Release binary

Each [release](https://github.com/botnick/telegram-media-downloader/releases/latest)
has `tgdl-server-v<version>-<os>-<arch>.tar.gz` archives for Linux (amd64,
arm64, arm, 386), Windows (amd64, arm64) and macOS (amd64, arm64), plus a
`SHA256SUMS` file.

```sh
VERSION=3.0.0
curl -fsSLO https://github.com/botnick/telegram-media-downloader/releases/download/v$VERSION/tgdl-server-v$VERSION-linux-amd64.tar.gz
curl -fsSLO https://github.com/botnick/telegram-media-downloader/releases/download/v$VERSION/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf tgdl-server-v$VERSION-linux-amd64.tar.gz
TGDL_DATA_DIR=./data PORT=3000 ./tgdl-server
```

Install ffmpeg from your package manager for thumbnails, or point
`FFMPEG_PATH` at it. `./tgdl-server help` lists the commands (`setup`,
`backup-restore`, `backup-decrypt`, `version`).

### systemd

```ini
[Unit]
Description=Telegram Media Downloader
After=network-online.target
Wants=network-online.target

[Service]
User=tgdl
Group=tgdl
Environment=TGDL_DATA_DIR=/var/lib/telegram-media-downloader
Environment=PORT=3000
ExecStart=/opt/telegram-media-downloader/tgdl-server
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

## From a git checkout

```sh
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
./runner.sh            # Windows: run_safe.bat (or watchdog.ps1)
```

When `core-service/tgdl-server` is missing or older than the checkout, the
launcher downloads the matching release archive, verifies it against
`SHA256SUMS` and installs it, so no Go toolchain is needed. Data goes to
`./data` unless `TGDL_DATA_DIR` is set. `npm start` and
`pm2 start ecosystem.config.cjs` call the same launcher (they only need the
`node` command for the small wrapper script).

The launchers do not restart a crashed server; use systemd, PM2 or the Windows
task scheduler for that. Set `TGDL_SERVER_BIN` to run your own build.

### Build from source

Needs Go 1.26.

```sh
make build             # writes core-service/tgdl-server
./runner.sh            # or: TGDL_DATA_DIR=./data core-service/tgdl-server
```

## Reverse proxy and HTTPS

Put a reverse proxy in front when the dashboard is reachable from outside
your network. Forward the WebSocket upgrade headers and set:

- `TGDL_SECURE_COOKIES=1` once the dashboard is served over HTTPS;
- `TRUST_PROXY` to match your proxy (the Compose file uses `1`, one hop);
- `TGDL_BIND_HOST=127.0.0.1` for a native install with the proxy on the same
  host, so the port is not reachable directly.

Caddy:

```text
tgdl.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name tgdl.example.com;
    # ssl_certificate / ssl_certificate_key ...
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }
}
```

## Updating

- **Dashboard (Docker):** Settings → Maintenance → **Install update**. It
  checks the database, saves a verified snapshot to
  `data/backups/db-pre-update-*.sqlite`, then asks watchtower to recreate the
  container.
- **Docker, by hand:** `docker compose pull && docker compose up -d`
- **Release binary:** replace `tgdl-server` with the new one and restart.
- **Git checkout:** `git pull`, then restart; the launcher fetches the
  matching binary.

Migrations are idempotent and run before `/health` reports ready.
Coming from 2.x? Read [Upgrading from 2.x](UPGRADING.md).
