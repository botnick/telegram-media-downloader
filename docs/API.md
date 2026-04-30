# REST API

Base URL: `http://localhost:3000` (or whatever you bound the dashboard to).

All API calls (except the public ones below) require the `tg_dl_session` cookie. Hit `POST /api/login` first to get one.

## Authorization model

The session cookie carries one of two roles:

- **`admin`** — full access.
- **`guest`** — opt-in read-only viewer. A default-deny chokepoint allowlists only the read endpoints listed below; every mutation route returns `403 {adminRequired:true}` for guest sessions.

A few `/api/auth/*` routes are explicitly registered before the global auth middleware and enforce their own checks (login / setup / change-password / reset / guest-password). The public `/share/<id>` route also bypasses dashboard auth — it is gated by HMAC signature + DB row check instead.

## Auth & setup

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/auth_check`            | **Public.** `{configured, enabled, authenticated, role, setupRequired, guestEnabled}`. |
| `POST` | `/api/auth/setup`            | **Public, localhost-only.** First-run password — `{password}`. |
| `POST` | `/api/login`                 | **Public.** `{password}` → sets cookie, returns `{success, role}`. Rate-limited 10/15min/IP. Server tries the admin hash first, then the guest hash. |
| `POST` | `/api/logout`                | Revokes the current session. |
| `POST` | `/api/auth/change-password`  | `{currentPassword, newPassword}`. Admin only. Rejects collisions with the guest password. |
| `POST` | `/api/auth/reset/request`    | **Public.** Prints a 10-min reset token to stdout. |
| `POST` | `/api/auth/reset/confirm`    | **Public.** `{token, newPassword}` — resets the **admin** password and revokes every active session. |
| `POST` | `/api/auth/guest-password`   | Admin only. `{password?, enabled?, clear?}` — manage the guest password. |

## Telegram accounts

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/accounts`                          | Saved sessions. |
| `POST`   | `/api/accounts/auth/begin`               | `{label?}` → `{sessionId, state:'phone'}`. |
| `POST`   | `/api/accounts/auth/phone`               | `{sessionId, phone}` → `{state:'code'\|'error'}`. |
| `POST`   | `/api/accounts/auth/code`                | `{sessionId, code}` → `{state:'password'\|'done'\|'error', accountId?}`. |
| `POST`   | `/api/accounts/auth/2fa`                 | `{sessionId, password}` → `{state:'done'\|'error', accountId?}`. |
| `POST`   | `/api/accounts/auth/cancel`              | `{sessionId}`. |
| `GET`    | `/api/accounts/auth/:sessionId`          | Status polling. |
| `DELETE` | `/api/accounts/:id`                      | Removes the saved session. |

## Monitor / engine

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/monitor/status` | `{state, queue, active, workers, accounts, stats, uptimeMs}`. Also broadcast over WS as `monitor_status_push` every 3 s when at least one client is connected. |
| `POST` | `/api/monitor/start`  | Loads `AccountManager`, starts realtime monitor in-process. |
| `POST` | `/api/monitor/stop`   | Cleans up watchers + the worker pool. |

## Stats / dialogs / groups

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/stats`                  | `{totalFiles, totalSize, diskUsage, telegramConnected,…}`. Also broadcast over WS as `stats_push` every 30 s. |
| `GET`  | `/api/dialogs`                | Active + archived chats; DMs gated by `config.allowDmDownloads`. |
| `GET`  | `/api/groups`                 | Configured groups with photo URLs. |
| `PUT`  | `/api/groups/:id`             | Update group config (filters, autoForward, topics, accounts). Auto-spawns a first-add backfill when the group is newly enabled and has no rows yet. |
| `DELETE` | `/api/groups/:id/purge`     | Drop files + DB rows + config + photo. |
| `GET`  | `/api/groups/:id/photo`       | Cached profile photo. |
| `POST` | `/api/groups/refresh-photos`  | Re-fetch profile photos for every configured group. |
| `POST` | `/api/groups/refresh-info`    | Re-resolve every monitored chat name from Telegram. |

