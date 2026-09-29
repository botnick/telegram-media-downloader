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
| `POST`   | `/api/accounts/auth/phone`               | `{sessionId, phone}` → `{state:'code'\|'phone'\|'error', error?, code?, seconds?}`. |
| `POST`   | `/api/accounts/auth/code`                | `{sessionId, code}` → `{state:'password'\|'done'\|'code'\|'error', accountId?, hint?}`. |
| `POST`   | `/api/accounts/auth/2fa`                 | `{sessionId, password}` → `{state:'done'\|'password'\|'error', accountId?}`. |
| `POST`   | `/api/accounts/auth/cancel`              | `{sessionId}`. |
| `GET`    | `/api/accounts/auth/:sessionId`          | Status polling. The first poll that sees `done` loads the new account into the running engine. |

A wrong phone number / code / password keeps the step's state and sets `error` plus `code` — the Telegram error name (`PHONE_NUMBER_INVALID`, `PHONE_CODE_INVALID`, `PHONE_CODE_EXPIRED`, `PASSWORD_HASH_INVALID`, …) or `FLOOD_WAIT` with `seconds`; submitting that step again retries. `hint` is the 2FA password hint. `begin` answers `503 {code:'NO_API_CREDS'}` until `telegram.apiId` / `apiHash` are set.
| `DELETE` | `/api/accounts/:id`                      | Removes the saved session. |

## Monitor / engine

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/monitor/status` | `{state, queue, active, workers, accounts, stats, uptimeMs, hint}`, plus `core: {state, fix}` only while tgdl-core (the app's Go engine) can't run — the dashboard shows it as a banner. Also broadcast over WS as `monitor_status_push` every 3 s when at least one client is connected. |
| `POST` | `/api/monitor/start`  | Loads `AccountManager`, starts realtime monitor in-process. |
| `POST` | `/api/monitor/stop`   | Cleans up watchers + the worker pool. |

## Stats / dialogs / groups

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/stats`                  | `{totalFiles, totalSize, diskUsage, telegramConnected, peerStats:[{peerId, peerName, online, totalFiles, totalSize, totalSizeFormatted}], …}`. Also broadcast over WS as `stats_push` every 30 s. `peerStats` is `[]` for non-cluster installs and for guest sessions. |
| `GET`  | `/api/dialogs`                | Active + archived chats; DMs gated by `config.allowDmDownloads`. Each row has `access` (see *Chat access* below). Fetching the lists also syncs access for free: a chat back in an account's list flips to `ok`; a configured chat listed as forbidden / migrated is recorded. |
| `GET`  | `/api/chats/lookup?q=`        | Resolve what the dashboard's Add box can't find by name: `@username`, `t.me/<name>`, `t.me/c/<id>`, invite links (`t.me/+…`, `joinchat/…`) and message links. → `{kind, chat?, invite?, message?}`; `chat` has `id, name, type, username, members, joined, inConfig, enabled, suspended, dmDisabled, access`. An invite this account isn't in returns an `invite` preview (`title, members, url`). 404 `not_found` / `invite_invalid`, 422 for t.me links that aren't chats, 503 `no_account`. |
| `GET`  | `/api/groups`                 | Configured groups with photo URLs. Each own row has `access` (see *Chat access* below) and, when its auto-forward destination refused our posts, `forwardAccess: {state, code, nextCheckAt}`. |
| `PUT`  | `/api/groups/:id`             | Update group config (filters, autoForward, topics, accounts, **cluster routing** — `ownerPeerId` / `backupPeerId`). Auto-spawns a first-add backfill when the group is newly enabled and has no rows yet. |
| `DELETE` | `/api/groups/:id/purge`     | Drop files + DB rows + config + photo. |
| `GET`  | `/api/groups/:id/photo`       | Cached profile photo. |
| `POST` | `/api/groups/refresh-photos`  | Re-fetch profile photos for every configured group. |
| `POST` | `/api/groups/refresh-info`    | Re-resolve every monitored chat name from Telegram. Chats that can't be reached are skipped (same for `refresh-photos`, `resync-dialogs` and `/api/groups/:id/photo`). |

### Chat access

