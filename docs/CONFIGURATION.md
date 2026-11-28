---
title: "Configuration"
description: "Configure Telegram Media Downloader 3.x: dashboard settings, advanced keys, every environment variable tgdl-server reads, Compose options, data folder."
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
| **Settings → Accounts** | Telegram accounts (phone and login code, or a QR code scanned from the Telegram app; optional 2FA) |
| **Settings → Downloads** | Concurrent downloads (1–50, the starting point of the [adaptive concurrency](#advanced-settings)), attempts per file (1–20, counting the first), bandwidth limit (0 = unlimited) |
| **Settings → Downloads** (disk) | Library size cap (`maxTotalSize`) and **Auto-rotate when full**, see [disk rotation](#advanced-settings) |
| **Settings** (other sections) | Proxy (SOCKS5, SOCKS4, HTTP, MTProxy), dashboard and guest passwords, share links, CSP and HTTPS policy, rescue mode, appearance |
| **Settings → Forward protection** | Protect forwarded copies by default (`forwarding.protect`); a chat can override it |
| **Chats → a chat** | Monitor on/off, media types, senders, forum topics, which account reads it, **Forward to** (routes and destinations, captions, protection, direct forward, scan route, forward account, delete after forward; see [Auto-forward](#auto-forward)) |
| **Maintenance** | Updates, database tools, logs, sessions, cluster pairing and sweep, seekbar previews, NSFW review |
| **Safety & AI** | Face recognition and its sidecar, see [AI](AI.md) |
| **Backup** | Destinations and schedules, see [Backup](BACKUP.md) |

Settings that 3.x does not act on (`rateLimits` and `pollingInterval`) are
kept as they are but have no effect.

## Advanced settings

These keys are stored in the same configuration. The `advanced.*` ones are
edited under **Settings → Advanced** (for example Min Workers, Max Workers
and Scaler Tick), the disk cap and rotation switch under **Settings →
Downloads**; `diskManagement.sweepIntervalMin` keeps its 2.x value. Values outside
the range are clamped when saved.

| Key | Default | Meaning |
|---|---|---|
| `advanced.downloader.minConcurrency` | `3` (1–100) | Fewest files downloading at once when the queue is idle or after a Telegram FloodWait. |
| `advanced.downloader.maxConcurrency` | `20` (1–100) | Most files downloading at once while the queue is long. Starts at **Concurrent downloads** and grows by up to 3 per step. Set it equal to Concurrent downloads for a fixed number. |
| `advanced.downloader.scalerIntervalSec` | `5` (1–600) | Seconds between scaling steps. |
| `diskManagement.enabled` | `false` | **Auto-rotate when full.** When on, the oldest downloads **and their files are deleted** until the library is under `maxTotalSize`. Pinned and rescued items, files still downloading and files outside the downloads folder are never deleted. |
| `diskManagement.maxTotalSize` | `50GB` | Library cap, e.g. `500GB` or `1.5TB` (binary units). Measured as the sum of catalog file sizes, not free disk space. An unreadable value means no cap. |
| `diskManagement.sweepIntervalMin` | `10` (1–1440) | Minutes between rotation sweeps. The first sweep runs 5 s after start or a settings change. |
| `advanced.diskRotator.maxDeletesPerSweep` | `5000` | Most downloads one sweep may delete. |
| `advanced.integrity.intervalMin` | `60` (at least 60 is used) | Minutes between integrity sweeps, which drop catalog rows whose file is missing. Never deletes files; skips pruning when more than half of the library looks missing. |
| `advanced.forwarder.concurrency` | `1` (1–5) | Forward jobs running at once. Higher values send several files at once and make Telegram FloodWaits more likely. |
| `advanced.forwarder.queueSize` | `256` (1–10000) | Most pending and running forward jobs. A job added over it waits as pending and is picked up once the backlog drains. |
| `advanced.forwarder.intervalSec` | `1` (0–3600) | Smallest gap in seconds between two forward starts across all workers; `0` adds no delay. Also set from the Queue page. |
| `advanced.forwarder.floodWaitAttempts` | `3` (1–10) | Sends of one upload while Telegram keeps answering with a FloodWait, before the job is put back in the queue until the wait is over. |
| `advanced.seekbar.*`, `advanced.nsfw.*`, `advanced.ai.*` | | See [AI](AI.md#settings). |

## Auto-forward

Auto-forward is set per chat (**Chats → a chat → Forward to**) and stored in
the chat's `autoForward` block, plus `forwardAccount`, the account that
sends. How jobs are queued, retried and recovered is described in
[Forward queue](GO-FORWARD-QUEUE.md).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Forward this chat's new files. |
| `routes` | | List of destinations, at most 100 (see below). Saved by the dashboard; one message can go to several destinations. |
| `destination` / `destinationGroupId` | | Single destination of a rule saved without `routes` (older rules). A rule that names no destination and has no `routes` keeps forwarding to the "Telegram Downloader Storage" channel, as before. |
| `captionMode` | `source` | Caption for every route that does not set its own: `source` (the source caption as it is), `none` (no caption) or `custom`. `source_info` (source caption plus source info) and the older `override` and `regex` are saved as `custom`. A rule saved before captions were configurable keeps the 2.x caption: the source caption and a link to the source post. |
| `captionBase` | `source` | For `custom`: start from the source caption (`source`) or from `caption` (`custom`). |
| `caption` | | Custom caption text, at most 4096 bytes. Variables: `{{source_caption}}`, `{{source_name}}`, `{{source_id}}`, `{{message_id}}`, `{{source_info}}`, `{{source_link}}`. |
| `regexPattern`, `regexReplacement` | | Optional find-and-replace on a `custom` caption (Go regular expression; the replacement may use the variables). |
| `protect` | follows `forwarding.protect` | `true`/`false` (or `on`/`off`): protected copies cannot be forwarded or saved in the destination. Unset follows the global **Forward protection** setting. A protected copy is always uploaded, so it turns `directForward` off. |
| `directForward` | `false` | Try Telegram's native forward first. If Telegram rejects it, the local file is uploaded, or the source is downloaded and uploaded when there is no local file. |
| `scanRoute` | `download` | What the live monitor and backfills do with a new message: `download` (download it; auto-forward runs after the download), `direct` (queue it for forwarding without downloading it) or `both` (queue the direct forward and download it too; the download does not forward it a second time). Needs `enabled`. |
| `deleteAfterForward` | `false` | Delete the local copy after every destination received the file. Only the local file is removed, never anything on Telegram. |

Each entry of `routes` has:

| Key | Meaning |
|---|---|
| `sourceTopicId` | Forum topic of the source chat, or `0` for all topics. A route for the message's own topic wins; an all-topics route still applies to destinations that topic route does not cover. One destination per source topic. |
| `destinationGroupId` | `me` (Saved Messages), `storage` (the "Telegram Downloader Storage" channel), a chat ID, `@username` or `t.me` link. A route without it is dropped. |
| `destinationTopicId` | Forum topic to post into, `0` for none. |
| `captionMode` | `inherit` (use the chat's caption settings) or one of the modes above, with the same `captionBase`, `caption`, `regexPattern` and `regexReplacement` keys. |

Any caption other than `source` normally needs an upload. With
`directForward` or a direct scan route, the message is forwarded natively
instead, without its caption (`none`) or with the caption edited afterwards
(`custom`); protected copies are always uploaded. Changing a rule affects
only jobs queued after the change.

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
| `TGDL_RESTART_ON_EXIT` | detected | `1` when a supervisor starts the server again after it exits with code 75 (needed for *Restart now and restore* after a whole-app restore); `0` turns the button off. Docker/Podman, systemd and PM2 are detected. |
| `TRUST_PROXY` | `loopback` when unset | Which proxies may set `X-Forwarded-*`: a hop count (`1`), a comma list of IPs, CIDRs or `loopback`, `linklocal`, `uniquelocal`, or empty to trust none. The Compose file sets `1`. |
| `TGDL_CSP` | on | `off` disables the Content-Security-Policy header (emergency use only). |
| `COMPRESSION_LEVEL` | `6` | gzip/deflate response compression level, 0–9. |
| `TGDL_METRICS_TOKEN` | unset | When set, `GET /metrics` requires `?token=<value>`. |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg used for thumbnails, seekbar previews and video operations. |
| `FFPROBE_PATH` | `ffprobe` beside `FFMPEG_PATH`, then on `PATH` | ffprobe used to read video durations for seekbar previews. |
| `FFMPEG_HWACCEL` | unset | Hardware video decoding for thumbnails and seekbar previews: `vaapi`, `qsv`, `cuda`, `videotoolbox`, `d3d11va` or `dxva2`. Overrides **Settings → Advanced**; a backend that fails on the host falls back to the CPU. |
| `TGDL_VAAPI_DEVICE` | ffmpeg's default render node | VA-API render node for `FFMPEG_HWACCEL=vaapi` seekbar sprites, e.g. `/dev/dri/renderD129` on a host with two GPUs. |
| `FASTSTART_CONCURRENCY` | `2` | Parallel MP4 faststart rewrites (max 8). |
| `TGDL_DOWNLOAD_THREADS` | `4` | Parts of one file fetched at the same time (1–16). An account that gets a `FLOOD_WAIT` during a file drops to half for its next files and climbs back by one after 8 files without one. `1` fetches one part at a time, as before 3.4.15. |
| `TGDL_HEVC_HVC1` | `1` | Renames the HEVC sample entry of new MP4 downloads from `hev1` to `hvc1` when the parameter sets are in the `hvcC` box, so Safari and every iOS browser can play them. Lossless: the file size and every sample stay the same. The hash of Telegram's original bytes is kept as `source_hash`, so duplicate detection and the NSFW blocklist still match copies saved before the change. `0` keeps Telegram's bytes unchanged. |
| `TGDL_VERIFY_CHUNKS` | `0` | `1` checks every part against Telegram's chunk hashes. It uses 128 KiB parts one at a time, so downloads are several times slower. |
| `WATCHTOWER_URL` | unset (`http://watchtower:8080` in Compose) | Enables **Install update** through the watchtower sidecar. |
| `WATCHTOWER_HTTP_API_TOKEN` | generated | Token shared with watchtower. When unset, it is generated once in `data/watchtower/api-token`. |
| `PUBLIC_URL` | unset | This instance's own address as seen by cluster peers. See [Cluster mode](CLUSTER.md). |
| `TZ` | host | Time zone for logs and schedules. |
| `GOMEMLIMIT` | unset | Go runtime soft memory limit, e.g. `1GiB`. Not a hard cap. |

Advanced update timings, rarely needed: `UPDATE_SNAPSHOT_TIMEOUT_MS`
(900000, 15 minutes, for the pre-update database snapshot), `UPDATE_BACKUP_KEEP` (5 pre-update snapshots), `UPDATE_STALL_AFTER_MS`
(600000) and `UPDATE_OVERLAY_STALL_MS` (120000).

`BACKUP_DROPBOX_CHUNK_BYTES` sets the Dropbox upload chunk size (4–148 MiB,
default 8 MiB); see [Backup](BACKUP.md).

### AI sidecars

Read by `tgdl-server` to reach the optional companion containers. An empty
value counts as unset. Details in [AI](AI.md).

| Variable | Meaning |
|---|---|
| `TGDL_NSFW_SIDECAR_URL` | URL of the `tgdl-nsfw` container, e.g. `http://tgdl-nsfw:8012`. Wins over `advanced.nsfw.sidecarUrl`. |
| `TGDL_NSFW_API_TOKEN` | Token sent to the NSFW sidecar; must equal its `TGDL_NSFW_API_TOKEN`. |
| `TGDL_NSFW_PATH_MAP` | `appPath=sidecarPath` rules when the sidecar mounts the downloads elsewhere. |
| `TGDL_FACES_SIDECAR_URL` | URL of the `tgdl-faces` container. Wins over the dashboard's External URL. |
| `FACES_SERVICE_URL` | Same, used only when neither `TGDL_FACES_SIDECAR_URL` nor a dashboard URL is set (the 2.x compose name). |
| `TGDL_FACES_SIDECAR_TOKEN` | Token sent to the faces sidecar; must equal its `TGDL_FACES_API_TOKEN`. |
| `TGDL_FACES_PATH_MAP` | Path rules for the faces sidecar, like `TGDL_NSFW_PATH_MAP`. |

Face tuning variables from 2.x are also honoured: `TGDL_FACES_MIN_DETECTION_SCORE`,
`TGDL_FACES_MIN_FACE_SIZE_PX`, `TGDL_FACES_FILE_TYPES`,
`TGDL_FACES_EXCLUDE_EXTENSIONS`, `TGDL_FACES_BATCH_SIZE`,
`TGDL_FACES_CPU_THROTTLE_RATIO`, `TGDL_FACES_SIDECAR_WAIT_MS`,
`TGDL_FACES_REQUEST_TIMEOUT_MS`, `TGDL_FACES_MAX_RETRIES`,
`TGDL_FACES_MAX_CONCURRENCY`, `TGDL_FACES_EPSILON`, `TGDL_FACES_MIN_POINTS`
and `TGDL_FACES_LABEL_MATCH_EPS`. Normally the dashboard settings are enough.

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
| `TZ`, `TGDL_DOWNLOADS_DIR`, `TRUST_PROXY`, `TGDL_SECURE_COOKIES`, `WATCHTOWER_URL`, `WATCHTOWER_HTTP_API_TOKEN`, `TGDL_NSFW_SIDECAR_URL`, `TGDL_NSFW_API_TOKEN` | see above | Passed to the server. |
| `WATCHTOWER_HTTP_API_PERIODIC_POLLS` | `false` | `true` lets watchtower update all containers on a schedule, not only on **Install update**. |
| `WATCHTOWER_SCHEDULE` | `0 0 4 * * *` | When to check, as a 6-field cron (seconds first) in the container's `TZ`; default daily at 04:00. |

To pass other server variables (`TGDL_CSP`, `COMPRESSION_LEVEL`,
`TGDL_METRICS_TOKEN`, `PUBLIC_URL`, `FFMPEG_HWACCEL`, `FACES_SERVICE_URL`, ...) add them to the `environment:` list of
the `telegram-downloader` service.

### Ignored since 3.0

`NODE_ENV`, `NODE_OPTIONS`, `TGDL_HEAP_MB`, `TGDL_GO_CORE`,
`TGDL_GO_FEATURES`, `TGDL_CORE_BIN`, `TGDL_CORE_RELEASE_URL`,
`TGDL_UID`, `TGDL_GID`, `SEEKBAR_SIDECAR_URL` and
`BACKUP_WORKERS_PER_DEST` have no effect on the 3.x server. Leaving them in
`.env` is harmless.

## Data folder

```text
data/
├── db.sqlite            # settings, catalog, jobs, sessions (WAL mode)
├── secret.key           # encrypts Telegram sessions: back it up
├── sessions/native/     # encrypted Telegram logins
├── downloads/<chat>/    # media (or TGDL_DOWNLOADS_DIR)
├── thumbs/              # generated thumbnails
├── photos/              # cached chat and profile photos
├── seekbar/             # video preview sprites (<id>.webp + <id>.json)
├── backups/             # database snapshots, incl. db-pre-update-*.sqlite
├── logs/              # 2.x log files (3.x logs to standard output)
└── watchtower/api-token # generated update token
```

Back up at least `db.sqlite`, `secret.key` and `sessions/`. Losing
`secret.key` makes the saved Telegram logins unreadable; you would have to
sign in again.
