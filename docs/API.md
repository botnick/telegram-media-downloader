---
title: "API reference"
description: "HTTP and WebSocket reference for tgdl-server 3.0: dashboard login, roles, downloads, queue, backups, cluster, share links, /health and /metrics."
parent: Features
nav_order: 4
---

# API reference

This page lists every HTTP route and WebSocket event served by `tgdl-server`, the single Go binary that runs the dashboard in 3.0. The dashboard itself uses these routes, so anything it can do you can script.

Base URL: `http://<host>:3000` (`PORT` changes the port, `TGDL_BIND_HOST` the listen address). Requests and responses are JSON unless a row says otherwise.

The routes are internal to the dashboard rather than a versioned public contract: names and payloads follow the dashboard and can change between releases. Request bodies are only described where they are short and stable. For anything else, watch what the dashboard sends in your browser's network tab.

## Authentication and access

### Session cookie

- `POST /api/login` with `{"password": "..."}` sets the **`tg_dl_session`** cookie (`HttpOnly`, `SameSite=Strict`, path `/`; `Secure` only when `TGDL_SECURE_COOKIES=1`). Send that cookie on every later request.
- The password decides the role: the admin password gives **`admin`**, the optional guest password gives **`guest`**.
- Sessions are stored server-side. They last 7 days by default (`TGDL_SESSION_TTL_DAYS`, or the dashboard's session-length setting, 1–365 days) and are renewed as they are used. Logging out, changing a password, turning guest access off or *Revoke all sessions* deletes them on the server and closes their WebSockets.
- Until a dashboard password exists (or while the dashboard is disabled), `/api/*`, `/v1/*` and WebSocket requests get `503 {"setupRequired": true}` and pages redirect to `/setup-needed.html`. Set the first password with `tgdl-server setup --password-stdin` (see [Deploy](DEPLOY.md)).

### Access levels used in the tables

| Level | Meaning |
|---|---|
| **Public** | No cookie needed. |
| **Guest** | Any signed-in session, admin or guest. |
| **Admin** | Admin session only. A guest gets `403 {"error":"Admin only","adminRequired":true}`. |
| **Peer** | Called by another tgdl-server in your cluster and checked with that peer's signature, not a cookie. |

Without a valid session, API calls get `401 {"error":"Unauthorized"}` and pages redirect to `/login.html`.

Guest sessions are **read-only and allowlisted**. Before any route runs, a guest may only make `GET` requests under `/api/auth_check`, `/api/version`, `/api/downloads`, `/api/groups`, `/api/stats`, `/api/thumbs`, `/api/seekbar/sprite`, `/api/seekbar/meta`, `/api/monitor/status` and `/api/files/token`, plus `POST /api/logout`. Guests may also open `/files/…`, `/photos/…` and the WebSocket. Every other API call is admin-only for guests, including some routes whose handler only asks for "a session", such as `/api/config`, `/api/jobs`, `/api/dialogs`, `/api/ai/*` and `/api/update/status`. The tables below mark those as **Admin**.

### Rate limits

| Routes | Limit (per client IP) |
|---|---|
| `POST /api/login`, `/api/auth/change-password`, `/api/auth/reset/request`, `/api/auth/reset/confirm` (they share one bucket) | 10 per 15 minutes |
| `POST /api/auth/setup` | 20 per 15 minutes |
| `GET /share/…` | 60 per minute by default (adjustable in the share settings) |

Limited responses carry `RateLimit` and `RateLimit-Policy` headers. Over the limit, the server answers `429` with `Retry-After`. The client IP is only taken from `X-Forwarded-For`/`Forwarded` when `TRUST_PROXY` says the proxy is trusted. See [Deploy](DEPLOY.md) for reverse-proxy setup.

### Cross-origin protection

There is no CSRF token. Instead, every `POST`, `PUT`, `PATCH` and `DELETE` that carries an `Origin` (or, failing that, `Referer`) header must come from the same host as the request, with `localhost`, `127.0.0.1` and `::1` on the same port counted as one host. A mismatch gets `403 "Cross-origin request blocked"`. Requests with neither header, such as `curl` or scripts, are allowed and depend on the cookie alone, which `SameSite=Strict` keeps out of other sites.

When *Force HTTPS* is on, plain-HTTP requests from anything but loopback are redirected with `308` (`GET`/`HEAD`) or refused with `403 "HTTPS required"`. Security headers (CSP, frame options, HSTS when forced) are added to every response. `TGDL_CSP=off` drops the CSP header.

### Scripting example

```bash
curl -c jar -H 'Content-Type: application/json' \
     -d '{"password":"your-dashboard-password"}' http://localhost:3000/api/login
curl -b jar http://localhost:3000/api/stats
```

## Health, metrics and version

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/health` | Public | Liveness only: always `200 {"ok":true,"service":"tgdl-server"}` while the process is serving HTTP. It does not check Telegram, the database or disk. Used by the Docker `HEALTHCHECK`. |
| `GET` | `/metrics` | Public, or token | Prometheus text format. If `TGDL_METRICS_TOKEN` is set, the request must include `?token=<value>`, otherwise it gets `401`. Exposes `tgdl_accounts_loaded`, `tgdl_active_downloads`, `tgdl_queue_size`, `tgdl_workers`, `process_resident_memory_bytes`, `process_heap_bytes` and `process_uptime_seconds`. In 3.0.0 the four `tgdl_*` gauges always report `0`, so only the `process_*` values are useful. |
| `GET` | `/api/version` | Public | `{version, commit, builtAt}`. Supports `If-None-Match`. |
| `GET` | `/api/version/check` | Public | Kept for older clients. In 3.0 it never contacts GitHub and always returns `latest: null`, `updateAvailable: false`. |
| `GET` | `/api/system/health` | Admin | Detailed runtime and system health for the Maintenance page. |

## Auth

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/auth_check` | Public | `{configured, enabled, authenticated, role, setupRequired, guestEnabled}`. |
| `POST` | `/api/login` | Public | `{password}` → sets the cookie and returns `{success, role}`. Wrong password: `401`. |
| `POST` | `/api/logout` | Public | Revokes the current session (if any), closes its WebSockets and clears the cookie. |
| `POST` | `/api/auth/setup` | Public, loopback only | First password, `{password}` (at least 8 characters). Refused through a proxy (`Forwarded`/`X-Forwarded-For` present) or from a non-loopback address. `409` once a password exists. |
| `POST` | `/api/auth/change-password` | Admin | `{currentPassword, newPassword}`. Must differ from the guest password. Issues a fresh session. |
| `POST` | `/api/auth/guest-password` | Admin | Exactly one of `{password}`, `{enabled}` or `{clear: true}`. Changing or disabling guest access revokes guest sessions. |
| `POST` | `/api/auth/reset/request` | Public | Prints a single-use reset token, valid 10 minutes, to the **server log/stdout**. Nothing is returned to the caller. |
| `POST` | `/api/auth/reset/confirm` | Public | Uses that token to set a new admin password. |
| `POST` | `/api/maintenance/sessions/revoke-all` | Admin | Signs out every dashboard session. |
| `POST` | `/api/maintenance/session/export` | Admin | Export one account's saved Telegram session. Requires `{confirm: true, password, accountId}` and re-checks the admin password. |

## Telegram accounts

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/accounts` | Admin | Loaded Telegram accounts. |
| `POST` | `/api/accounts/auth/begin` | Admin | Start the add-account wizard. Returns a wizard `sessionId`. |
| `POST` | `/api/accounts/auth/phone` | Admin | Wizard step: phone number. |
| `POST` | `/api/accounts/auth/code` | Admin | Wizard step: login code. |
| `POST` | `/api/accounts/auth/2fa` | Admin | Wizard step: two-step verification password. |
| `POST` | `/api/accounts/auth/cancel` | Admin | Cancel the wizard. |
| `GET` | `/api/accounts/auth/{sessionId}` | Admin | Wizard state. |
| `DELETE` | `/api/accounts/{id}` | Admin | Remove an account. |
| `POST` | `/api/proxy/test` | Admin | Test a proxy before it is saved. |

## Chats and groups

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/dialogs` | Admin | Chats the accounts can see. Works without starting the monitor. |
| `GET` | `/api/groups` | Guest | Configured chats with download counts and access state. |
| `PUT` | `/api/groups/{id}` | Admin | Save one chat's settings. |
| `GET` | `/api/groups/{id}/stats` | Guest | Per-chat statistics. |
| `GET` | `/api/groups/{id}/files` | Guest | Files downloaded from one chat. |
| `GET` | `/api/groups/{id}/photo` | Guest | Chat profile photo, downloaded on first request and then cached. |
| `POST` | `/api/groups/refresh-info` | Admin | Refresh chat names and details from Telegram (background). |
| `GET` | `/api/groups/refresh-info/status` | Guest | Progress of the above. |
| `POST` | `/api/groups/refresh-photos` | Admin | Refresh chat profile photos (background). |
| `GET` | `/api/groups/refresh-photos/status` | Guest | Progress of the above. |
| `DELETE` | `/api/groups/{id}/purge` | Admin | Remove a chat's downloads, files and settings (background). |
| `POST` | `/api/groups/{id}/delete-files` | Admin | Delete a chat's downloaded files only (background). |
| `GET` | `/api/groups/{id}/purge/status` | Guest | Progress of either purge. |

### Chat access

Deleted, restricted and unreachable chats.

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/chats/access` | Admin | Chats that are deleted, restricted or no longer readable, with Telegram's reason. |
| `POST` | `/api/chats/access/recheck` | Admin | *Check again*: re-test access (background). |
| `GET` | `/api/chats/access/recheck/status` | Admin | Progress of the re-check. |
| `POST` | `/api/chats/access/stop` | Admin | Stop the re-check. |
| `POST` | `/api/chats/access/remove` | Admin | Remove dead chats from the dashboard's list. |
| `GET` | `/api/chats/lookup?q=` | Admin | Resolve a username, link or ID to a chat. |
| `POST` | `/api/chats/{id}/leave` | Admin | *Leave / remove from Telegram* for one chat with the selected account. |
| `POST` | `/api/chats/leave-batch` | Admin | Leave several dead chats from one account, keeping or deleting their files. |
| `GET` | `/api/chats/leave-batch/status` | Admin | Progress of the batch leave. |
| `POST` | `/api/chats/{id}/follow-migration` | Admin | Move a basic group's settings to the supergroup it was upgraded to. |

## Downloads and library

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/stats` | Guest | Library totals for the dashboard header. |
| `GET` | `/api/downloads` | Guest | Downloads overview. |
| `GET` | `/api/downloads/all` | Guest | Paged list of all downloads (gallery). |
| `GET` | `/api/downloads/search` | Guest | Search downloads. |
| `GET` | `/api/downloads/{id}` | Guest | Downloads of one chat (`{id}` is the chat ID). |
| `POST` | `/api/downloads/{id}/pin` | Admin | Pin or unpin one download. |
| `POST` | `/api/downloads/pin` | Admin | Pin or unpin several downloads. |
| `POST` | `/api/downloads/bulk-delete` | Admin | Delete several downloads and their files. |
| `POST` | `/api/downloads/bulk-zip` | Admin | Stream the selected downloads as a ZIP. |
| `GET` | `/api/files/archive-list` | Admin | List of files for an archive download. |
| `DELETE` | `/api/file?path=` | Admin | Delete one file under the downloads folder. |
| `GET` | `/api/thumbs/{id}` | Guest | Thumbnail image for a download. |
| `GET` | `/api/seekbar/meta/{id}` | Guest | Video seekbar sprite metadata. |
| `GET` | `/api/seekbar/sprite/{id}` | Guest | Video seekbar sprite image. |
| `GET` | `/api/files/token` | Guest | Short-lived file token, `{token, exp}`, valid 15 minutes for the caller's role. |

### Media files

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET`, `HEAD` | `/files/{path}` | Guest, or file token | A file from the downloads folder (`TGDL_DOWNLOADS_DIR` if set). Supports range requests. Instead of a cookie, `?token=<value from /api/files/token>` works too, which is useful for external players. The token opens `/files/` and nothing else. |
| `GET` | `/photos/{id}` | Guest | Cached profile photo from `data/photos/`. |

## Queue and jobs

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/queue/snapshot` | Guest | Current download queue. |
| `POST` | `/api/queue/{key}/pause` | Admin | Pause one item. |
| `POST` | `/api/queue/{key}/resume` | Admin | Resume one item. |
| `POST` | `/api/queue/{key}/cancel` | Admin | Cancel one item. |
| `POST` | `/api/queue/{key}/retry` | Admin | Retry one failed item. |
| `POST` | `/api/queue/batch` | Admin | Apply one action to several items. |
| `POST` | `/api/queue/pause-all` | Admin | Pause everything. |
| `POST` | `/api/queue/resume-all` | Admin | Resume everything. |
| `POST` | `/api/queue/cancel-all` | Admin | Cancel everything. |
| `POST` | `/api/queue/retry-all` | Admin | Retry all failed items. |
| `POST` | `/api/queue/clear-finished` | Admin | Clear finished items. |
| `GET` | `/api/jobs` | Admin | Background jobs on the durable work queue. |
| `GET` | `/api/jobs/{id}` | Admin | One job. |
| `POST` | `/api/jobs/{id}/cancel` | Admin | Cancel a job. |

## History backfill

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/api/history` | Admin | Start a backfill of a chat's older messages. Returns `409` with code `CHAT_UNREACHABLE` if the chat can't be read. |
| `GET` | `/api/history` | Admin | Running backfills. |
| `GET` | `/api/history/jobs` | Admin | Recent backfill jobs. |
| `GET` | `/api/history/{jobId}` | Admin | One backfill job. |
| `POST` | `/api/history/{jobId}/cancel` | Admin | Cancel it. |
| `DELETE` | `/api/history/{jobId}` | Admin | Remove a finished job from the list. |
| `DELETE` | `/api/history` | Admin | Clear finished jobs. |

## Stories and URL downloads

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/api/stories/user` | Admin | List a user's or channel's stories, `{username}`. |
| `POST` | `/api/stories/all` | Admin | All active stories the account can see. |
| `POST` | `/api/stories/download` | Admin | `{username, storyIds}` (at most 100 IDs) → queue those stories. |
| `POST` | `/api/download/url` | Admin | `{urls: [...]}`: queue downloads from Telegram message links. Each link gets its own result. |

## Monitor

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/monitor/status` | Guest | Monitor state and per-account status. |
| `POST` | `/api/monitor/start` | Admin | Start the realtime monitor. |
| `POST` | `/api/monitor/stop` | Admin | Stop it. |
| `POST` | `/api/monitor/restart` | Admin | Restart it. |
| `POST` | `/api/maintenance/restart-monitor` | Admin | Restart the monitor as a tracked maintenance task. |
| `GET` | `/api/maintenance/restart-monitor/status` | Admin | Progress of the above. |
| `POST` | `/api/maintenance/resync-dialogs` | Admin | Re-read every account's chat list from Telegram. |
| `GET` | `/api/maintenance/resync-dialogs/status` | Admin | Progress of the above. |

## Maintenance

Long tasks start with a `POST` and report progress through their `…/status` route and the matching [WebSocket events](#websocket).

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/api/maintenance/db/integrity` | Admin | SQLite integrity check. |
| `GET` | `/api/maintenance/db/integrity/status` | Admin | |
| `POST` | `/api/maintenance/db/vacuum` | Admin | Compact the database. |
| `GET` | `/api/maintenance/db/vacuum/status` | Admin | |
| `POST` | `/api/maintenance/db/backup` | Admin | Write a database snapshot to `data/backups/`. |
| `POST` | `/api/maintenance/files/verify` | Admin | Check that downloaded files still exist on disk. |
| `GET` | `/api/maintenance/files/verify/status` | Admin | |
| `GET` | `/api/maintenance/files/verify/stats` | Admin | |
| `POST` | `/api/maintenance/reindex` | Admin | Rebuild the library index from files on disk. |
| `GET` | `/api/maintenance/reindex/status` | Admin | |
| `GET` | `/api/maintenance/reindex/stats` | Admin | |
| `GET` | `/api/maintenance/dedup/stats` | Admin | Duplicate-file summary. |
| `GET` | `/api/maintenance/dedup/sets` | Admin | Duplicate sets. |
| `POST` | `/api/maintenance/dedup/scan` | Admin | Scan for duplicates. |
| `POST` | `/api/maintenance/dedup/scan/stop` | Admin | Stop the scan. |
| `GET` | `/api/maintenance/dedup/status` | Admin | Scan progress. |
| `POST` | `/api/maintenance/dedup/delete` | Admin | Delete chosen duplicates. |
| `GET` | `/api/maintenance/dedup/delete/status` | Admin | Delete progress. |
| `GET` | `/api/maintenance/thumbs/stats` | Admin | Thumbnail coverage. |
| `GET` | `/api/maintenance/thumbs/list` | Admin | Thumbnail list. |
| `POST` | `/api/maintenance/thumbs/build-all` | Admin | Build missing thumbnails. |
| `GET` | `/api/maintenance/thumbs/build/status` | Admin | |
| `GET` | `/api/maintenance/thumbs/build/stats` | Admin | |
| `POST` | `/api/maintenance/thumbs/build/cancel` | Admin | |
| `POST` | `/api/maintenance/thumbs/rebuild` | Admin | Rebuild all thumbnails. |
| `GET` | `/api/maintenance/thumbs/rebuild/status` | Admin | |
| `POST` | `/api/maintenance/thumbs/rebuild-one/{id}` | Admin | Rebuild one thumbnail. |
| `GET` | `/api/maintenance/thumbs/hwaccel-probe` | Admin | Hardware-acceleration probe. 3.0 makes thumbnails on the CPU. |
| `GET` | `/api/maintenance/faststart/stats` | Admin | MP4 faststart coverage. |
| `GET` | `/api/maintenance/faststart/auto-stats` | Admin | |
| `GET` | `/api/maintenance/faststart/status` | Admin | |
| `POST` | `/api/maintenance/faststart/scan` | Admin | Move video metadata to the front so playback starts sooner. |
| `GET` | `/api/maintenance/recovery/list` | Admin | Items needing recovery, including paused chats. |
| `GET` | `/api/maintenance/recovery/status` | Admin | |
| `POST` | `/api/maintenance/recovery/{op}` | Admin | `{op}` is `resolve`, `disable`, `ignore`, `unignore`, `reassign` or `delete`. |
| `GET` | `/api/rescue/stats` | Admin | Rescue statistics. |
| `GET` | `/api/maintenance/logs` | Admin | Log files. |
| `GET` | `/api/maintenance/logs/recent` | Admin | Recent log lines. |
| `GET` | `/api/maintenance/logs/download` | Admin | Download a log file. |
| `DELETE` | `/api/purge/all` | Admin | Factory reset. Body must be `{"confirm": "DELETE ALL"}`. |
| `GET` | `/api/purge/all/status` | Admin | Progress of the reset. |

## Settings

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/config` | Admin | Effective settings, with secrets redacted. |
| `POST` | `/api/config` | Admin | Save settings. Connected dashboards get `config_updated`. |
| `GET` | `/api/maintenance/config/raw` | Admin | Raw stored configuration, with secrets redacted. |
| `GET` | `/api/csp` | Admin | The Content-Security-Policy currently in effect. |

## Backup

Destinations and modes are covered in [Backup](BACKUP.md). Google Drive and Dropbox are not available in 3.0.

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/backup/providers` | Admin | Available destination types. |
| `GET` | `/api/backup/destinations` | Admin | Configured destinations. |
| `POST` | `/api/backup/destinations` | Admin | Add a destination. |
| `PUT` | `/api/backup/destinations/{id}` | Admin | Edit it. |
| `DELETE` | `/api/backup/destinations/{id}` | Admin | Remove it. |
| `GET` | `/api/backup/destinations/{id}/config` | Admin | Its stored settings. |
| `GET` | `/api/backup/destinations/{id}/status` | Admin | Progress and last result. |
| `GET` | `/api/backup/destinations/{id}/jobs` | Admin | Its job history. |
| `GET` | `/api/backup/destinations/{id}/recovery` | Admin | Recovery details for an interrupted run. |
| `POST` | `/api/backup/destinations/{id}/test` | Admin | Test the connection. |
| `POST` | `/api/backup/destinations/{id}/run` | Admin | Run now. |
| `POST` | `/api/backup/destinations/{id}/pause` | Admin | Pause it. |
| `POST` | `/api/backup/destinations/{id}/resume` | Admin | Resume it. |
| `POST` | `/api/backup/destinations/{id}/encryption` | Admin | Turn encryption on or off, `{enabled, passphrase}`. |
| `POST` | `/api/backup/destinations/{id}/unlock` | Admin | Unlock an encrypted destination, `{passphrase}`. |
| `GET` | `/api/backup/jobs/recent` | Admin | Recent jobs across destinations. |
| `POST` | `/api/backup/jobs/{id}/retry` | Admin | Retry a failed job. |
| `GET` | `/api/backup/cleanup` | Admin | Cleanup state. |

Restoring is done offline with `tgdl-server backup-restore` (and `backup-decrypt` for encrypted archives), not over HTTP.

## Cluster

Setup and concepts are in [Cluster](CLUSTER.md).

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/cluster/identity` | Admin | This server's peer ID and name. |
| `PUT` | `/api/cluster/identity` | Admin | Rename, `{name}`. |
| `GET` | `/api/cluster/identity/token` | Admin | Show the cluster token. |
| `POST` | `/api/cluster/identity/set-token` | Admin | Set the cluster token. |
| `POST` | `/api/cluster/identity/rotate-token` | Admin | Rotate the cluster token. |
| `POST` | `/api/cluster/identity/pairing-code` | Admin | Create a one-time pairing code. |
| `POST` | `/api/cluster/pairing-code` | Admin | Same as the above (older path). |
| `GET` | `/api/cluster/peers` | Admin | Paired peers. |
| `POST` | `/api/cluster/peers` | Admin | Pair with a peer using its address and pairing code. |
| `PUT` | `/api/cluster/peers/{peerID}` | Admin | Edit a peer. |
| `DELETE` | `/api/cluster/peers/{peerID}` | Admin | Unpair. |
| `POST` | `/api/cluster/peers/{peerID}/test` | Admin | Test the connection. |
| `GET` | `/api/cluster/audit` | Admin | Peer request audit log. |
| `GET` | `/api/cluster/sync/state` | Admin | Catalog sync state. |
| `POST` | `/api/cluster/sync/run` | Admin | Sync now. |

Peer-to-peer routes are not for scripts. Every request is signed with the shared cluster secret through the `X-Peer-Id`, `X-Peer-Ts` and `X-Peer-Signature` headers. Failures return `401 {"error":"cluster auth failed","code":…}` and are written to the audit log.

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/api/cluster/handshake` | Peer (pairing code) | Pairing handshake. |
| `GET` | `/api/cluster/health` | Peer | Peer liveness. |
| `GET` | `/api/cluster/downloads/since` | Peer | Catalog rows since a cursor. |
| `GET` | `/api/cluster/catalog/changes` | Peer | Catalog change feed. |
| `GET` | `/api/cluster/search/peer` | Peer | Catalog search. |
| `GET` | `/api/cluster/groups/snapshot` | Peer | Chat snapshot. |
| `GET` | `/api/cluster/accounts/snapshot` | Peer | Account snapshot. |
| `GET` | `/api/cluster/files/{path}` | Peer | Media transfer with range requests. |
| `GET` (upgrade) | `/ws/cluster` | Peer | Peer WebSocket. |

## AI (people and faces)

These routes read and edit the face and people data stored in the library. See [AI](AI.md).

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/ai/people` | Admin | People list. Query: `limit`, `offset`, `sort` (`face_count`, `name`, `avg_quality`), `dir`. |
| `GET` | `/api/ai/people/{id}/photos` | Admin | Photos of one person. |
| `GET` | `/api/ai/person/{id}/face` | Admin | Cover face crop for a person. |
| `GET` | `/api/ai/faces/by-download/{id}` | Admin | Faces found in one download. |
| `GET` | `/api/ai/faces/{id}/crop` | Admin | One face crop image. |
| `GET` | `/api/ai/group-by-person` | Admin | Downloads grouped by person. |
| `PATCH` | `/api/ai/people/{id}` | Admin | Rename or edit a person. |
| `POST` | `/api/ai/people/{id}/merge` | Admin | Merge people. |
| `POST` | `/api/ai/people/{id}/split` | Admin | Split a person. |
| `POST` | `/api/ai/faces/{id}/reassign` | Admin | Move a face to another person. |
| `POST` | `/api/ai/faces/reindex` | Admin | Re-index faces. |
| `DELETE` | `/api/ai/people/{id}` | Admin | Delete a person. |

## Share links

| Method | Path | Access | Notes |
|---|---|---|---|
| `POST` | `/api/share/links` | Admin | `{downloadId, ttlSeconds?, label?}` → `{success, link}`. Without `ttlSeconds` the link lasts 7 days. Values are clamped to the configured range (default 60 s to 90 days), and `0` means the link never expires. |
| `GET` | `/api/share/links` | Admin | `{links, total, limit, offset, hasMore}`. Each link includes its `url`, `expiresAt`, `revokedAt`, `accessCount` and file details. |
| `DELETE` | `/api/share/links/{id}` | Admin | Revoke a link → `{success, revoked}`. |
| `GET` | `/share/{id}?s=<sig>` | Public | Serves the file inline. Add `&download=1` to force a download. |
| `GET` | `/share/{id}/{name}?s=<sig>` | Public | Same, with a file name in the path. |

Link format: `https://<host>/share/<linkId>?s=<signature>`, where the signature is an HMAC-SHA256 of the link ID and expiry made with a server-side secret. Links made by 2.x (`?sig=…&exp=…`) keep working. Revoked, expired or tampered links get `401 {"error":"Share link is not valid","code":…}`. A file missing on disk gets `404`. The public routes are rate-limited (see [Rate limits](#rate-limits)).

## Update

One-click update uses the watchtower sidecar, as in 2.x. See [Deploy](DEPLOY.md).

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/update/status` | Admin | `{available, inDocker, watchtowerConfigured, watchtowerUrl, overlayStallMs}`. |
| `POST` | `/api/update` | Admin | Ping watchtower, check the database, write a verified pre-update snapshot, then trigger the update. |
| `GET` | `/api/auto-update/status` | Admin | Progress of the current update. |
| `GET` | `/api/update/history` | Admin | Past updates. |

## WebSocket

Connect to `ws://<host>:3000/ws` (or `wss://` behind TLS). An upgrade on `/` is accepted too. The upgrade needs a valid `tg_dl_session` cookie, otherwise it gets `401`. Guest sessions may connect.

- The socket is **server-push only**. Anything the client sends is read and ignored.
- The server pings every 30 seconds and drops the connection after 90 seconds without a pong. The socket closes when its session expires or is revoked (logout, password change, *Revoke all sessions*). Socket traffic does not extend the session.
- Each message is one JSON object with a `type`. Most events carry their data in `payload`, as in `{"type": "...", "payload": {...}}`. Some, mainly progress events, put their fields directly beside `type`.

| Area | Event types |
|---|---|
| Downloads & queue | `download_complete`, `queue_changed`, `stats_update`, `stats_push`, `file_deleted`, `bulk_delete`, `download_pinned`, `downloads_pinned` |
| Monitor | `monitor_state`, `monitor_status_push`, `resync_dialogs_progress`/`_done`, `restart_monitor_progress`/`_done` |
| Chats | `groups_refreshed`, `groups_refresh_info_progress`/`_done`, `groups_refresh_photos_progress`/`_done`, `chat_access_changed`, `chat_access_recheck_progress`/`_done`, `chat_leave_batch_progress`/`_done`, `group_files_deleted`, `group_purged`, `group_purge_progress`/`_done` |
| History backfill | `history_progress`, `history_done`, `history_error`, `history_cancelled`, `history_cancelling`, `history_deleted`, `history_cleared` |
| Maintenance | `db_integrity_progress`/`_done`, `db_vacuum_progress`/`_done`, `files_verify_progress`/`_done`, `reindex_progress`/`_done`, `dedup_progress`/`_done`, `dedup_delete_progress`/`_done`, `thumbs_progress`/`_done`, `thumbs_rebuild_progress`/`_done`, `faststart_progress`/`_done`, `recovery_bulk_progress`/`_done`, `integrity_swept`, `purge_all_progress`/`_done`, `purge_all` |
| Rescue | `rescued`, `rescue_sweep_done` |
| Backup (admin sockets only) | `backup_progress`, `backup_done`, `backup_error`, `backup_queue_drained`, `backup_destination_added`, `backup_destination_updated`, `backup_destination_removed`, `log` |
| Cluster | `peer_catalog_update` |
| Settings & AI | `config_updated`, `ai_config_changed`, `ai_faces_reindexed`, `seekbar_config_changed`, `seekbar_sidecar_status` |
| Session & update | `sessions_revoked`, `update_started`, `update_done` |

## Internal routes

- **`/v1/db/*`** (`POST`, admin session) are read helpers that `tgdl-server` registers for its own use, behind the same session gate. The dashboard does not call them directly, and they are not a supported API.
- The **`tgdl-core`** helper (`core-service/cmd/tgdl-core`) has its own `/v1/*` API secured by a bearer token. It is a development and testing tool, not part of 3.0: the Docker image, CI and the release archives only build `tgdl-server`.
- Every path not listed here serves the embedded dashboard (HTML, JS, CSS, service worker).

## See also

- [Deploy](DEPLOY.md): ports, environment variables, reverse proxy, first password
- [Configuration](CONFIGURATION.md): every setting and environment variable
- [Upgrading](UPGRADING.md): moving from 2.x to 3.0
- [Troubleshooting](TROUBLESHOOTING.md)
- [Architecture](ARCHITECTURE.md)