Whether a chat can still be used, one standard answer everywhere. A chat that no loaded account can read is **paused** — polling, the update handler, the downloader (queued files are dropped, no retries), backfill, avatar / name lookups, Stories and auto-forwarding skip it with a local check, no Telegram call — until a re-check or a dialogs sync sees it readable again. Its config entry is left as it is (`enabled` stays the operator's choice); downloaded files are never touched and nothing is left or unsubscribed in Telegram.

`access` object (on `/api/groups`, `/api/dialogs` and `/api/chats/lookup` rows):

```json
{ "state": "private", "code": "CHANNEL_PRIVATE", "detail": null, "migratedTo": null,
  "firstSeenAt": 1790535647415, "checkedAt": 1790622047415, "nextCheckAt": 1790644432703,
  "checks": 1, "accounts": [{ "id": "123", "state": "private", "code": "CHANNEL_PRIVATE", "at": 1790622047415 }] }
```

- `state`: `ok` · `left` (no account is a member) · `banned` (kicked / banned) · `private` (private channel, access lost) · `deleted` (deactivated / doesn't exist) · `restricted` (restricted by Telegram — `detail` has Telegram's text) · `migrated` (a basic group upgraded to a supergroup — `migratedTo` is the new id) · `unknown` (couldn't tell: flood wait, timeout, no account connected — never pauses anything). A chat with nothing against it is just `{ "state": "ok" }`.
- `code` is Telegram's error (`CHANNEL_PRIVATE`, `CHANNEL_INVALID`, `USER_BANNED_IN_CHANNEL`, `CHANNEL_PUBLIC_GROUP_NA`, …) or the entity shape (`CHANNEL_FORBIDDEN`, `CHAT_MIGRATED`, …).
- `accounts`: each account's own answer. The chat is only paused when **no** account can read it; if one still can, it takes over (and is pinned) and the chat stays `ok` with the other account's failure listed. Empty for guest sessions.
- Re-checks: one chat per minute at most, after 1 h, 6 h, then daily (`nextCheckAt`), for monitored chats only; `migrated` is permanent and isn't re-checked. Adding an account makes every paused chat due.
- `legacy: true` marks an entry an older version switched off (`suspended` / `_resolveFailedAt` in the config); those flags are cleared once the chat is reachable again.

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/chats/access`                  | Configured chats that can't be reached → `{total, byState, items:[{id, name, type, enabled, access}]}`. `?countOnly=1` → `{total, byState}`. |
| `POST` | `/api/chats/access/recheck`          | "Check again". `{id}` → checked now (each account once, pinned first, stopping at the first that can read) → `{id, state, access, accountId, inconclusive, results}`; `inconclusive: true` means no account gave a definite answer (flood wait, timeout, none connected) and nothing changed. `{ids:[…]}` or `{all:true}` (every configured chat that can't be reached) → `{started, total}`, run in the background one chat every 2 s; progress on WS `chat_access_recheck_progress` / `chat_access_recheck_done`, status at `GET /api/chats/access/recheck/status`. 409 `ALREADY_RUNNING`. |
| `POST` | `/api/chats/access/stop`             | `{ids}` → `enabled:false` for each → `{stopped}`. |
| `POST` | `/api/chats/access/remove`           | `{ids}` → removes the config entries only → `{removed}`. Downloaded files and their gallery rows stay. |
| `POST` | `/api/chats/:id/follow-migration`    | A `migrated` chat: adds the new supergroup with the old entry's settings (media types, forwarding, topics, accounts, rescue, cluster routing) and switches the old one off → `{added, group, previous}`. 409 `NOT_MIGRATED` otherwise. |

All five are admin-only. `POST /api/history` for a chat that can't be reached answers `409 {code:'CHAT_UNREACHABLE', access}` before any Telegram call (auto-first and catch-up backfills are skipped); `POST /api/stories/*` does the same for a known chat, and `POST /api/download/url` reports `code: 'CHAT_UNREACHABLE'` per link. `GET /api/maintenance/recovery/list` includes paused chats with `resolveFailedReason: "access:<state>:<code>"` and `access`.

## Downloads

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/downloads`                    | Aggregate per group. |
| `GET`    | `/api/downloads/all`                | Cross-group All-Media list, paginated. `?page=&limit=&type=`. **`?include=local\|peers\|all`** (admin-only) UNIONs `peer_downloads` into the result; **`?peerId=<id>`** narrows to one peer. Each row carries `peer_id` (`'self'` or peer's id) + `peer_name`. Default `local` is backward-compatible. |
| `GET`    | `/api/downloads/:groupId`           | Paginated rows for one group. `?type=images\|videos\|documents\|audio`. Same `?include=` / `?peerId=` federation params as `/all`. |
| `GET`    | `/api/downloads/search`             | `?q=…&page=&limit=&groupId=`. Optional `type=` (`images` / `videos` / `documents` / `audio`), `pinned=1`, `pinnedFirst=1` (same as the gallery feeds) and `order=newest` (default: FTS relevance). File name / chat name prefix match, falling back to a substring match when that finds nothing. Same `?include=` federation param. |
| `POST`   | `/api/downloads/bulk-delete`        | `{ids?, paths?}`. Also purges thumbnail cache for every removed id. |
| `POST`   | `/api/downloads/pin`                | `{ids:[…], pinned}` — pin / unpin many rows in one request (max 5000 ids, else 413). Returns the ids that exist. |
| `POST`   | `/api/downloads/:id/pin`            | `{pinned}` — one row. |
| `DELETE` | `/api/file?path=…`                  | Single file. |
| `DELETE` | `/api/purge/all`                    | Factory reset. Body `{"confirm": "DELETE ALL"}` (exactly); without it `400 {code: "CONFIRM_REQUIRED"}` and nothing is touched. Starts a job: `{started: true}`, progress on `purge_all_progress` / `purge_all_done`. |

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
| `GET` | `/api/cluster/peer-thumbs/:remoteId`        | HMAC-only peer-to-peer thumb handler: the WebP bytes (`image/webp`, `?w=` like `/api/thumbs/:id`). Sibling of `/api/thumbs/:id` for federation. |
| `GET` | `/api/cluster/thumbs/:peerId/:remoteId`     | Cookie-authed browser proxy that signs a request to peer's `peer-thumbs` and streams the response. Returns a 1×1 placeholder PNG with `Cache-Control: public, max-age=60` when the peer is offline or answers something that isn't an image (older versions sent a JSON object here). |

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
| `POST` | `/api/maintenance/files/verify`  | Re-stat every cataloged download; prune rows whose file is missing on disk. `503 TGDL_CORE_UNAVAILABLE` (with the fix) while tgdl-core can't run. |
| `GET`  | `/api/maintenance/files/verify/status` | JobTracker snapshot — `{running, stage, progress, result}`. |
| `GET`  | `/api/maintenance/files/verify/stats`  | `{lastRun: {finishedAt, removed, scanned}}` — survives restart. |
| `POST` | `/api/maintenance/reindex`       | Walk `data/downloads/` and `INSERT OR IGNORE` rows for files the catalog doesn't have yet. `503 TGDL_CORE_UNAVAILABLE` while tgdl-core can't run. |
| `GET`  | `/api/maintenance/reindex/status`| JobTracker snapshot. |
| `GET`  | `/api/maintenance/reindex/stats` | `{lastRun: {finishedAt, added, scanned}}`. |
| `POST` | `/api/maintenance/resync-dialogs`| Re-resolve every group's name + profile photo. |
| `POST` | `/api/maintenance/restart-monitor`| Stop + start the in-process monitor. |
| `POST` | `/api/maintenance/db/integrity`  | `PRAGMA integrity_check`. |
| `POST` | `/api/maintenance/db/vacuum`     | `VACUUM`. |
| `POST` | `/api/maintenance/dedup/scan`    | SHA-256 catch-up + groups duplicate sets. Single in-flight guard; broadcasts `dedup_progress` over WS. `503 TGDL_CORE_UNAVAILABLE` while tgdl-core can't run. |
| `GET`  | `/api/maintenance/dedup/status`  | JobTracker snapshot — `{running, stage, processed, total, result}`. |
| `GET`  | `/api/maintenance/dedup/stats`   | `{totalFiles, hashed, missing, lastScan: {finishedAt, scanned, hashed, duplicateSets, extraCopies, reclaimableBytes}}`. Survives restart. |
| `POST` | `/api/maintenance/dedup/delete`  | `{ids:[…]}` — delete from disk + DB + thumbs cache. |
| `POST` | `/api/maintenance/thumbs/build-all`| Generate default-width thumbs for every row that doesn't have one. Broadcasts `thumbs_progress`. |
| `GET`  | `/api/maintenance/thumbs/build/status` | JobTracker snapshot. |
| `GET`  | `/api/maintenance/thumbs/build/stats`  | `{lastRun: {finishedAt, built, skipped, errored, scanned}}`. |
| `POST` | `/api/maintenance/thumbs/rebuild`| Wipe cache; re-generation happens lazily on next access. |
| `GET`  | `/api/maintenance/thumbs/stats`  | `{count, bytes, ffmpegAvailable, allowedWidths}`. |
| `POST` | `/api/maintenance/faststart/scan`| Sweep MP4s and rewrite ones whose moov atom isn't at the head. Broadcasts `faststart_progress`. |
| `GET`  | `/api/maintenance/faststart/status` | JobTracker snapshot. |
| `GET`  | `/api/maintenance/faststart/stats`  | `{total, optimized, pending, missing, unknown, ext_skip, ffmpegAvailable, lastRun}`. |
| `GET`  | `/api/maintenance/nsfw/status`   | `{enabled, running, scanned, total, candidates, keep, whitelisted, model, threshold, fileTypes}`. |
| `POST` | `/api/maintenance/nsfw/scan`     | Start a background scan (returns 503 when feature is disabled, 409 when one is already running). |
| `POST` | `/api/maintenance/nsfw/scan/cancel` | Abort the active scan; partial results kept. |
| `GET`  | `/api/maintenance/nsfw/results`  | Paginated low-score rows (deletion candidates). `?page=&limit=`. |
| `POST` | `/api/maintenance/nsfw/delete`   | `{ids:[…]}` — delete + purge thumbs. |
| `POST` | `/api/maintenance/nsfw/whitelist`| `{ids:[…]}` — mark as confirmed-18+; future scans skip. |
| `POST` | `/api/maintenance/nsfw/sidecar-test` | CORS proxy — test connection to an arbitrary NSFW sidecar URL. Body: `{url}`. Returns `{ok, version, model, ready}`. |
| `GET`  | `/api/maintenance/logs`          | List `data/logs/*.log` with size + mtime. |
| `GET`  | `/api/maintenance/logs/download` | `?name=&lines=` — tail of one logfile (50 MB cap). |
| `GET`  | `/api/maintenance/config/raw`    | Redacted runtime config (kv-backed). |
| `POST` | `/api/maintenance/session/export`| Password-gated session-string export. |
| `POST` | `/api/maintenance/sessions/revoke-all` | Sign out every dashboard session. |

## Seekbar previews (v2.17)

Opt-in feature — generates WebP sprite-sheet timeline thumbnails for video hover previews. Off by default; flip `config.advanced.seekbar.enabled` (Maintenance → Seekbar previews) to turn on. Backed by a standalone Go sidecar (`seekbar-service/`) that the dashboard auto-spawns on first use.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/seekbar/sprite/:id` | Serves the WebP (or JPEG fallback) sprite-sheet for the given `downloads.id`. Allowed for guest sessions. `Cache-Control: public, max-age=86400, immutable`. 404 when the sprite is still pregenerating or the feature is disabled. |
| `GET` | `/api/seekbar/meta/:id` | Returns the JSON sidecar (`{ cols, rows, frames, tile_w, tile_h, interval_sec, duration_sec, format, … }`). Guest-readable. Same 404 semantics. |
| `POST` | `/api/maintenance/seekbar/build-all` | Admin only. Starts the JobTracker backfill — paginates `downloads WHERE file_type='video' AND id NOT IN (SELECT download_id FROM seekbar_sprites)`. Broadcasts `seekbar_progress`. |
| `POST` | `/api/maintenance/seekbar/build/cancel` | Cancel the in-flight scan. |
| `GET`  | `/api/maintenance/seekbar/build/status` | JobTracker snapshot. |
| `GET`  | `/api/maintenance/seekbar/build/stats` | `{lastRun: {finishedAt, processed, generated, skipped, errored, durationMs}}`. Survives restart. |
| `POST` | `/api/maintenance/seekbar/rebuild` | Wipe every sprite + the table; broadcasts `seekbar_rebuild_progress`. |
| `GET`  | `/api/maintenance/seekbar/rebuild/status` | JobTracker snapshot. |
| `POST` | `/api/maintenance/seekbar/regen/:id` | Force-regenerate one row regardless of overwrite policy. |
| `GET`  | `/api/maintenance/seekbar/stats` | `{count, bytes, ffmpegAvailable, lastRun}`. |
| `GET`  | `/api/maintenance/seekbar/list` | Cursor-paginated row list. `?beforeId=&limit=`. |
| `GET`  | `/api/maintenance/seekbar/health` | `{sidecar:{ok, url, mode, version, pid?}, ffmpegAvailable}` — drives the page's status pill. |
| `GET`  | `/api/maintenance/seekbar/hwaccel-probe` | Proxies the sidecar's hardware probe — `{candidates[], available[], recommended}`. |
| `POST` | `/api/maintenance/seekbar/sidecar-test` | CORS proxy — test connection to an arbitrary seekbar sidecar URL. Body: `{url, token?}`. Returns `{ok, version}`. |
| `POST` | `/api/maintenance/seekbar/sidecar/restart` | Tear down + respawn the Go sidecar. Use after changing hwaccel / concurrency / port range. Broadcasts `seekbar_sidecar_status`. |

## AI / Face clustering (v2.16+)

Opt-in face detection + clustering, backed by the Python sidecar in `faces-service/`. Off by default; flip `config.advanced.ai.enabled` + `config.advanced.ai.faceClustering`. All endpoints are admin-only. See [docs/AI.md](AI.md) for the deep dive.

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/ai/status`                    | `{enabled, faceClustering, sidecar:{ok, url, mode, version, providers_resolved, det_size, …}, scan, peopleCount, facesCount}`. |
| `POST`   | `/api/ai/scan/start`                | `{feature:'faces'}` — kicks off Phase A (detect+embed) and Phase B (DBSCAN). Auto-flips `enabled=true` so a fresh install doesn't need a separate save round-trip. |
| `POST`   | `/api/ai/scan/cancel`               | Cancels the active scan; partial detections are kept. |
| `GET`    | `/api/ai/scan/status?feature=faces` | JobTracker snapshot for the re-mounted page. |
| `GET`    | `/api/ai/faces/provider-probe`      | Sidecar provider probe — `{candidates[], available[], details[], recommended, current}`. |
| `POST`   | `/api/ai/faces/health-test`         | CORS proxy — test connection to an arbitrary faces sidecar URL. Body: `{url}`. Returns `{ok, version, model, ready, providers}`. |
| `POST`   | `/api/ai/faces/restart`             | Restart the faces sidecar (after switching detector model / providers / det_size). Broadcasts `ai_faces_status`. |
| `POST`   | `/api/ai/faces/install-deps`        | Stream `python -m tgdl_faces.install` over `ai_faces_install_progress` / `ai_faces_install_done`. Accepts `{force?:'cpu'\|'gpu'\|'directml'\|'openvino', dryRun?:bool, noUninstall?:bool}`. |
| `POST`   | `/api/ai/faces/recluster`           | Re-run DBSCAN over the existing `faces` table without re-detecting (cheap; preserves labels via centroid match). `503 TGDL_CORE_UNAVAILABLE` while tgdl-core can't run. |
| `POST`   | `/api/ai/faces/reindex`             | Confirm-sheet gated — wipes every detection + cluster and re-scans every photo. Use after switching detector model. Broadcasts `ai_faces_reindexed`. |
| `POST`   | `/api/ai/preload-model/:name`       | Trigger background download of a face detection model. Proxies to sidecar `POST /preload/:name`. Returns `{model, status}`. `status` ∈ `not_downloaded`, `downloading`, `ready`, `error:…`. |
| `GET`    | `/api/ai/preload-model/:name/status`| Check model download status. Returns `{model, status}`. |
| `GET`    | `/api/ai/people`                    | Cluster list with cover-face + face count + `video_face_count` per person. `?page=&limit=`. |
| `GET`    | `/api/ai/people/:id/photos`         | Paginated photos in this cluster. |
| `PATCH`  | `/api/ai/people/:id`                | `{label}` — rename. |
| `DELETE` | `/api/ai/people/:id`                | Drop cluster; faces become unassigned. |
| `POST`   | `/api/ai/people/:id/merge`          | `{otherId}` — fold one cluster into another. |
| `POST`   | `/api/ai/people/:id/split`          | `{faceIds, newLabel?}` — create a new cluster from selected faces. |
| `POST`   | `/api/ai/faces/:id/reassign`        | `{personId}` — move a single face to another cluster. |
| `GET`    | `/api/ai/faces/by-download/:id`     | Face boxes for the gallery viewer overlay. |
| `GET`    | `/api/ai/group-by-person`           | Maintenance grid grouped by cluster — drives the People tab. |

### Faces sidecar (direct)

The dashboard proxies these via `/api/ai/preload-model/…` above, but the sidecar also exposes them on its own port (default `:7555`).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/preload/{model_name}`        | Download model files without switching the active model. Allowed models: `buffalo_l`, `antelopev2`, `buffalo_m`, `buffalo_s`, `buffalo_sc`. Returns `{model, status}`. |
| `GET`  | `/preload/{model_name}/status` | Check model download status. Returns `{model, status}`. `status` ∈ `not_downloaded`, `downloading`, `ready`, `error:…`. |

## Auto-update

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/update/status`             | Any signed-in session (guests too — the status bar's update sheet reads it); 401 without one. Capability probe — `{available, inDocker, watchtowerConfigured, watchtowerUrl, overlayStallMs}`. |
| `POST` | `/api/update`                    | Admin only. Runs a 5-step pipeline: ping watchtower (5 s HEAD) → live-DB `PRAGMA quick_check` → snapshot to `data/backups/db-pre-update-<UTC>.sqlite` → verify the snapshot is openable + clean (bad files are deleted) → POST watchtower's `/v1/update`. Returns 200 `{started:true}` on success or 4xx/5xx with a structured `code`: `AUTO_UPDATE_UNAVAILABLE`, `WATCHTOWER_UNREACHABLE`, `DB_CORRUPT`, `BACKUP_FAILED`, `BACKUP_VERIFY_FAILED`, `TRIGGER_FAILED`, or `ALREADY_RUNNING`. |
| `GET`  | `/api/update/history`            | Admin only. Last N (default 25, max 200) update attempts from the `update_history` table — `{from_version, to_version, started_at, finished_at, status, error_code, error_msg, backup_path, backup_bytes}`. `status` is `triggered` (in-flight, not yet finalised), `success` (new container booted on a different version), `failed` (pre-flight or trigger threw), or `stalled` (watchtower acked but the swap never landed within 10 min). |
| `GET`  | `/api/auto-update/status`        | Admin only. Live `JobTracker` snapshot for the in-flight `/api/update` run (running flag, stage, durations, last error). |

## Config & proxy

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/config`     | Admin only. Secrets are write-only: `web.password` / `web.passwordHash` are left out, and `telegram.apiHash`, `web.shareSecret`, `web.guestPasswordHash`, `proxy.password`, `advanced.nsfw.apiToken`, `advanced.seekbar.apiToken` and `advanced.ai.faces.sidecarToken` are replaced by a `<name>Set` boolean (`apiHashSet`, `shareSecretSet`, `guestPasswordHashSet`, `passwordSet`, `apiTokenSet`, `sidecarTokenSet`). |
| `POST` | `/api/config`     | Deep-merge updates; `advanced.*` namespaces are clamped per-field on save and re-applied at runtime via `config_updated`. A secret left out of the body keeps its saved value (send `proxy.password: null` to clear it); the `<name>Set` flags are ignored. |
| `POST` | `/api/proxy/test` | `{host, port}` → 5-s TCP probe. |

## File serving

| Method | Path | Notes |
|---|---|---|
| `GET` | `/files/<path>`     | Serves files under `data/downloads/`. Default `Content-Disposition: attachment`; pass `?inline=1` for inline media (used by the SPA viewer). Tolerates the legacy `data/downloads/` prefix. **`?peer=<id>`** (admin-only) routes through `streamFromPeer()` to fetch the file from a paired peer (proxy mode) or 302-redirects to a signed share URL (direct stream mode). Guest sessions are 403'd when `?peer` is present. |
| `GET` | `/photos/<id>.jpg`  | Cached profile photos. |
| `GET` | `/share/<linkId>`   | Public share-link route — see Share links above. |

## WebSocket

`ws://<host>:3000` (or `wss://` behind TLS). Authenticates via the same session cookie at the upgrade handshake; the role (admin / guest) is stamped on the socket for future per-event filtering.

| Event type | Payload |
|---|---|
| `monitor_state`        | `{state, error?}` |
| `monitor_status_push`  | Full `/api/monitor/status` snapshot every 3 s. |
| `download_progress`    | `{payload: {key, groupId, fileName, progress, received, total, bps}}` |
| `download_complete`    | `{payload: {key, groupId, fileName, fileSize, deduped?}}` |
| `download_start` / `download_error` / `queue_length` / `queue_changed` / `scale` / `rate_wait` / `flood_wait` / `forward_error` / `rescued` / `monitor_download` / `monitor_urls` / `monitor_error` / `monitor_started` | Engine events, like the two above: each goes out under its own type with the event's data in `payload` (`queue_length`: `{length}`, `download_error`: `{job, error}`, `rate_wait` / `flood_wait`: `{seconds}`). There is no `monitor_event` envelope (older docs listed one; it was never sent). |
| `stats_push`           | Full `/api/stats` snapshot every 30 s. |
| `file_deleted`         | `{path, id?}` |
| `bulk_delete`          | `{unlinked, dbDeleted, ids?}` |
| `group_purged`         | `{groupId}` |
| `purge_all`            | `{}` |
| `groups_refreshed`     | `{updates}` |
| `chat_access_changed`  | `{ids}` — chats whose access state changed (coalesced over 0.5 s); reload `/api/groups`. Forward-destination entries carry a `dest:` prefix. |
| `chat_access_recheck_progress` / `chat_access_recheck_done` | Job-tracker snapshots of a bulk "Check again" (`progress: {processed, total, reachable}`, `result: {total, reachable, results}`). |
| `history_progress`     | `{jobId, processed, downloaded, group, mode}` |
| `history_done` / `history_cancelled` / `history_error` | as above |
| `history_deleted` / `history_cleared`   | Cross-tab Recent-backfills sync. |
| `history_stalled`      | `{pending, cap, stallSeconds}` |
| `dedup_progress`       | `{stage, processed, total, hashed, errored}` |
| `thumbs_progress`      | `{stage, processed, total, built, skipped, errored}` |
| `nsfw_progress`        | `{scanned, total, candidates, keep, running}` |
| `nsfw_done`            | `{scanned, candidates, keep, durationMs}` |
| `nsfw_blocklist_deleted`| `{id, key}` — a file auto-deleted by the NSFW hash blocklist. `key` is the job key (`groupId:messageId:mediaType`) for queue UI matching. |
| `nsfw_model_downloading` | `{percent}` (first-run only) |
| `seekbar_progress`     | `{stage, processed, total, generated, skipped, errored}` — backfill scan. |
| `seekbar_done`         | `{processed, generated, skipped, errored, durationMs}`. |
| `seekbar_rebuild_progress` / `seekbar_rebuild_done` | Same shape as the build pair, fired by `/api/maintenance/seekbar/rebuild`. |
| `seekbar_sprite_ready` | `{download_id}` — fires after a per-row pregenerate succeeds (post-download hook or `/regen/:id`); the viewer's hover preview subscribes and flips from `pending` → `ready` in place. |
| `seekbar_sidecar_status` | `{ok, url?, mode?, version?, error?}` — emitted on sidecar boot / respawn / disable. |
| `seekbar_config_changed` | `{}` — broadcast after `POST /api/config` touches `advanced.seekbar.*`; the viewer drops its `enabled` cache and the maintenance page reloads its KPI strip. |
| `ai_faces_status`      | `{ok, url?, mode?, state?, error?}` — sidecar lifecycle (downloading / starting / ready / relaunching / disabled). |
| `ai_faces_install_progress` | `{state, line}` — line-by-line output of `POST /api/ai/faces/install-deps`. |
| `ai_faces_install_done` | `{ok, reason?, exitCode?}`. |
| `ai_faces_dim_change`  | `{from, to}` — broadcast once after the embedding-dim guard purges stale rows on model upgrade. |
| `ai_faces_reindexed`   | `{ts}` — fired after `/api/ai/faces/reindex` finishes. |
| `ai_reindex`           | `{processed, indexed, durationMs}` — fired by `/api/ai/reindex`. |
| `update_started`       | `{backup}` — fired right before watchtower kills the container. |
| `update_done`          | `{durationMs, kind:'autoUpdate', error?}` — `error` is set when the `/api/update` pipeline threw (pre-flight or trigger). The SPA's stall-overlay handler reads this to surface a toast + tear down the spinner. |
| `rescue_swept`         | (replaced by `file_deleted` in v2.8 — rescue sweeper now uses the canonical event so the gallery + footer drop the row in-place). |
| `rescue_sweep_done`    | `{count}` aggregate after every Rescue Mode sweep. |
| `config_updated`       | `{}` |
| `sessions_revoked`     | `{}` |
