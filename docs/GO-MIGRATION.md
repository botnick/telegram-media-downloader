---
title: "Go migration plan"
description: "The plan for moving the backend from Node.js to Go without users noticing: waves, the API contract gate and data-compatibility rules."
nav_order: 10
---

# Moving the backend to pure Go

The backend is moving from Node.js to Go, domain by domain, behind a Go
front server. The SPA in `src/web/public` stays exactly as it is. The hard
requirement: **users must not notice.** Every HTTP route, every WebSocket
event, every file in the data directory and every environment variable
behaves as it does today.

This plan extends [GO-CORE.md](GO-CORE.md). `tgdl-core` started as a
companion that takes over hot paths while Node stays in charge (Node is the
single DB writer, every feature has a Node fallback). Here the end state is
different: one Go binary, no Node at runtime. The GO-CORE rules still apply
to everything shipped as a *companion feature* (flags, shadow mode, parity
counters, Node fallback). This document adds the rules for moving whole
domains, and the gate every move has to pass.

## The gate: the API contract suite

`tests/contract/` is a black-box suite recorded from today's Node server
(see [its README](https://github.com/botnick/telegram-media-downloader/blob/main/tests/contract/README.md)). It starts the server under
test on a fresh deterministic seed, talks to it over HTTP and WebSocket
only, normalises the answers and compares them with the golden snapshots in
`tests/contract/__snapshots__/`.

```
npm run test:contract                      # Node (default target)
CONTRACT_TARGET=go npm run test:contract   # the Go binary
```

**Rule: a domain switches to Go only when the contract suite passes against
`CONTRACT_TARGET=go`** — its own scenario files, *and* every other file
(the front server proxies the rest to Node, so a regression anywhere
counts). The coverage checker (`inventory.contract.test.js`) must pass too.
No golden is re-recorded to make Go pass: goldens are recorded from the
Node target only (`npm run test:contract:update` refuses any other target).
If Go is right and Node is wrong, fix Node first, re-record from Node, then
port. (The Go front server of wave A is started by the Node app, so the
default target already runs through it: CI builds tgdl-core for the
contract job and sets `TGDL_FRONT_REQUIRED=1`, which the harness passes
through, so a front server that can't start fails the run instead of
Node answering PORT itself. `CONTRACT_TARGET=go` is for the standalone Go
server of the later waves.)

| Domain | Scenario files |
|---|---|
| Auth, sessions, transport | `auth`, `auth-password`, `auth-setup`, `security` |
| SPA shell, PWA, avatars, version, metrics | `static` |
| Config, system, updates, logs | `config`, `system`, `updates` |
| Groups, chats, purge | `groups`, `chats`, `purge` |
| Telegram surface (accounts, monitor, history, queue, stories, URL) | `accounts`, `monitor`, `queue`, `telegram-actions` |
| Library, files, thumbnails, share links | `downloads`, `files`, `share`, `delete` |
| Maintenance jobs | `maintenance`, `dedup`, `thumbs`, `faststart`, `recovery` |
| AI / faces / NSFW / seekbar | `ai`, `ai-jobs`, `nsfw`, `seekbar` |
| Backup, cluster | `backup`, `cluster`, `cluster-peer`, `cluster-ws` |

### What the Go target must provide

The harness spawns `$CONTRACT_GO_BIN` (default
`core-service/bin/tgdl-server[.exe]`) with no arguments, cwd = repo root, and
a minimal environment:

- `PORT`, `TGDL_DATA_DIR` (a temp dir holding the seed), `NODE_ENV=test`
  (one scenario uses `production`), `TZ=UTC`, `TGDL_GO_CORE=off`, and any
  extra variables a scenario sets (`TGDL_METRICS_TOKEN`, …).
- **No network except loopback.** The Node target gets this from
  `tests/contract/fixtures/sandbox.mjs` (DNS fails with `ENOTFOUND`, non-local
  TCP is refused, LAN discovery is muted). The harness also exports
  `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:9` and `NO_PROXY=127.0.0.1,localhost`,
  which Go's `net/http` honours; UDP discovery and raw dials need an
  equivalent (a network namespace with only `lo` in CI — `unshare -rn` —
  or a test-only dialer hook). Error texts from the network stack are
  already masked where they surface.
- Ready when `GET /api/auth_check` answers 200.
- `POST /api/auth/reset/request` prints `Token: <32 hex>` to stdout (the
  harness reads it from the process output, as an operator reads
  `docker compose logs`).
- Exits on SIGTERM.
- Reads and writes the data dir exactly like Node (see *Data
  compatibility*): the seed is a Node-shaped data dir built from the frozen
  schema (`tests/contract/fixtures/schema.sql`), with sessions, config,
  secrets and credential blobs in their on-disk formats.

`CONTRACT_TARGET=url` attaches to a server started by hand (debugging;
seed its data dir first with `node scripts/contract-seed.mjs <dir>`, and
restart it on a fresh seed between files — scenarios mutate state).

## Architecture during the move

```
browser ──► Go front server ──┬─► Go handlers (domains already moved)
                               └─► Node server (everything else, proxied)
             /ws ─────────────────► Go broadcaster ◄── events from Node
```

- The front server owns the listening port, TLS/proxy trust, security
  headers, compression, static files and `/files` Range streaming from
  wave A on, and proxies every other request to a Node child on a loopback
  port (HTTP and WebSocket upgrades, headers and cookies untouched).
- Writes move **with their caches and events**: a domain's writes, the WS
  events they emit and the in-memory caches over that data (config cache,
  sidebar aggregates, stats cache, job trackers) switch together —
  splitting them across processes turns every cache into a stale-data bug.
  Reads may move earlier (wave B) only where Go answers straight from
  SQLite with no cache of its own, so a Node write is visible to the next
  Go read.
- One DB, two processes during waves B–D. SQLite in WAL mode allows it
  (file locks), with the same pragmas on both sides (`journal_mode=WAL`,
  `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`). The owner
  of a table's writes is always the process that owns the domain; the other
  side only reads. `kv['config']` stays written by Node until the config
  domain moves in wave C; Go reads it with the same 2 s cache semantics.
- WebSocket: from wave C the Go front server owns every dashboard socket.
  Node, while it still runs domains, pushes its events to Go over an
  internal loopback channel; Go keeps the storm control of
  `src/web/lib/ws-broadcaster.js` (500 ms latest-wins coalescing of
  `download_progress` / `history_progress` / `queue_length` /
  `queue_changed{op:enqueue}`, flush-before rules, 1 MiB backpressure cap,
  30 s ping/terminate heartbeat) and the per-role `stats_update` push.

## Waves

### A — hashing, file-system sweeps, dbscan, and the Go front server *(in progress)*

- tgdl-core phases 1–2 ([GO-CORE.md](GO-CORE.md)): SHA-256 hashing, integrity
  walk, disk-usage scan, orphan detection, face-clustering DBSCAN — still
  companion features with Node fallback and parity counters.
- Go front server: static SPA (including the `?v=<version>` rewrite of HTML
  `src`/`href` and of relative JS imports), `/photos`, `/files/*` with Range,
  conditional requests, `?inline=1`, file-token auth and the auto-prune of
  rows whose file is gone, `/share/*`, security headers (helmet profile,
  CSP, `Strict-Transport-Security: max-age=0` unless forceHttps), gzip / br /
  deflate negotiation with the same exclusions, forceHttps + `TRUST_PROXY`,
  and the proxy to Node for the rest.
- Exit: the whole suite passes through the front server (the default
  target, with tgdl-core built). `static`, `files`, `share`, `security`
  and `auth` are the files that exercise it directly. Shipped:
  `/files`, `/photos` and thumbnail cache hits with Range, conditional
  requests, file-token and session auth; the rest (static SPA, `/share`,
  compression, auto-prune) is still answered by Node through it.

### B — Go DB layer and the read APIs

- `modernc.org/sqlite` (pure Go, no CGO; FTS5 included), the same schema.
  Go takes over migrations: the same idempotent DDL as `src/core/db.js`
  (CREATE … IF NOT EXISTS, guarded ALTER TABLE ADD COLUMN, deferred index
  builds with the `index_build_attempt:*` markers, FTS5 content-sync
  triggers, one-off data fixes). A new check in this wave: a DB created by
  Go must dump to exactly `tests/contract/fixtures/schema.sql`, and running
  Go's migrations on a Node-created DB (every release since v2.9) must be a
  no-op.
- Read APIs move: library / gallery / search, groups sidebar, stats,
  GET config, share-link list, people / faces reads, NSFW tiers, backup
  destination reads, cluster reads, update history, logs.
- First read-only slice shipped: the groups/downloads aggregate projection is
  served by `tgdl-core` from a query-only SQLite pool (`db` feature), with the
  Node query retained as a compatibility fallback while the rest of Wave B
  moves.
- Node still writes. Exit: the domain files pass on `go`.

### C — write APIs, WS broadcaster, jobs, backup, cluster

- Every mutating route outside the Telegram engine: config save (with the
  `mergeConfig` default-merge and self-heal, per-key cluster replication),
  groups, pins, deletes (dedup-aware), share links, purge, maintenance jobs
  on the job-tracker contract (`<prefix>_progress` / `<prefix>_done`
  payloads, `ALREADY_RUNNING` 409), recovery, AI mutations, NSFW review.
- Web auth: scrypt (N=16384, r=8, p=1, keylen 64), `web_sessions` with
  sliding renewal below 25 % of the TTL, the login limiter (10 / 15 min
  shared by login, change-password and reset), setup, guest password, reset
  token on stdout.
- WS broadcaster in Go (see above).
- Backup: the six providers (tgdl-core phase 4), queue, snapshots, the
  `TGDC` credential blobs.
- Cluster: HMAC request signing, handshake / pairing codes, sync engine,
  `/ws/cluster`, failover, sweep, federated search, LAN discovery. Wire
  compatibility with Node peers of every version: a pairing-code handshake
  is signed with `HMAC-SHA256("tgdl-cluster-pairing-code", CODE)` and the
  receiver also accepts `HMAC-SHA256(cluster_token, "pairing:" + CODE)`;
  `sign-url` answers `{url, expiresAt (ms), exp (s)}` and a peer answer
  without `exp` means "stream through the proxy"; a peer thumbnail that
  isn't image bytes is replaced by the placeholder; the engines run from
  boot while at least one peer is paired, and a failed dial is not a
  status change.
- Exit: every non-Telegram file passes on `go`.

### D — the Telegram engine on gotd

- `github.com/gotd/td`: account wizard (phone → code → 2FA), monitor
  (updates + catch-up), downloader (queue lanes, autoscaler, FloodWait
  pauses), history backfill, stories, URL download, auto-forwarder,
  chat-access probes, dialogs, profile photos.
- **gramJS session converter.** `data/sessions/<id>.enc` is `SecureSession`
  JSON `{v, salt, iv, data, tag}` (hex): AES-256-GCM, key =
  `scrypt(<contents of secret.key>, salt, 32)` with a per-blob salt (v2)
  or the fixed `tg-dl-salt-v1` (v1/unversioned). The plaintext is a gramJS
  `StringSession` (version char + base64 of DC id, server address, port and
  the 256-byte auth key). The converter maps it to a gotd session (DC,
  address, auth key) so nobody logs in again. `data/session.enc` (legacy
  single session) migrates the same way `AccountManager.migrateLegacy`
  does. The converter never writes the `.enc` files — Node must keep
  working if the operator rolls back.
- **Spikes on a throwaway account, before any user-facing switch:**
  1. convert a gramJS session and connect with gotd without re-login;
  2. run the same auth key from gramJS and gotd *in turn* (never at the
     same time — one live connection per key) and confirm Telegram doesn't
     revoke it;
  3. download parity: same bytes, same file names (`sanitizeName`, type
     folders), same `downloads` rows, dedup references and hashes;
  4. FloodWait and `FILE_REFERENCE_EXPIRED` handling;
  5. monitor → download → WS event sequence identical to the Node engine.
- **Fake-Telegram seam** (not built yet, the app is not refactored for it).
  Every Telegram call leaves through gramJS `TelegramClient` instances with
  two owners: `AccountManager` (`src/core/accounts.js` — loads
  `data/sessions/*.enc`, `createClient`, the wizard's deferred
  `client.start` callbacks) and the legacy single-session `telegramClient`
  in `server.js` (boot-time group-name resolution only). Everything else
  borrows a client from `AccountManager`: the runtime
  (`src/core/runtime.js`: Monitor, DownloadManager, RateLimiter,
  AutoForwarder, whose events become WS messages), `HistoryDownloader`
  (`src/core/history.js`), stories (`src/core/stories.js`), entity lookup,
  profile photos, dialogs, chat-access probes, URL download. A seam needs:
  (1) a client factory hook both owners use instead of `new
  TelegramClient` (env-selected module); (2) a fake implementing the
  subset in use — `connect`, `start` callbacks, `checkAuthorization`,
  `getMe`, `getDialogs`, `getEntity`, `getMessages`, `iterMessages`,
  `invoke` (`GetPeerStories` / `GetAllStories`), `downloadMedia`,
  `addEventHandler` (new message / delete), `session.save`, `destroy`;
  (3) a fixture session format. In Go the same boundary is the gotd client
  interface. With it, the engine WS events that are skipped today
  (`download_*`, `queue_*`, `monitor_*`, `history_*`, `rate_wait`,
  `flood_wait`, `scale`, `rescued`, `forward_error`, …) get recorded
  scenarios before the engine moves.
- Exit: Telegram files pass on `go`, engine events covered through the
  seam on both targets, spikes signed off.

### E — images, sidecars, CLI, packaging, removing Node

- Images: thumbnails and face crops without sharp — a pure-Go or
  wasm (wazero) WebP encoder, HEIC and AVIF decoding via wasm builds of
  libheif / libavif. Derived images are compared by format and dimensions,
  not bytes (a different encoder can't be byte-identical), so the contract
  holds. Video first frames keep using ffmpeg (an external binary, not
  Node).
- NSFW only through `nsfw-service` (the in-process
  `@huggingface/transformers` path goes); faces stay on `faces-service`;
  the local Go core owns seekbar sprite decode/scale/tile/encode, while
  `seekbar-service` remains a supported remote worker when configured.
- The CLI (`src/index.js`: menu, monitor, history, auth, doctor, …) in Go,
  same subcommands and flags.
- One binary with the SPA embedded (`embed.FS` of `src/web/public`; the
  `?v=` rewrite still happens at request time).
- Docker image without Node: same `PORT` 3000, same `/app/data` volume,
  same non-root user **uid/gid 1000** (existing volumes are owned by it),
  same entrypoint behaviour (`scripts/docker-entrypoint.sh`: data dir
  perms, `/dev/dri` group detection, gosu), healthcheck as a binary
  subcommand instead of `node scripts/healthcheck.js`, same compose files.
- Bare-metal: a single binary per platform (the tgdl-core release /
  auto-download machinery), `data/` next to it as today.
- Launcher shims keep working: `ecosystem.config.cjs` (pm2 runs the binary
  with `interpreter: 'none'`), `runner.js` / `runner.sh` / `watchdog.ps1` /
  `run_safe.bat` (they start `node src/index.js <cmd>` today; they become
  thin wrappers that start the binary with the same subcommand and the same
  `TGDL_RUN` default, and keep writing `data/logs/protection_log.txt`).
- Remove Node from the runtime. The contract suite itself stays a Node
  dev tool (vitest); `schema.sql` and `inventory.json` are frozen files, and
  the checker skips the source-parsing checks once `src/web/server.js` is
  gone.

## Data compatibility (hard rules)

A user upgrades in place and can roll back one release. So:

- **Same data dir.** `TGDL_DATA_DIR` (default `<install>/data`),
  `TGDL_DOWNLOADS_DIR` (default `<data>/downloads`), and inside it:
  `db.sqlite` (+ `-wal`/`-shm`), `downloads/<group>/<images|videos|documents|audio|stickers>/`,
  `photos/<groupId>.jpg`, `thumbs/` (+ `thumbs/face-crops/`), `seekbar/<id>.webp|json`,
  `sessions/<id>.enc`, `session.enc` (legacy), `logs/` (`network.log`,
  `protection_log.txt`), `backups/` (pre-update DB snapshots), and the
  auto-downloaded sidecar binaries (`faces-service/`, `seekbar-service/`).
  `secret.key` (the key of the session files) is read from `<repo>/data/`
  today **even when `TGDL_DATA_DIR` points elsewhere** (`src/core/secret.js`
  hard-codes the path) — Go must look in the same place, or the path gets
  fixed in Node first with a fallback that finds the old file.
- **Same DB.** Same schema, same column meanings and units (e.g.
  `downloads.created_at` is SQLite `DATETIME` text in UTC; `share_links.created_at`,
  `revoked_at`, `last_accessed_at` are epoch **ms** while `expires_at` is epoch
  **seconds** because it is signed into the URL; `kv.value` is JSON text).
  No column is dropped or renamed; new ones are added with the same guarded
  DDL so Node can still open the file after a rollback. The same `kv` keys
  and value shapes (`config`, `peer_id`, `peer_name`, `cluster_token`,
  `disk_usage`, `queue_history`, `history_jobs`, `pending_job_*`,
  `thumbs_widths_unified_v1`, `index_build_attempt:*`, `boot_instance_id`, …).
- **Same sessions.** Dashboard: `web_sessions` rows (64-hex tokens, roles
  `admin`/`guest`, ms timestamps), cookie `tg_dl_session` (HttpOnly,
  SameSite=Strict, Path=/, Max-Age from `advanced.web.sessionTtlDays`,
  `Secure` exactly when `NODE_ENV=production`). Telegram: the `.enc` files
  above, untouched.
- **Same secrets and signatures.** Password hashes
  `{algo:'scrypt', salt, hash, N, r, p, keylen}` (+ the legacy plaintext
  `web.password` upgraded on first login); share links
  `base64url(HMAC-SHA256(shareSecret, "<linkId>|<expiresAtSeconds>"))` and the
  legacy `?exp=&sig=` form; file tokens `<exp>.<sig>` over
  `filetoken:<role>|<exp>`; backup credential blobs `TGDC` v1 (AES-256-GCM,
  KEK = PBKDF2-SHA256(shareSecret, "tgdl-cred-v1"‖0-pad, 200 000, 32));
  cluster request signatures (`x-peer-id` / `x-peer-ts` / `x-peer-signature`)
  and `/ws/cluster` message signatures (`type|ts|sha256(payload)` with the
  per-pair secret).
- **Same config.** `kv['config']` JSON with the same defaults merge
  (`src/config/manager.js`), the same validation and the same quirks the
  goldens record.
- **Same environment variables**, with the same precedence over config:
  everything in [DEPLOY.md](DEPLOY.md) (`PORT`, `TGDL_DATA_DIR`,
  `TGDL_DOWNLOADS_DIR`, `TRUST_PROXY`, `NODE_ENV`, `COMPRESSION_LEVEL`,
  `TGDL_METRICS_TOKEN`, `TGDL_LOG_BUFFER_SIZE`, `TGDL_LOG_MSG_MAX`,
  `PUBLIC_URL` / `PUBLIC_HOST` / `PUBLIC_PROTO`, `WATCHTOWER_*`, `FFMPEG_PATH`,
  the sidecar variables, `TGDL_GO_CORE` / `TGDL_GO_FEATURES`, …). Variables
  that only make sense for Node (`UV_THREADPOOL_SIZE`, `--max-old-space-size`
  via `TGDL_HEAP_MB`) are accepted and ignored, never rejected.
- **Same ports, healthcheck and Docker contract** (see wave E).

## Coverage today

See the `[contract coverage]` line printed by
`tests/contract/inventory.contract.test.js` for the live numbers. At the
time of writing (v2.29.0):

| | Total | Recorded | Skipped (with reason) |
|---|---|---|---|
| HTTP routes (server.js + mounts + SPA files) | 278 | 278 | 0 |
| Dashboard WS event types | 124 | 86 | 38 |
| `/ws/cluster` send / accept types | 15 | 14 | 1 |

34 files (33 with goldens), 1 519 recorded entries (89 of them WS
sequences), ~40 s wall on a desktop (4 workers; the file that waits for the
30 s stats push sets the floor). The skipped WS types are almost all engine events that need a live
Telegram session (the fake-Telegram seam in wave D covers them), plus
sidecar/model downloads the offline sandbox blocks, two dead job families
and Docker-only auto-update. Everything skipped carries its reason in
`tests/contract/inventory.json`.

Known limits of the recording: JSON member order, HTTP framing
(`Content-Length` vs chunked on text bodies) and exact timings are not
pinned; derived images are compared by format and size, not bytes;
`/api/files/archive-list` on `.zip`/tar depends on the host's `unzip`/`tar`
and records only the host-independent branches; the goldens were recorded
on Windows and the Linux CI job is their first cross-platform check (the
most host-sensitive values — ffmpeg-generated sprite sizes, directory walk
order, tool availability — are masked or recorded as invariants).

## Bugs found while recording

Recorded as they behave today (the goldens pin them); fix in Node first,
re-record, then port. Fixed on this branch, with regression tests:

- the configured global API rate limit was ignored for the first 30 s after
  boot (TDZ on the config cache);
- `POST /api/update` answered anonymous and guest callers;
- saving a group broadcast the whole config (password hashes, share secret)
  to every socket, guests included;
- the re-auth guard of session export / sign-out-everywhere accepted the
  guest password.

Still open — see the list in the contract suite README
(`tests/contract/README.md`, *Known bugs pinned by the goldens*).
