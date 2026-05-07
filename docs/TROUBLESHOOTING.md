# Troubleshooting

## First stop: `npm run doctor`

One-shot diagnostics — Node version + ABI, config load, `better-sqlite3` open + row count, `data/` writability, port availability (honours `PORT`), and `ffmpeg` on `PATH`. Cross-platform, non-interactive (safe to run inside CI / Docker / over SSH). Exits `1` on any blocking failure.

```bash
npm run doctor
```

If a check fails it prints what to do next. The most common hit is `SQLite (better-sqlite3): NODE_MODULE_VERSION ... was compiled against a different Node.js version` after a Node upgrade — `npm rebuild better-sqlite3` clears it.

## "Web dashboard not initialised — run `npm run auth`"

The dashboard fails closed when no password is configured. Either:

- Open `http://localhost:3000` from the same machine — the setup wizard lets you set the password from the browser, or
- Run `npm run auth` on the host, choose **Set / Change Password**, then reload the dashboard.

This was a deliberate change: earlier versions defaulted to **open access**, which exposed every download to anyone on the LAN.

## "503 — No Telegram accounts loaded" / `NO_API_CREDS`

You haven't entered the Telegram API credentials yet. Settings → Telegram API → paste `apiId` + `apiHash` from <https://my.telegram.org>, save, then add an account under **Telegram Accounts → Add account**.

## Settings → Groups is empty after an upgrade — but the media folders are still on disk

A failed JSON→SQLite migration (or any other write that wiped `kv['config'].groups`) leaves the dashboard with an empty Groups list while `data/downloads/<group>/…` and the SQLite `downloads` table still hold every file you ever pulled. **Don't re-add groups through the dialogs picker** — Telegram may return a slightly different display name than the folder was sanitised against, and the next download lands in `Group A (2)/` while the old `Group A/` sits orphaned.

Run the recovery script instead:

```bash
npm run recover                 # dry-run — print what would change
npm run recover -- --apply      # commit to kv['config'] (still disabled by default)
npm run recover -- --apply --enable   # commit AND flip enabled=true on every restored group

# Inside Docker:
docker exec <container> node scripts/recover_groups.js
docker exec <container> node scripts/recover_groups.js --apply
```

The script tries two sources in order:

1. **`data/config.json.migrated`** — the original config archived by the failed migration. Authoritative when present because it preserves filter settings, auto-forward destinations, monitor / forward account assignments, and forum-topic whitelists exactly as they were.
2. **`SELECT DISTINCT group_id, group_name FROM downloads`** — every chat that ever produced a file. Used when the archive is missing / empty / has no `groups[]`. Restored entries get default filters; re-enter auto-forward etc. through Settings → Groups afterwards.

Because the script restores the **exact `group_id` + `group_name`** the existing rows were stored under, `sanitizeName(group.name)` resolves to the same folder on the next download — no `Group A (2)` duplication. Restored groups land with `enabled: false` by default; flip them on individually in Settings → Groups (or use `--enable` to flip them all at once).

## Add-account wizard never advances past "Phone"

- Make sure the phone number includes the country code (`+66...` not `0...`).
- Telegram occasionally rate-limits new logins. Wait 5–15 minutes and retry — the wizard will surface a `FLOOD_WAIT_xxx` error if that's what's happening.
- Check `data/logs/network.log` (or set `TGDL_DEBUG=1` and watch stderr) for the actual gramJS error.

## "database is locked"

Two processes are writing to `data/db.sqlite` at once. SQLite WAL mode allows many readers + one writer. Either:

