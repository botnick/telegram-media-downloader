---
title: "Features"
description: "Everything Telegram Media Downloader 3.0 does: realtime monitor, history backfill, Stories, dedup, share links, backups, cluster, and what is not in 3.0 yet."
nav_order: 5
has_children: true
---

# Features

Telegram Media Downloader signs in as **your own Telegram account** (MTProto,
through [gotd](https://gotd.dev/)), so it can save media from every channel,
group, forum topic and private chat that account can read. Everything runs on
your machine in one `tgdl-server` process with the dashboard built in.

This page lists what 3.0 does today. Detailed guides:

| Guide | What it covers |
|---|---|
| [Backup](BACKUP.md) | Local, S3, SFTP and FTP/FTPS destinations, encrypted archives, offline restore |
| [Cluster mode](CLUSTER.md) | Pairing several instances into one library |
| [AI: faces, NSFW and previews](AI.md) | What remains of the AI tools in 3.0 |
| [API reference](API.md) | HTTP and WebSocket endpoints of the dashboard |

## Downloading

- **Realtime monitor** for channels, supergroups, groups, forum topics and
  private chats. Turn it on per chat; it starts again after a restart if it was
  running before.
- **Per-chat filters**: photos, videos, files, links, voice messages, GIFs and
  stickers; include or exclude specific senders; include or exclude forum
  topics.
- **History backfill**: pull older messages, catch up from the newest, or
  rescan, with a message limit (default 100, up to 50,000, or 0 for
  unlimited). Jobs are saved in the database, survive restarts and can be
  cancelled. Backfill also works while the live monitor is off.
- **Telegram links**: paste `t.me/...` message links (channel, group, forum
  topic and private links) to download single messages.
- **Stories**: list and download a user's Stories by username.
- **Several accounts**: add more than one Telegram account and pin a chat to
  the account that should read it.
- **Proxies**: SOCKS5, SOCKS4, HTTP and MTProxy, used by sign-in, live updates
  and media downloads, with a built-in connection test.
- **Speed and limits**: 1–50 parallel downloads, 1–20 attempts per file and a
  shared bandwidth limit that applies immediately.
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
  downloaded files or deleting them with their history and settings.

## Dashboard

- Library with thumbnails, search, type filters, pinning, bulk delete and bulk
  ZIP download.
- Full-screen viewer and video player; MP4 files are rewritten for instant
  streaming (faststart).
- Live queue with progress, speed and ETA.
- **Share links**: signed, expiring and revocable links that open without a
  login.
- Installable **PWA**, dark and light theme, **English and Thai**.
- Ctrl+K palette to jump to any page, setting or chat.

## Maintenance

- **One-click update** (Docker): checks the database, saves a verified
  snapshot to `data/backups/`, then asks the bundled watchtower service to
  recreate the container.
- Database integrity check, VACUUM and on-demand database snapshot.
- File verification, thumbnail rebuild, reindex, log viewer and download,
  and a recovery page for downloads that lost their chat or account.
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

## Not in 3.0

These existed in 2.x or appear in old settings, but the 3.0 Go server does not
run them. Saved settings are kept, so nothing is lost if they return.

- **Google Drive and Dropbox** backup destinations (local, S3, SFTP and
  FTP/FTPS work).
- **Hardware-accelerated thumbnails**: `FFMPEG_HWACCEL` is ignored and
  thumbnails are made on the CPU.
- **New AI results**: face detection and clustering, NSFW scoring and seekbar
  preview generation do not run. People and previews made by 2.x can still be
  viewed and edited. See [AI](AI.md).
- **Auto-forward**, **self-destructing (TTL) media capture**, **automatic disk
  rotation** and the **periodic integrity sweep**: their settings are stored
  but not acted on. File verification can still be run by hand from
  Maintenance.