## Downloads

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/downloads`                    | Aggregate per group. |
| `GET`    | `/api/downloads/all`                | Cross-group All-Media list, paginated. `?page=&limit=&type=`. |
| `GET`    | `/api/downloads/:groupId`           | Paginated rows for one group. `?type=images\|videos\|documents\|audio`. |
| `GET`    | `/api/downloads/search`             | `?q=…&page=&limit=&groupId=`. |
| `POST`   | `/api/downloads/bulk-delete`        | `{ids?, paths?}`. Also purges thumbnail cache for every removed id. |
| `DELETE` | `/api/file?path=…`                  | Single file. |
| `DELETE` | `/api/purge/all`                    | Factory reset. |

## Direct downloads

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/download/url`           | `{url}` or `{urls:[…]}` — t.me / tg:// URLs. Goes through the same `registerDownload` chokepoint (thumb + NSFW hooks fire). |
| `POST` | `/api/stories/user`           | `{username}` → list of active stories. |
| `POST` | `/api/stories/all`            | All visible stories grouped by peer. |
| `POST` | `/api/stories/download`       | `{username, storyIds:[…]}`. |
| `POST` | `/api/history`                | `{groupId, limit?, offsetId?, mode?}` → kicks off a backfill job. `mode` ∈ `pull-older` (default) / `catch-up` / `rescan`. Returns 409 with `code:'ALREADY_RUNNING'` if a job for the same group is in flight. |
| `GET`  | `/api/history/jobs`           | `{active:[…], recent:[…]}`. Recent retention configurable via `advanced.history.retentionDays`. |
| `GET`  | `/api/history/:jobId`         | One job. |
| `POST` | `/api/history/:jobId/cancel`  | Graceful cancel — partial results are kept. |
| `DELETE` | `/api/history/:jobId`       | Drop one finished entry. |
| `DELETE` | `/api/history`              | Clear every finished entry. |

