---
title: "Upgrading from 2.x"
description: "Upgrade Telegram Media Downloader 2.x to the 3.0 Go server in place: same image, port, data folder and logins. What changes, what is missing, how to roll back."
nav_order: 3
---

# Upgrading from 2.x to 3.0

3.0 replaces the Node.js backend with one native Go server, `tgdl-server`.
It reads the same data folder, so an existing install upgrades in place.

## TL;DR

| How you run it | Upgrade |
|---|---|
| Docker, with the bundled watchtower service | Dashboard → **Settings → Maintenance → Install update** |
| Docker, by hand | `docker compose pull && docker compose up -d` |
| From a git checkout (`./runner.sh`, `run_safe.bat`, `npm start`, PM2) | `git pull`, then restart the same way |

No settings have to change, and re-downloading `docker-compose.yml` is
optional.

## What carries over

- The image name `ghcr.io/botnick/telegram-media-downloader`, port `3000` and
  the `./data` folder.
- The container user `node` (uid 1000), so existing file ownership still fits.
- `.env`, the dashboard password, signed-in browsers and share links.
- Telegram logins: each saved 2.x (gramJS) login is converted once to
  `data/sessions/native/`. The original files are left in place.
- 2.x compose files keep working. Their `node scripts/healthcheck.js`
  healthcheck and Synology's `node src/web/server.js` command are mapped to
  the Go server, and the entrypoint still fixes data ownership and joins the
  `/dev/dri` group before dropping privileges.
- Split-disk installs: `TGDL_DOWNLOADS_DIR` is honoured for serving, backups,
  purge and reset.

Database migrations are idempotent and run before `/health` reports ready.

## What changes

- **No Node.js.** Nothing is installed with npm. Docker images (amd64 and
  arm64) and the release archives (Linux, Windows and macOS on amd64/arm64,
  plus Linux arm and 386) contain one executable with the dashboard embedded.
- **Launchers download the server.** `./runner.sh`, `run_safe.bat`,
  `npm start` and `pm2 start ecosystem.config.cjs` fetch the `tgdl-server`
  release that matches the checkout, verify it against the release
  `SHA256SUMS` and run it. No Go or Node toolchain is needed.
  `npm start` and PM2 still need the `node` command to run the small launcher
  script.
- **Old environment variables are ignored**: `NODE_ENV`, `NODE_OPTIONS`,
  `TGDL_HEAP_MB`, `TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `TGDL_CORE_BIN`,
  `TGDL_CORE_RELEASE_URL` and `FFMPEG_HWACCEL`. Leaving them in `.env` is
  harmless. The current list is in [Configuration](CONFIGURATION.md).

## Not in 3.0 yet

Check this list before you upgrade an install that relies on one of them:

- Google Drive and Dropbox backup destinations. Local, S3, SFTP and
  FTP/FTPS destinations work. See [Backup](BACKUP.md).
- Hardware-accelerated thumbnails. Thumbnails use the CPU.
- New face detection, NSFW scoring and seekbar previews. Results made by 2.x
  stay visible. See [AI](AI.md).
- Auto-forward, self-destructing media capture, automatic disk rotation and
  the periodic integrity sweep. Their settings are kept but not acted on.

The full list of what 3.0 does is on the [Features](FEATURES.md) page.

## Rolling back to 2.32.1

**Install update** saves a verified copy of the database to
`data/backups/db-pre-update-*.sqlite` before switching. A manual
`docker compose pull` does not, so take your own copy of `data/db.sqlite`
first if you upgrade that way.

1. Stop the stack: `docker compose down`.
2. Move the current `data/db.sqlite`, `data/db.sqlite-wal` and
   `data/db.sqlite-shm` aside, then copy the newest
   `data/backups/db-pre-update-*.sqlite` to `data/db.sqlite`.
3. Pin the image to `ghcr.io/botnick/telegram-media-downloader:2.32.1` in
   `docker-compose.yml` and start it again: `docker compose up -d`.

Without Docker, check out tag `v2.32.1`, restore the snapshot the same way and
start it as you did before.

2.x logins keep working because the original session files were left in
place. Accounts added and downloads recorded under 3.0 are not in the restored
database; their files stay on disk. Step-by-step commands are in
[Troubleshooting](TROUBLESHOOTING.md#going-back-to-2321).

## Cluster peers

Pairings made on 2.10 or later keep working; pairings from 2.9 or earlier
must be redone with a pairing code. Upgrade every peer to 3.0: a 3.0 peer
cannot list the files of a 2.x peer. Details are in
[Cluster mode](CLUSTER.md#upgrading-peers).
