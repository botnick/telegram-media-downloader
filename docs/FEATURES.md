---
title: "Features"
description: "Everything Telegram Media Downloader 3.x does: monitor, backfill, auto-forward, dedup, disk rotation, backups, cluster, AI sidecars, and the remaining gaps."
nav_order: 5
has_children: true
---

# Features

Telegram Media Downloader signs in as **your own Telegram account** (MTProto,
through [gotd](https://gotd.dev/)), so it can save media from every channel,
group, forum topic and private chat that account can read. Everything runs on
your machine in one `tgdl-server` process with the dashboard built in; face
recognition and NSFW scoring use optional companion containers.

This page lists what the current 3.x release (3.4) does. Detailed guides:

| Guide | What it covers |
|---|---|
| [Backup](BACKUP.md) | Local, S3, SFTP, FTP/FTPS, Google Drive and Dropbox destinations, encrypted archives, offline restore |
| [Cluster mode](CLUSTER.md) | Pairing several instances into one library |
| [AI: faces, NSFW and previews](AI.md) | Seekbar previews, the `tgdl-nsfw` and `tgdl-faces` sidecars |
| [API reference](API.md) | HTTP and WebSocket endpoints of the dashboard |

## Downloading

- **Realtime monitor** for channels, supergroups, groups, forum topics and
  private chats. Turn it on per chat; it starts again after a restart if it was
  running before.
- **Self-healing monitor**: while monitoring is switched on, a monitor that
  stops on an error or a dropped connection restarts on its own (after 5 s,
  then 30 s, 1 min and every 5 min), and a watchdog checks every minute that
  it is still running. A channel whose missed updates are too old to replay
  is repaired in the background while the other chats keep downloading.
  Pressing **Stop** keeps it stopped.
- **Per-chat filters**: photos, videos, files, links, voice messages, GIFs and
  stickers; include or exclude specific senders; include or exclude forum
  topics.
- **History backfill**: pull older messages, catch up from the newest, or
  rescan, with a message limit (default 100, up to 50,000, or 0 for
  unlimited) and an optional date window (messages sent between two days).
  Jobs are saved in the database, survive restarts and can be
  cancelled. Backfill also works while the live monitor is off.
- **Telegram links**: paste `t.me/...` message links (channel, group, forum
  topic and private links) to download single messages.
- **Stories**: list and download a user's Stories by username.
- **Self-destructing (TTL) media** jumps to the front of the queue so it is
  saved before it expires; its timer is stored with the download.
- **Auto-forward** (per chat, **Forward to** in the chat's page): each newly
  downloaded file is re-uploaded to a destination, `me` (Saved Messages), a
  chat ID, `@username`, a `t.me` link or the "Telegram Downloader Storage"
  channel, with a caption linking the source post. A **Forward account** can
  be chosen per chat. Uploads go through the account's flood guard and never
  hold up downloads. A destination that refuses posts is paused and checked
  again after 1 h, 6 h and 24 h. **Delete after forward** removes only the
  local copy, never anything on Telegram.
- **Several accounts**: add more than one Telegram account and pin a chat to
  the account that should read it.
- **Proxies**: SOCKS5, SOCKS4, HTTP and MTProxy, used by sign-in, live updates
  and media downloads, with a built-in connection test.
- **Adaptive speed**: the number of files downloading at once starts at
  **Concurrent Downloads** (1–50) and, while the queue is long, grows by up to
  3 every `advanced.downloader.scalerIntervalSec` seconds (default 5) to
  `advanced.downloader.maxConcurrency` (default 20, at most 100). When the
  queue empties it shrinks toward `minConcurrency` (default 3). Set
  `maxConcurrency` equal to Concurrent Downloads for a fixed number. 1–20
  attempts per file and a shared bandwidth limit that applies immediately.
- **FloodWait protection**: every account's Telegram requests pass one flood
  gate and a request-rate limit. A wait of up to 60 s is slept through; a
  longer one pauses only that account's queue, reschedules the item without
  using up an attempt and drops the download concurrency to the minimum.
- **Durable queue**: downloads are written to a `.part` file and published
  atomically; queued work survives restarts. Pause, resume, retry or cancel any
  file, or the whole queue.
- **Rescue mode** (optional): keep new downloads for a retention window
  (48 hours by default) and keep for good only the ones whose source message
  was deleted on Telegram.

## Duplicates and storage

- **Skip duplicates before downloading** by Telegram media identity, then
  confirm by SHA-256 after transfer. A forwarded copy is stored once.
- **Duplicate finder**: scan the library and bulk-delete the extra copies.
- **Media facts** (MIME type, size in pixels, duration, forward origin) are
  recorded for every download.
- **Split-disk installs**: keep media on another disk with
  `TGDL_DOWNLOADS_DIR` (see [Configuration](CONFIGURATION.md)).
- **Purge** one chat's files, or reset everything, from the dashboard.

## Chats

- Chat list and profile photos load without starting the monitor.
- **Deleted, restricted and inaccessible chats** have their own tab with
  Telegram's reason and a *Check again* button.
- **Leave dead chats in bulk** from one confirmed account, either keeping the
  downloaded files or deleting them with their history and settings. Chats
  already gone on Telegram count as left and are removed from the app.

## Dashboard

- Library with thumbnails, search, type filters, pinning, bulk delete and bulk
  ZIP download.
- Full-screen viewer and video player; MP4 files are rewritten for instant
  streaming (faststart). Hover previews on the video scrub bar (seekbar
  sprites, built with ffmpeg in the server).
- Live queue with progress, speed and ETA.
- **Share links**: signed, expiring and revocable links that open without a
  login.
- Installable **PWA**, dark and light theme, **English and Thai**.
- Ctrl+K palette to jump to any page, setting or chat.

## AI (optional)

Details and setup: [AI: faces, NSFW and previews](AI.md).

- **Seekbar previews** built in the server, automatically after each video
  download (on by default) and from Maintenance → Seekbar.
- **NSFW scanning and review** through the `tgdl-nsfw` container
  (`TGDL_NSFW_SIDECAR_URL`): scan, auto-check of new downloads, review tiers,
  bulk delete and whitelist, hash blocklist.
- **Face recognition** through the `tgdl-faces` container
  (`FACES_SERVICE_URL` or `TGDL_FACES_SIDECAR_URL`): scan, background
  detection of new downloads, people clustering with names kept.
- **Hardware decoding** for thumbnails and previews with `FFMPEG_HWACCEL`
  (`vaapi`, `qsv`, `cuda`, …), falling back to the CPU.

## Backups and cluster

- [Backups](BACKUP.md) to a local disk, S3-compatible storage, SFTP, FTP/FTPS,
  Google Drive and Dropbox, as a continuous mirror or scheduled snapshots,
  optionally encrypted, with an offline restore command.
  `tgdl-server backup-oauth gdrive|dropbox` gets a refresh token on a headless
  server.
- [Cluster mode](CLUSTER.md): pair instances, browse and stream each other's
  files, peer thumbnails, and a cross-peer duplicate sweep with conflict
  resolution (Maintenance → Cluster).

## Maintenance

- **One-click update** (Docker): checks the database, saves a verified
  snapshot to `data/backups/`, then asks the bundled watchtower service to
  recreate the container. The dashboard shows when a newer release is out.
- **Automatic updates** (Docker): with `WATCHTOWER_HTTP_API_PERIODIC_POLLS=true`
  in `.env`, watchtower updates the whole stack on a schedule
  (`WATCHTOWER_SCHEDULE`, default daily 04:00). See [Deploy](DEPLOY.md#updating).
- Database integrity check, VACUUM and on-demand database snapshot.
- File verification, thumbnail rebuild, reindex, log viewer and download,
  and a recovery page for downloads that lost their chat or account.
- **Disk rotation**: with **Settings → Auto-rotate when full** on
  (`diskManagement.enabled`), every `diskManagement.sweepIntervalMin` minutes
  (default 10) the server compares the library size with `maxTotalSize` and,
  above it, **deletes the oldest downloads, files included,** until the
  library fits again, at most `advanced.diskRotator.maxDeletesPerSweep`
  (5000) per sweep. Pinned and rescued items, files still being downloaded and
  files outside the downloads folder are never deleted; a file shared by
  several downloads stays until its last one goes. The size is the sum of the
  catalog's file sizes, not free disk space. Status:
  `GET /api/maintenance/disk-rotator/status`. Leave it off unless you want
  old media to be removed.
- **Integrity sweep**: 30 s after start and then every
  `advanced.integrity.intervalMin` minutes (at least 60), rows whose file is
  missing or empty are dropped and wrong file sizes corrected. It never
  deletes files, and skips pruning when the downloads folder is unreadable or
  more than half of the library looks missing (an unmounted disk); Verify
  files still prunes on request.
- **Prometheus metrics** at `/metrics`: loaded accounts, active downloads,
  queue size, workers and process memory (`TGDL_METRICS_TOKEN` protects it).
- Sign out every browser at once.

## Security

- Fail-closed dashboard: nothing is reachable until a password is set.
- scrypt password hashing; `HttpOnly`, `SameSite=Strict` session cookies
  that are revoked on the server; login is limited to 10 attempts per
  15 minutes per client.
- Optional read-only **guest** password; changes are admin-only.
- Telegram sessions encrypted at rest with a key in `data/secret.key`.
- Content Security Policy, security headers and forwarded-header trust
  (`TRUST_PROXY`) applied by the server.

See [SECURITY.md](https://github.com/botnick/telegram-media-downloader/blob/main/SECURITY.md)
for how to report a vulnerability.

## Not in 3.x

These existed in 2.x or appear in old settings, but the 3.x Go server does not
do them. Saved settings are kept, so nothing is lost if they return.

- **Local face sidecar**: 2.x could download and start a `tgdl-faces` binary
  by itself. 3.x needs a running `tgdl-faces` container (or `python -m
  tgdl_faces`) and its URL. See [AI](AI.md#not-available-in-3x).
- **Built-in NSFW model**: NSFW scoring always needs the `tgdl-nsfw`
  container.
- **Face crops from WebP images and videos** show a blank tile.
- **Semantic search and auto-tags** (removed in 2.16).
- **Cluster**: LAN discovery, relay through a third peer, backup peer and
  failover, settings replication and the *direct* stream mode. See
  [Cluster mode](CLUSTER.md#limitations).
- **Backups**: in-dashboard restore (restore is offline with
  `tgdl-server backup-restore`). See [Backup](BACKUP.md#limits-and-whats-not-in-3x).
- **Live log viewer**: Maintenance → Logs only browses log files left by 2.x;
  3.x logs to standard output (`docker compose logs`).
- The `rateLimits` and `pollingInterval` settings are stored but have no
  effect.