## Thumbnails

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/thumbs/:id`           | `?w=120\|200\|240\|320\|480` — server-generated WebP. Image source → sharp; video source → ffmpeg first-frame. `Cache-Control: public, max-age=86400, immutable`. Allowed for guest sessions. |

## Share links

| Method | Path | Notes |
|---|---|---|
| `POST`   | `/api/share/links`            | Admin only. `{downloadId, ttlSeconds?, label?}` → `{url, expiresAt, id}`. `ttlSeconds: 0` = "never expires" sentinel. |
| `GET`    | `/api/share/links`            | Admin only. `?downloadId=` filters to one file (Share sheet); no filter = all (Maintenance sheet). |
| `DELETE` | `/api/share/links/:id`        | Admin only. Idempotent revoke. |
| `GET`    | `/share/:linkId`              | **Public, gated by HMAC + DB row.** `?exp=&sig=` → streams the file via the same `safeResolveDownload` path that `/files/*` uses (Range-request friendly). 401 on bad/expired/revoked. |

## Maintenance

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/maintenance/files/verify`  | Re-stat every cataloged download; prune rows whose file is missing on disk. |
| `POST` | `/api/maintenance/resync-dialogs`| Re-resolve every group's name + profile photo. |
| `POST` | `/api/maintenance/restart-monitor`| Stop + start the in-process monitor. |
| `POST` | `/api/maintenance/db/integrity`  | `PRAGMA integrity_check`. |
| `POST` | `/api/maintenance/db/vacuum`     | `VACUUM`. |
| `POST` | `/api/maintenance/dedup/scan`    | SHA-256 catch-up + groups duplicate sets. Single in-flight guard; broadcasts `dedup_progress` over WS. |
| `POST` | `/api/maintenance/dedup/delete`  | `{ids:[…]}` — delete from disk + DB + thumbs cache. |
| `POST` | `/api/maintenance/thumbs/build-all`| Generate default-width thumbs for every row that doesn't have one. Broadcasts `thumbs_progress`. |
| `POST` | `/api/maintenance/thumbs/rebuild`| Wipe cache; re-generation happens lazily on next access. |
| `GET`  | `/api/maintenance/thumbs/stats`  | `{count, bytes, ffmpegAvailable, allowedWidths}`. |
| `GET`  | `/api/maintenance/nsfw/status`   | `{enabled, running, scanned, total, candidates, keep, whitelisted, model, threshold, fileTypes}`. |
| `POST` | `/api/maintenance/nsfw/scan`     | Start a background scan (returns 503 when feature is disabled, 409 when one is already running). |
| `POST` | `/api/maintenance/nsfw/scan/cancel` | Abort the active scan; partial results kept. |
| `GET`  | `/api/maintenance/nsfw/results`  | Paginated low-score rows (deletion candidates). `?page=&limit=`. |
| `POST` | `/api/maintenance/nsfw/delete`   | `{ids:[…]}` — delete + purge thumbs. |
| `POST` | `/api/maintenance/nsfw/whitelist`| `{ids:[…]}` — mark as confirmed-18+; future scans skip. |
| `GET`  | `/api/maintenance/logs`          | List `data/logs/*.log` with size + mtime. |
| `GET`  | `/api/maintenance/logs/download` | `?name=&lines=` — tail of one logfile (50 MB cap). |
| `GET`  | `/api/maintenance/config/raw`    | Redacted `config.json`. |
| `POST` | `/api/maintenance/session/export`| Password-gated session-string export. |
| `POST` | `/api/maintenance/sessions/revoke-all` | Sign out every dashboard session. |

## Auto-update

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/update/status`             | Capability probe — `{available, inDocker, watchtowerConfigured, watchtowerUrl}`. |
| `POST` | `/api/update`                    | Admin only. Snapshots the SQLite DB to `data/backups/`, then signals the watchtower sidecar to pull + recreate. Returns 503 with `code:'AUTO_UPDATE_UNAVAILABLE'` when the sidecar isn't reachable. |

## Config & proxy

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/config`     | `apiHash` + `password` redacted; `apiHashSet` boolean replaces hash. |
| `POST` | `/api/config`     | Deep-merge updates; `advanced.*` namespaces are clamped per-field on save and re-applied at runtime via `config_updated`. |
| `POST` | `/api/proxy/test` | `{host, port}` → 5-s TCP probe. |

## File serving

| Method | Path | Notes |
|---|---|---|
| `GET` | `/files/<path>`     | Serves files under `data/downloads/`. Default `Content-Disposition: attachment`; pass `?inline=1` for inline media (used by the SPA viewer). Tolerates the legacy `data/downloads/` prefix. |
| `GET` | `/photos/<id>.jpg`  | Cached profile photos. |
| `GET` | `/share/<linkId>`   | Public share-link route — see Share links above. |

## WebSocket

`ws://<host>:3000` (or `wss://` behind TLS). Authenticates via the same session cookie at the upgrade handshake; the role (admin / guest) is stamped on the socket for future per-event filtering.

| Event type | Payload |
|---|---|
| `monitor_state`        | `{state, error?}` |
| `monitor_status_push`  | Full `/api/monitor/status` snapshot every 3 s. |
| `monitor_event`        | `{type, payload}` for download_start/_complete/_error, scale, queue_length, etc. |
| `download_progress`    | `{key, groupId, fileName, progress, received, total, bps}` |
| `download_complete`    | `{key, groupId, fileName, fileSize, deduped?}` |
| `stats_push`           | Full `/api/stats` snapshot every 30 s. |
| `file_deleted`         | `{path, id?}` |
| `bulk_delete`          | `{unlinked, dbDeleted, ids?}` |
| `group_purged`         | `{groupId}` |
| `purge_all`            | `{}` |
| `groups_refreshed`     | `{updates}` |
| `history_progress`     | `{jobId, processed, downloaded, group, mode}` |
| `history_done` / `history_cancelled` / `history_error` | as above |
| `history_deleted` / `history_cleared`   | Cross-tab Recent-backfills sync. |
| `history_stalled`      | `{pending, cap, stallSeconds}` |
| `dedup_progress`       | `{stage, processed, total, hashed, errored}` |
| `thumbs_progress`      | `{stage, processed, total, built, skipped, errored}` |
| `nsfw_progress`        | `{scanned, total, candidates, keep, running}` |
| `nsfw_done`            | `{scanned, candidates, keep, durationMs}` |
| `nsfw_model_downloading` | `{percent}` (first-run only) |
| `update_started`       | `{backup}` — fired right before watchtower kills the container. |
| `config_updated`       | `{}` |
| `sessions_revoked`     | `{}` |
