# REST API

Base URL: `http://localhost:3000` (or whatever you bound the dashboard to).

All API calls (except the public ones below) require the `tg_dl_session` cookie. Hit `POST /api/login` first to get one.

## Auth & setup

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/auth_check`            | **Public.** `{configured, enabled, authenticated, setupRequired}`. |
| `POST` | `/api/auth/setup`            | **Public, localhost-only.** First-run password — `{password}`. |
| `POST` | `/api/login`                 | **Public.** `{password}` → sets cookie. Rate-limited 10/15min/IP. |
| `POST` | `/api/logout`                | Revokes the current session. |
| `POST` | `/api/auth/change-password`  | `{currentPassword, newPassword}`. |

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
| `GET`  | `/api/monitor/status` | `{state, queue, active, workers, accounts, stats, uptimeMs}`. |
| `POST` | `/api/monitor/start`  | Loads `AccountManager`, starts realtime monitor in-process. |
| `POST` | `/api/monitor/stop`   | Cleans up watchers + the worker pool. |

## Stats / dialogs / groups

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/stats`                  | `{totalFiles, totalSize, diskUsage, telegramConnected,…}`. |
| `GET`  | `/api/dialogs`                | Active + archived chats; DMs gated by `config.allowDmDownloads`. |
| `GET`  | `/api/groups`                 | Configured groups with photo URLs. |
| `PUT`  | `/api/groups/:id`             | Update group config (filters, autoForward, topics, accounts). |
| `DELETE` | `/api/groups/:id/purge`     | Drop files + DB rows + config + photo. |
| `GET`  | `/api/groups/:id/photo`       | Cached profile photo. |
| `POST` | `/api/groups/refresh-photos`  | Re-fetch profile photos for every configured group. |

## Downloads

| Method | Path | Notes |
|---|---|---|
| `GET`    | `/api/downloads`                    | Aggregate per group. |
| `GET`    | `/api/downloads/:groupId`           | Paginated rows for one group. `?type=images\|videos\|documents\|audio`. |
| `GET`    | `/api/downloads/search`             | `?q=…&page=&limit=&groupId=`. |
| `POST`   | `/api/downloads/bulk-delete`        | `{ids?, paths?}`. |
| `DELETE` | `/api/file?path=…`                  | Single file. |
| `DELETE` | `/api/purge/all`                    | Factory reset. |

## Direct downloads (Xinomo parity)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/download/url`           | `{url}` or `{urls:[…]}` — t.me / tg:// URLs. |
| `POST` | `/api/stories/user`           | `{username}` → list of active stories. |
| `POST` | `/api/stories/all`            | All visible stories grouped by peer. |
| `POST` | `/api/stories/download`       | `{username, storyIds:[…]}`. |
| `POST` | `/api/history`                | `{groupId, limit?, offsetId?}` → kicks off a backfill job. |
| `GET`  | `/api/history/:jobId`         | One job. |
| `GET`  | `/api/history`                | All recent jobs. |

## Config & proxy

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/config`     | `apiHash` + `password` redacted; `apiHashSet` boolean replaces hash. |
| `POST` | `/api/config`     | Deep-merge updates; range-validates known fields. |
| `POST` | `/api/proxy/test` | `{host, port}` → 5-s TCP probe. |

## File serving

| Method | Path | Notes |
|---|---|---|
| `GET` | `/files/<path>`     | Serves files under `data/downloads/`. Default `Content-Disposition: attachment`; pass `?inline=1` for inline media (used by the SPA viewer). |
| `GET` | `/photos/<id>.jpg`  | Cached profile photos. |

## WebSocket

`ws://<host>:3000` (or `wss://` behind TLS). Authenticates via the same session cookie at the upgrade handshake.

| Event type | Payload |
|---|---|
| `monitor_state`        | `{state, error?}` |
| `monitor_event`        | `{type, payload}` for download_start/_complete/_error, scale, queue_length, etc. |
| `download_progress`    | `{groupId, fileName, progress}` (legacy) |
| `download_complete`    | `{groupId, fileName, fileSize}` |
| `file_deleted`         | `{path}` |
| `group_purged`         | `{groupId}` |
| `purge_all`            | `{}` |
| `bulk_delete`          | `{unlinked, dbDeleted}` |
| `history_progress`     | `{jobId, processed, downloaded, group}` |
| `history_done` / `history_error` | as above |
| `config_updated`       | `{}` |
