---
title: "Troubleshooting"
description: "Fix common Telegram Media Downloader 3.0 problems: startup errors, dashboard sign-in and password reset, Telegram accounts, downloads, updates and Docker."
nav_order: 6
---

# Troubleshooting

Fixes for the problems people hit most often with Telegram Media Downloader
3.0, grouped by symptom. 3.0 is a single native `tgdl-server` process with
the dashboard built in. There is no Node.js, `npm` or gramJS any more, so
2.x tips such as `npm run doctor`, `npm run auth` or `npm rebuild` no longer
apply.

Before anything else, collect the basics:

```sh
# Docker
docker compose ps
docker compose logs --tail=200 telegram-downloader
docker compose exec telegram-downloader tgdl-server version
curl -s http://127.0.0.1:3000/health      # {"ok":true,"service":"tgdl-server"}

# Bare metal
./core-service/tgdl-server version
```

See [Getting help and logs](#getting-help-and-logs) for where the server
writes its output.

## Install & start

### The server exits with `TGDL_DATA_DIR is required`

The binary needs to know where its data folder is. The Docker image sets
`TGDL_DATA_DIR=/app/data`, and `./runner.sh`, `run_safe.bat` and
`watchdog.ps1` default it to the checkout's `data/` folder. If you start
`tgdl-server` directly (systemd, a script, a NAS task), set it yourself:

```sh
TGDL_DATA_DIR=/var/lib/telegram-media-downloader PORT=3000 ./tgdl-server
```

### Other startup errors

The server checks its settings before it opens the database and exits right
away when one is invalid:

| Message | Fix |
|---|---|
| `PORT: invalid port "..."` | `PORT` must be a number from 1 to 65535. In Docker, change the host side with `TGDL_PORT` in `.env`; the container always listens on 3000. |
| `TGDL_BIND_HOST must be a literal IPv4 or IPv6 address` | Use an IP address such as `127.0.0.1` or `0.0.0.0`, not a host name. Leave it unset to listen on all interfaces. |
| `TGDL_SESSION_TTL_DAYS: invalid value "..."` | Use a whole number of days from 1 to 3650. |
| `TRUST_PROXY must contain IP addresses, CIDRs, known network names or a hop count` | See [Reverse proxy](#reverse-proxy) for the accepted values. |
| `COMPRESSION_LEVEL must be 0-9` | Use a number from 0 to 9, or remove the line. |
| `listen tcp ...: bind: address already in use` | Another program (or a second copy of the downloader) already uses the port. Stop it or pick another port. |

### `another engine owns this data directory`

Two servers are pointed at the same data folder, for example a leftover
bare-metal process next to the Docker container, or two containers with the
same volume. Only one server may use a data folder at a time. Stop the extra
one and start the monitor again.

### The launcher can't download `tgdl-server` (bare metal, Windows)

After a `git pull`, `./runner.sh`, `run_safe.bat` / `watchdog.ps1` (and
`npm start` or PM2, which call the same launcher) download the release binary
that matches the checkout, check it against the release `SHA256SUMS` file and
install it into `core-service/`. Messages you may see:

- `Release X is not downloadable` or a network error: the host can't reach
  GitHub, or the release isn't published yet. If an older binary is present
  the launcher prints `Keeping the existing tgdl-server ...` and starts that
  one.
- `Checksum mismatch for ...; refusing to install.`: the download was
  corrupted or altered (often a proxy or captive portal). Nothing was
  installed. Retry on a clean connection.
- `Neither curl nor wget is installed` (Linux/macOS): install one of them.
- `Unsupported OS` / `Unsupported CPU`: there's no prebuilt binary for this
  platform; build it yourself.

To skip the download entirely, build or download the binary yourself and
point the launcher at it with `TGDL_SERVER_BIN`:

```sh
make build                     # needs Go 1.26; writes core-service/tgdl-server
TGDL_SERVER_BIN=/opt/tgdl/tgdl-server ./runner.sh
```

With `TGDL_SERVER_BIN` set, the launcher never downloads or replaces
anything. On Linux/macOS, `TGDL_RELEASE_BASE_URL` can point `runner.sh` at a
mirror that holds the same release archive and `SHA256SUMS`. More in
[Install and deploy](DEPLOY.md#from-a-git-checkout).

### Video thumbnails are missing or Maintenance says "ffmpeg unavailable — image-only"

Video thumbnails and faststart need `ffmpeg`. The Docker image includes it.
On bare metal install it (`apt install ffmpeg` or your platform's package),
or set `FFMPEG_PATH` to the executable. In 3.0 thumbnails are always made on
the CPU: `FFMPEG_HWACCEL` is ignored, and passing `/dev/dri` through won't
speed them up.

## Sign-in & dashboard

### "Web dashboard not initialised" / the setup page

No dashboard password has been set yet. For safety, the first password can
only be set from the machine the server runs on. With Docker, or behind a
reverse proxy, set it with the `setup` command beside the running server:

```sh
docker compose exec -T -u node telegram-downloader tgdl-server setup --password-stdin < /path/to/private-password-file
# Bare metal, on the same host as the running server:
PORT=3000 ./core-service/tgdl-server setup --password-stdin < /path/to/private-password-file
```

The file holds the password on one line (8 characters minimum). Delete it
afterwards. Errors from this command:

- `Cannot reach setup endpoint`: the server isn't running, or you ran the
  command on another machine or outside the container.
- `Initial setup requires a loopback listener`: `TGDL_BIND_HOST` is set to a
  specific non-loopback address. Temporarily use `TGDL_BIND_HOST=127.0.0.1`
  (or unset it) while setting the password.
- `Dashboard is already configured`: a password exists. Sign in, or see the
  next item if you forgot it.

A browser request that comes through a proxy is never treated as local, so
the setup form behind a reverse proxy answers with *Initial setup must be
done from the local machine*. Use the command above. Full steps:
[Deploy](DEPLOY.md#first-dashboard-password).

### I forgot the dashboard password

`tgdl-server setup` only sets the *first* password. To reset an existing
one, use the reset flow on the sign-in page:

1. On the sign-in page, click **Forgot password?** and then send the reset
   request.
2. The server prints a one-time token to its own output (not the browser):

   ```sh
   docker compose logs --since 15m telegram-downloader | grep 'Token:'
   ```

   On bare metal, look in the terminal, `journalctl -u <your unit>` or
   `pm2 logs`.
3. Paste the token and a new password (8 characters minimum) into the form
   and press **Reset and sign in**.

The token is valid for 10 minutes and works once. Resetting signs out every
other browser. Only someone who can read the server output can finish a
reset. If you're still signed in somewhere, use **Settings → Change
Password** instead.

### "Too many login attempts. Try again in 15 minutes."

Sign-in and password reset allow 10 attempts per client address in 15
minutes. Wait, or restart the server to clear the counter. If *everyone* gets
locked out at once behind a reverse proxy, the server is seeing the proxy's
address for every visitor: set `TRUST_PROXY` (see
[Reverse proxy](#reverse-proxy)).

### Signing in succeeds but you land back on the sign-in page

The browser isn't keeping the session cookie:

- `TGDL_SECURE_COOKIES=1` marks the cookie HTTPS-only. Use it only when you
  open the dashboard over `https://`. Over plain `http://` set it to `0`.
- When you use HTTPS, set `TGDL_SECURE_COOKIES=1` so the cookie can't leak
  over HTTP.
- Make sure the proxy doesn't strip `Set-Cookie` / `Cookie` headers and that
  the dashboard is served from a single origin (no mixing of
  `http://ip:3000` and `https://name`).

### Actions fail with "Cross-origin request blocked" (403)

Saves and other changes are refused when the browser's `Origin` doesn't match
the `Host` header the server receives. Behind a reverse proxy, forward the
original host (nginx: `proxy_set_header Host $host;`). Open the dashboard
through the same address the proxy publishes.

### The dashboard keeps redirecting to HTTPS, or says "HTTPS required"

**Force HTTPS** is on, but the server can't tell the request came in over
HTTPS. It only trusts `X-Forwarded-Proto` from a trusted proxy, so set
`TRUST_PROXY` correctly and make sure the proxy sends
`X-Forwarded-Proto: https`. Requests from the loopback address are exempt,
so on bare metal you can still reach the dashboard from the host itself to
turn the switch off.

### The dashboard shows an old version after an update

Hard-refresh the browser (Ctrl/Cmd+Shift+R). If an installed app (PWA) still
shows the old screens, close every dashboard tab and open it again.

## Telegram accounts

### "Telegram API credentials not configured" / `NO_API_CREDS` / "No Telegram accounts loaded"

Open **Settings → Telegram API**, paste the API ID and API hash from
<https://my.telegram.org>, press **Save Credentials**, then add an account
under **Settings → Telegram Accounts → Add account**. The monitor won't start
until at least one account is signed in.

### The add-account wizard fails

- Enter the phone number in international format (`+66…`, not `0…`).
- `FLOOD_WAIT` with a number of seconds: Telegram is rate-limiting sign-ins
  for that number. Wait at least that long before trying again; restarting the
  app doesn't help, because Telegram tracks the limit on its side.
- `PASSWORD_HASH_INVALID`: the two-step verification (cloud) password is
  wrong.
- Other `UPPER_CASE` codes (for example `PHONE_CODE_INVALID`,
  `PHONE_CODE_EXPIRED`) come straight from Telegram. Request a new code and
  try again.
- The wizard can't connect or times out: the host can't reach Telegram's
  servers. Check the firewall/DNS, or set a proxy under **Settings → Proxy**;
  Telegram connections use it.

### An account from 2.x won't connect after upgrading

On first start 3.0 converts each saved 2.x login once into
`data/sessions/native/`; the original files stay where they were. The
conversion needs `data/secret.key`, the same key 2.x used. Never delete or
replace that file. If the log shows `import Telegram session: ...` or
`load native Telegram session: ...`, the saved login can't be read (missing or
changed `secret.key`, or a damaged file). Remove the account in **Settings →
Telegram Accounts** and sign it in again; downloaded files and history stay.

An old single-account `data/session.enc` left next to accounts that were
already migrated is ignored, as in 2.x. You don't need to delete it.

### Telegram banned or limited my account

Use Telegram's own recovery at <https://telegram.org/support>; the downloader
can't lift a ban. Before you resume, reduce **Concurrent Downloads** and
avoid running many large history backfills at once.

## Downloads

### Downloads fail or keep retrying

A failed download, including one Telegram rate-limited, is retried
automatically after a growing pause, up to **Maximum Download Attempts**
(Settings, 1–20, counting the first try). After that it's marked failed.
Use **Retry all** on the **Queue** page once the cause is fixed.

If Telegram rate-limits you often (`FLOOD_WAIT` in the queue errors):

- Lower **Concurrent Downloads** (1–3 is conservative).
- Set a **Max Download Speed** limit; it applies to all downloads together
  and takes effect immediately.
- Don't restart to "skip" a wait: Telegram tracks it per account.

### A file isn't downloaded again

3.0 skips media it already has, first by Telegram's media identity before
downloading, then by SHA-256 after the transfer. A re-post of a file you
already have is recorded as a duplicate instead of saved twice.

### A chat stopped downloading and appears under "Deleted / unavailable"

The **Chats** page keeps deleted, restricted and inaccessible chats in their
own **Deleted / unavailable** tab, with Telegram's reason. Monitoring,
backfill and forwarding pause for those chats; downloaded files are kept.

- **Check again** refreshes the chat's status from Telegram. If you rejoined
  the chat with one of your accounts, this brings it back.
- **Leave / remove from Telegram** leaves the chat using the account you
  confirm. "No account is confirmed for this chat" means you have to press
  **Check again** first.
- To clean up many chats, use **Select** / **Select all** and leave them
  from one confirmed account, either keeping the downloaded files or deleting
  their files, history and settings (you type the count to confirm). Chats
  are removed one at a time, and the batch stops if Telegram asks you to
  wait; run it again later. Chats that still work are never removed in bulk.

### Files are on another disk (`TGDL_DOWNLOADS_DIR`) but don't show up

In Docker the path has to exist *inside the container*: mount the disk in
`docker-compose.yml` at the same path you put in `TGDL_DOWNLOADS_DIR` (the
compose file has a commented example). Thumbnails and the database stay in
the data folder.

### Faces, NSFW scores or hover previews don't appear for new files

3.0 shows the results 2.x produced but doesn't create new ones. See
[AI troubleshooting](AI.md#troubleshooting).

### A share link says "Share link is not valid"

The `code` in the response tells you why: `expired` (past its expiry date),
`revoked` (someone revoked it), `not_found` (the link or its file was
deleted) or `bad_sig` (the URL was altered). Create a new link from the
Share sheet.

## Updates & upgrading from 2.x

For the full upgrade procedure see [Upgrading](UPGRADING.md). Common snags:

### "Install update" is greyed out or unavailable

One-click updates need all of the following:

- the app running in Docker;
- `WATCHTOWER_URL` set (the bundled compose file sets
  `http://watchtower:8080`);
- the `watchtower` service from the bundled compose file running, with
  `./data/watchtower` mounted.

Compose files from older 2.x releases may lack the sidecar or the variable.
Download the current `docker-compose.yml` (keep your own volume paths and
`.env`), then run `docker compose up -d`. Manual updates always work:
`docker compose pull && docker compose up -d`.

### The update fails with an error code

**Maintenance → Updates** lists every attempt with its `error_code`:

| Code | Meaning and fix |
|---|---|
| `AUTO_UPDATE_UNAVAILABLE` | The sidecar isn't configured. See the previous item. |
| `WATCHTOWER_UNREACHABLE` | The app couldn't reach the sidecar: it's stopped, on another network, or `WATCHTOWER_URL` is wrong. Run `docker compose up -d` and check `docker compose logs watchtower`. |
| `WATCHTOWER_UNAUTHENTICATED` | The sidecar rejected the token. If `.env` sets `WATCHTOWER_HTTP_API_TOKEN`, both services must get the same value; otherwise both read the token generated in `data/watchtower/api-token`. Fix it, then `docker compose up -d --force-recreate watchtower`. |
| `DB_CORRUPT` | The database integrity check failed, so no snapshot was taken. Run **Maintenance → DB integrity** and recover before retrying. |
| `BACKUP_FAILED` / `BACKUP_VERIFY_FAILED` | The pre-update snapshot in `data/backups/` couldn't be written or verified. Check free disk space and disk health. On a very large database you can raise `UPDATE_SNAPSHOT_TIMEOUT_MS` (default 60000). |
| `TRIGGER_FAILED` | The sidecar refused the update request; the snapshot was kept. See `docker compose logs watchtower`. |
| `STALL_TIMEOUT` | The update never reported back (default 10 minutes). Check `docker compose ps` and the logs; a manual `docker compose pull && docker compose up -d` finishes it. |

If the "Update appears stalled" overlay shows up on a slow disk while the
update is still running, raise `UPDATE_OVERLAY_STALL_MS` (default 120000) on
the app service.

### The container exits with "node: not available"

3.0 has no Node runtime. A small `node` shim is kept only so the 2.x
healthcheck (`node scripts/healthcheck.js`) and start command
(`node src/web/server.js`, used by the Synology compose file) keep working.
Any other `node ...` command in a custom `command:`, `entrypoint:` or
healthcheck fails with this message. Remove the override or switch to the
current compose file.

### 2.x commands and settings that no longer exist

- `npm run doctor`, `npm run auth`, `npm run recover` and the other npm
  scripts are gone. Use the checks at the top of this page,
  `tgdl-server setup` for the first password, and the reset flow for a
  forgotten one.
- `NODE_ENV`, `NODE_OPTIONS`, `TGDL_HEAP_MB`, `TGDL_GO_CORE`,
  `TGDL_GO_FEATURES`, `TGDL_CORE_BIN`, `TGDL_CORE_RELEASE_URL` and
  `FFMPEG_HWACCEL` are ignored; leaving them in `.env` does no harm. See
  [Configuration](CONFIGURATION.md) for the current list.
- Google Drive and Dropbox backup destinations aren't available in 3.0 yet.
  Use local, S3, SFTP or FTP/FTPS destinations ([Backup](BACKUP.md)).

### Going back to 2.32.1

If 3.0 doesn't work for you, roll back with the database snapshot taken right
before the update. The dashboard's **Install update** saves it as
`data/backups/db-pre-update-<date>-<time>.sqlite`. A manual
`docker compose pull` doesn't make one; use your own backup in that case.

```sh
docker compose down
ls data/backups/db-pre-update-*.sqlite         # pick the one from before 3.0
mkdir -p data/3.0-db
mv data/db.sqlite data/db.sqlite-wal data/db.sqlite-shm data/3.0-db/ 2>/dev/null
cp data/backups/db-pre-update-YYYYMMDD-HHMMSS.sqlite data/db.sqlite
# In docker-compose.yml set: image: ghcr.io/botnick/telegram-media-downloader:2.32.1
docker compose up -d
```

2.x logins still work because the original session files were left in place.
Accounts added under 3.0, and downloads recorded after the snapshot, aren't
in the restored database. Their files stay on disk. On bare metal, check out
`v2.32.1` and start it the way that release's README describes.

## Docker / NAS

### "Permission denied" on `/app/data`

The container starts as root only long enough to create the data folders and
give them to the `node` user (uid 1000, as in 2.x), then runs as that user.
Ownership isn't fixed when:

- `FAST_BOOT=1` is set (it skips that step), or
- the container is started as a non-root user (`user:` in compose, or a NAS
  UI setting).

Fix the folder once from the host, then restart:

```sh
sudo chown -R 1000:1000 ./data
docker compose up -d
```

On a NAS, give uid 1000 read/write access to the shared folder. For a split
download disk, the folder in `TGDL_DOWNLOADS_DIR` needs the same access.

### Compose fails with an error about `/dev/dri`

`docker-compose.synology.yml` passes the iGPU (`/dev/dri`) through. A host
without that device can't start the container. 3.0 doesn't need the GPU,
since thumbnails use the CPU, so delete the `devices:` block. When the device
is present, the entrypoint adds the `node` user to its group by itself
(`ENTRYPOINT_DEBUG_GPU=1` prints what it did).

### The container restarts by itself or is killed for memory

The bundled `autoheal` service restarts the container when `/health` stops
answering. Check `docker compose logs telegram-downloader` for the reason.
If the logs end abruptly or `docker inspect telegram-downloader` reports
`OOMKilled`, raise `TGDL_MEM_LIMIT` in `.env` (default `8g`, `2g` in the
Synology file).

### The NAS UI shows the container as "unhealthy"

The healthcheck calls `http://127.0.0.1:3000/health` inside the container.
The server answers once database migrations finish, which can take longer
than usual on the first 3.0 start with a large library. If it stays
unhealthy, read the logs for a startup error ([Install & start](#install--start)).

## Reverse proxy

### Live updates don't work / the dashboard says it's disconnected

The dashboard uses WebSockets on the same port. Forward the `Upgrade` and
`Connection` headers (nginx: `proxy_http_version 1.1;`,
`proxy_set_header Upgrade $http_upgrade;`,
`proxy_set_header Connection "upgrade";`) and preserve `Host`.

### `TRUST_PROXY` values

`TRUST_PROXY` decides whose `X-Forwarded-For` / `X-Forwarded-Proto` headers
the server believes. This affects rate limits, the HTTPS detection used by
Force HTTPS, and the "local machine" check.

| Value | Meaning |
|---|---|
| unset (bare metal default) | Trust proxies on loopback (`127.0.0.0/8`, `::1`) only. |
| `1` (compose default) | Trust one proxy hop, whatever its address. |
| empty (`TRUST_PROXY=`) | Trust no proxy. Use this when the dashboard is exposed directly with no proxy, so clients can't fake their address. |
| `loopback`, `linklocal`, `uniquelocal`, IP addresses or CIDRs (comma-separated) | Trust proxies from those networks. |
| a number from 0 to 256 | Trust that many proxy hops. |

A proxy on another machine in front of a bare-metal install needs `1` or the
proxy's address; the loopback default ignores it. Set
`TGDL_SECURE_COOKIES=1` when the proxy serves HTTPS. See also
[Deploy](DEPLOY.md#reverse-proxy-and-https).

## Cluster

For pairing, sync and peer problems see [Cluster](CLUSTER.md). A clock
difference of more than 60 seconds between peers makes signed requests fail,
so keep the system clocks synced (NTP).

## Getting help and logs

- **Where the logs are:** 3.0 writes its log to standard output.
  - Docker: `docker compose logs -f telegram-downloader` (add `--tail=500`
    or `--since 1h` to narrow it down).
  - systemd: `journalctl -u <your unit>`.
  - PM2: `pm2 logs`.
  - Started by hand: the terminal.

  `data/logs/` contains only log files left over from 2.x. **Maintenance →
  Logs** can still browse those files, but the live log viewer stays empty in
  3.0. Use the commands above instead.
- **No debug switch:** `TGDL_DEBUG` and `DEBUG` from 2.x have no effect.
- **Version:** `tgdl-server version` prints the version, OS/CPU and Go
  version.
- **Reporting a bug:** open an issue at
  <https://github.com/botnick/telegram-media-downloader/issues> with the
  version, how you run it (Docker, NAS, bare metal), what you did, and the
  relevant log lines. Remove API hashes, tokens, reset tokens, phone numbers
  and share links before posting.

Related pages: [Deploy](DEPLOY.md), [Configuration](CONFIGURATION.md),
[Upgrading](UPGRADING.md), [Backup](BACKUP.md), [Architecture](ARCHITECTURE.md),
[REST API](API.md).
