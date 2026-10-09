---
title: "Configuration"
description: "Configure Telegram Media Downloader 3.0: dashboard settings, every environment variable tgdl-server reads, Docker Compose options and the data folder layout."
nav_order: 4
---

# Configuration

Almost everything is set in the dashboard and stored in SQLite
(`data/db.sqlite`); changes apply without a restart. Environment variables
cover only what the process needs before it starts: where data lives, which
port to listen on and how to sit behind a proxy.

## Dashboard settings

| Where | What |
|---|---|
| **Settings → Telegram API** | `apiId` and `apiHash` from [my.telegram.org](https://my.telegram.org) |
| **Settings → Accounts** | Telegram accounts (phone, login code, optional 2FA) |
| **Settings → Downloads** | Parallel downloads (1–50), attempts per file (1–20, counting the first), bandwidth limit (0 = unlimited) |
| **Settings** (other sections) | Proxy (SOCKS5, SOCKS4, HTTP, MTProxy), dashboard and guest passwords, share links, CSP and HTTPS policy, rescue mode, appearance |
| **Chats → a chat** | Monitor on/off, media types, senders, forum topics, which account reads it |
| **Maintenance** | Updates, database tools, logs, sessions, cluster pairing |
| **Backup** | Destinations and schedules, see [Backup](BACKUP.md) |

Settings that 3.0 does not act on (for example `rateLimits`,
`pollingInterval`, auto-forward and disk rotation) are kept as they are but
have no effect.

## Environment variables

Every variable below is read by the current code. Names not listed here are
ignored.

### Server (`tgdl-server`)

| Variable | Default | Meaning |
|---|---|---|
| `TGDL_DATA_DIR` | required; `/app/data` in Docker, `./data` with the launchers | Database, sessions, thumbnails, logs and backups. Created with mode 0700. |
| `TGDL_DOWNLOADS_DIR` | `<data>/downloads` | Put media on another disk. The database and thumbnails stay in the data folder. In Docker, also mount that path into the container. |
| `PORT` | `3000` | HTTP and WebSocket port. |
| `TGDL_BIND_HOST` | all interfaces | Literal IPv4/IPv6 address to listen on, e.g. `127.0.0.1` behind a reverse proxy on the same host. |
| `TGDL_SESSION_TTL_DAYS` | `7` | Lifetime of a new dashboard sign-in, 1–3650 days. |
| `TGDL_SECURE_COOKIES` | `0` | Set to `1` when the dashboard is served over HTTPS. |
| `TRUST_PROXY` | `loopback` when unset | Which proxies may set `X-Forwarded-*`: a hop count (`1`), a comma list of IPs, CIDRs or `loopback`, `linklocal`, `uniquelocal`, or empty to trust none. The Compose file sets `1`. |
| `TGDL_CSP` | on | `off` disables the Content-Security-Policy header (emergency use only). |
| `COMPRESSION_LEVEL` | `6` | gzip/deflate response compression level, 0–9. |
| `TGDL_METRICS_TOKEN` | unset | When set, `GET /metrics` requires `?token=<value>`. |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg used for thumbnails and video operations. |
| `FASTSTART_CONCURRENCY` | `2` | Parallel MP4 faststart rewrites (max 8). |
| `WATCHTOWER_URL` | unset (`http://watchtower:8080` in Compose) | Enables **Install update** through the watchtower sidecar. |
| `WATCHTOWER_HTTP_API_TOKEN` | generated | Token shared with watchtower. When unset, it is generated once in `data/watchtower/api-token`. |
| `PUBLIC_URL` | unset | This instance's own address as seen by cluster peers. See [Cluster mode](CLUSTER.md). |
| `TZ` | host | Time zone for logs and schedules. |
| `GOMEMLIMIT` | unset | Go runtime soft memory limit, e.g. `1GiB`. Not a hard cap. |

Advanced update timings, rarely needed: `UPDATE_SNAPSHOT_TIMEOUT_MS`
(60000), `UPDATE_BACKUP_KEEP` (5 pre-update snapshots), `UPDATE_STALL_AFTER_MS`
(600000) and `UPDATE_OVERLAY_STALL_MS` (120000).

### Launchers (`runner.sh`, `run_safe.bat`, `watchdog.ps1`, `npm start`)

| Variable | Default | Meaning |
|---|---|---|
| `TGDL_SERVER_BIN` | `core-service/tgdl-server` | Run your own binary; skips the release download. |
| `TGDL_RELEASE_REPO` | `botnick/telegram-media-downloader` | GitHub repository to download the release from. |
| `TGDL_RELEASE_BASE_URL` | GitHub release of the checkout's version | Mirror for the release archive and `SHA256SUMS` (`runner.sh` only). |

The launchers do not read `.env`. Export variables in the shell, the systemd
unit or the PM2 config instead.

### Docker Compose (`.env`)

Compose reads `.env` next to `docker-compose.yml`. Start from
[`.env.example`](https://github.com/botnick/telegram-media-downloader/blob/main/.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `TGDL_PORT` | `3000` | Host port mapped to the container's port 3000. |
| `TGDL_MEM_LIMIT` | `8g` | Container memory limit. |
| `TZ`, `TGDL_DOWNLOADS_DIR`, `TRUST_PROXY`, `TGDL_SECURE_COOKIES`, `WATCHTOWER_URL`, `WATCHTOWER_HTTP_API_TOKEN` | see above | Passed to the server. |
| `WATCHTOWER_HTTP_API_PERIODIC_POLLS` | `false` | Let watchtower also poll for updates on its own. |

To pass other server variables (`TGDL_CSP`, `COMPRESSION_LEVEL`,
`TGDL_METRICS_TOKEN`, `PUBLIC_URL`, ...) add them to the `environment:` list of
the `telegram-downloader` service.

### Ignored since 3.0

`NODE_ENV`, `NODE_OPTIONS`, `TGDL_HEAP_MB`, `TGDL_GO_CORE`,
`TGDL_GO_FEATURES`, `TGDL_CORE_BIN`, `TGDL_CORE_RELEASE_URL`,
`FFMPEG_HWACCEL`, `TGDL_UID`, `TGDL_GID`, `FACES_SERVICE_URL`,
`TGDL_NSFW_SIDECAR_URL` and `SEEKBAR_SIDECAR_URL` have no effect on the 3.0
server. Leaving them in `.env` is harmless.

## Data folder

```text
data/
├── db.sqlite            # settings, catalog, jobs, sessions (WAL mode)
├── secret.key           # encrypts Telegram sessions: back it up
├── sessions/native/     # encrypted Telegram logins
├── downloads/<chat>/    # media (or TGDL_DOWNLOADS_DIR)
├── thumbs/              # generated thumbnails
├── photos/              # cached chat and profile photos
├── seekbar/             # video preview sprites made by 2.x
├── backups/             # database snapshots, incl. db-pre-update-*.sqlite
├── logs/              # 2.x log files (3.0 logs to standard output)
└── watchtower/api-token # generated update token
```

Back up at least `db.sqlite`, `secret.key` and `sessions/`. Losing
`secret.key` makes the saved Telegram logins unreadable; you would have to
sign in again.