- Run only the in-process monitor (the dashboard's Engine card).
- Or run the headless `monitor` and use the dashboard for read-only browsing.

A future release will add IPC isolation so both can write simultaneously.

## "FloodWait" / Telegram rate-limits

The downloader pauses for the duration Telegram requests automatically. If they hit you frequently:

- Lower **Settings → Rate Limits → Requests/Minute** (15 is safe; 30+ is aggressive).
- Lower concurrent workers (1–3 is conservative).
- Don't restart the app to skip the wait — Telegram tracks the limit by account, not session.

## Missing files / errors after the upgrade to v2.0.0

- Old `config.web.password` (plaintext) is auto-rehashed on first successful web login. If you can no longer log in, run `npm run auth` to reset.
- Old AES session blobs (`v=1`) still decrypt — no manual migration needed.
- The web server now refuses to open its own TelegramClient when the CLI is already running. Stop one and run only the other if you see "database is locked" or duplicate-event symptoms.

## Files don't show up in the gallery after a successful download

- The DB record points at the canonical sanitised folder name. If you downloaded under v1 and then renamed the group, run `migrateFolders` (it runs automatically at monitor start) or just restart the dashboard.
- Hard-refresh the browser (Ctrl/Cmd+Shift+R) — the SPA caches the gallery.

## `Set-Cookie` not arriving / can't log in

Check that no reverse-proxy is stripping cookies and that the request is hitting the same origin the SPA is served from. If you're using HTTPS with `NODE_ENV=production`, the cookie has the `Secure` flag and won't be sent over plain HTTP.

## Path traversal blocked / 403 on `/files`

`/files/*` runs every request through `safeResolveDownload`: NUL bytes are rejected, paths are normalised, and `fs.realpath` resolves symlinks. If you see 403 on a file you expect to be there, check that the symlink target is still inside `data/downloads/`.

## I want more logs

Set `TGDL_DEBUG=1` (or `DEBUG=1`) in the environment. The noise classifier will then echo gramJS reconnect chatter to stderr in addition to writing it to `data/logs/network.log`.

## I want fewer logs

The noise classifier already drops the recoverable internals from stderr by default. If you're still seeing spam, file an issue with the redacted output and we'll add the pattern.

## Telegram banned my account

Use the official account-recovery flow at <https://telegram.org/support>. We can't help with that — the goal of the rate limits is to stay well under the threshold, but no client guarantees zero risk. If it happened during a long history backfill, lower the concurrency and the per-minute limit before retrying.

## Thumbnails don't render for video files

`/api/thumbs/<id>` needs `ffmpeg` on PATH for video first-frame extraction. The Docker image includes it via `apt-get install ffmpeg`. For standalone installs the optional `@ffmpeg-installer/ffmpeg` npm package ships static binaries for Win / macOS / glibc-Linux. Hosts without a system `ffmpeg` and without the npm shim fall through to "image-only" — Settings → Maintenance shows `ffmpeg unavailable — image-only` in that state. Override with the `FFMPEG_PATH` env var if needed.

## NSFW scan fails with "Failed to load @huggingface/transformers"

The model classifier is an optional feature. Run `npm install @huggingface/transformers` (or rebuild the Docker image; it's already a dependency in the published image). The first scan downloads ~80 MB of model weights to `data/models/` — make sure that path is writable and the host can reach `huggingface.co`.

## "Install update" button is greyed out

Two reasons: either the dashboard isn't running inside Docker (`/.dockerenv` heuristic), or the watchtower sidecar isn't reachable. Set `WATCHTOWER_HTTP_API_TOKEN` in `.env` and start with `docker compose --profile auto-update up -d`. The button hover-tip explains which check failed.

## Share link returns "Share link is not valid"

The body's `code` field tells you which gate failed:

- `bad_sig` — the signature didn't verify. Either the URL was tampered with, or `config.web.shareSecret` was rotated since the link was issued.
- `expired` — `expires_at` passed (skip this check by re-issuing with `ttlSeconds: 0`).
- `revoked` — admin pressed Revoke. Issue a new link from the Share sheet.

## Backfill returns 409 with `code: 'ALREADY_RUNNING'`

Per-group lock — only one backfill per group at a time. Either wait for the active job to finish, or cancel it from the Backfill page (Recent backfills → ✕). Auto-spawned backfills (first add, post-restart catch-up) appear with `mode: 'auto-first'` / `'catch-up'`.

## Auto-update finished but the version chip didn't bump

Hard-refresh the browser (Ctrl/Cmd+Shift+R) — the SPA cache may be holding the previous bundle. The status-bar reconnect logic auto-reloads the page when it detects a version change, but if reconnect happened during a brief WS disconnect the heuristic can miss the version flip.
