---
title: "tgdl-core (Go engine)"
description: "What tgdl-core does, how it is installed and supervised, and how it serves media as the front server."
nav_order: 9
---

# Go core (`tgdl-core`)

`tgdl-core` (source: [`core-service/`](https://github.com/botnick/telegram-media-downloader/blob/main/core-service/README.md)) is the
app's Go engine. The Node app starts it, talks to it over HTTP on
`127.0.0.1`, and relies on it for the work that used to block or burden
Node's single thread:

| What | Where it's used | tgdl-core route |
|---|---|---|
| SHA-256 of a file | download-time duplicate check, Find duplicates, NSFW hash blocklist | `POST /v1/hash` |
| `fs.stat` of many files | Verify files, the boot and hourly integrity sweep | `POST /v1/fs/stat-batch` |
| recursive `fs.readdir` + `fs.stat` | Re-index from disk, the disk-usage figure while the library is empty | `POST /v1/fs/walk` |
| DBSCAN over face embeddings | face scan, Re-cluster | `POST /v1/dbscan` |
| STORE-mode bulk ZIP streaming | bulk downloads | `POST /v1/zip` (optional feature) |
| MP4 faststart remux | automatic video optimization and maintenance sweep | `POST /v1/faststart` (optional feature) |
| Media thumbnail decode/scale/WebP encode | gallery and thumbnail maintenance jobs | `POST /v1/thumb/{video,image,audio}` (optional feature) |
| Video seekbar sprite decode/scale/tile/encode | seekbar maintenance and auto-generation | `POST /v1/seekbar` (optional feature) |
| Read-only group aggregate projection | `/api/groups` and `/api/downloads` sidebar reads | `POST /v1/db/group-aggregates` (optional feature) |
| Read-only library totals | `/api/stats` database totals | `POST /v1/db/stats` (optional feature) |
| Read-only group data | `/api/groups/:id/stats` and `/api/groups/:id/files` | `POST /v1/db/group-stats`, `/v1/db/group-files` (optional feature) |
| Read-only local gallery | `/api/downloads/all` with `include=local` | `POST /v1/db/downloads/all` (optional feature) |
| Read-only group gallery | `/api/downloads/:groupId` with `include=local` | `POST /v1/db/downloads/group` (optional feature) |
| Read-only local search | `/api/downloads/search` with `include=local` | `POST /v1/db/downloads/search` (optional feature) |
| Read-only share-link list | `/api/share/links` | `POST /v1/db/share-links` (optional feature) |
| Read-only update history | `/api/update/history` | `POST /v1/db/update-history` (optional feature) |
| the dashboard port | every `/files` and `/photos` byte and cached thumbnails served from Go; everything else proxied to Node | `tgdl-core front` ([below](#front-server-tgdl-core-front)) |

For the required features it is the **only** implementation. Optional
features are used when advertised and retain a compatibility path during
upgrades. The Node code it replaced (the
hash worker pool, the `Promise.all(fs.stat)` sweep, the recursive folder
walks, the DBSCAN worker) is removed; Node keeps thin client calls.

## Rules

1. **Node is the single DB writer.** tgdl-core never writes `db.sqlite`;
   the front server only reads `web_sessions` (read-only connection). It
   answers questions; Node decides what to store, prune or fix — every
   rule (what gets pruned, size fixes, the >50 % guard, the
   unavailable-downloads-folder guard, INSERT OR IGNORE order) stays in
   Node, unchanged.
2. **Same results as before, proven.** A feature moved to Go only after
   tests showed identical results against the Node code it replaced (see
   [Parity](#parity)); those checks keep running in every test run.
3. **The error codes are Node's.** `fs.stat` answers carry the exact
   `err.code` Node's libuv would report for the same path on the same OS.
   The integrity sweep deletes a library entry only on `ENOENT` / `ENOTDIR`,
   so this mapping is safety-critical: it is a port of libuv's own Windows
   code path and error table, not Go's `os.Stat` (which, for example,
   reports an offline network share as "does not exist" where Node says
   `UNKNOWN`).
4. **Only the app's media folders.** The app passes its download folders and
   thumbnail and seekbar caches as `TGDL_CORE_ALLOW_ROOTS`; a path outside them (as written
   or after resolving links) gets `EOUTSIDE` and Node answers that one path
   with plain `fs` — so the result is still exactly what `fs` says. The Go
   thumbnail route may write only its requested temporary output beneath the
   thumbnail root. That is a link inside a media folder pointing elsewhere (a
   folder on another disk, `/dev/null`, …); a dangling one is `ENOENT` either
   way, and the integrity sweep never sees `EOUTSIDE` (it prunes only on
   `ENOENT` / `ENOTDIR`). No roots = nothing is read or written.
5. **Can't outlive the app.** It exits when its stdin pipe closes, binds
   `127.0.0.1` only (the front server also binds the app's `PORT`), and
   needs a per-spawn token for everything but `/health`.
6. **No contract changes for users.** Same data dir, DB schema, config,
   HTTP/WS API (additions only, plus the `goCore` health block below), ports,
   Docker entrypoint and healthcheck.

## Installing it

- **Docker**: built into the image (`/app/bin/tgdl-core`).
- **`npm install`**: `scripts/install-core.js` (the `postinstall` step, or
  `npm run install:core`) downloads the pinned release `core-v<CORE_VERSION>`
  for this platform into `data/core-service/bin/` and checks it against the
  release's `SHA256SUMS`; if that isn't possible and Go is installed, it
  builds it (`npm run build:core`). It never fails the install.
- **At startup**, if it still isn't there, the app tries the download once
  more.
- Builds exist for Windows (x64, arm64), Linux (x64, arm64, ARMv7, x86)
  and macOS (arm64, x64). Anywhere else: build with Go and set
  `TGDL_CORE_BIN`.

Lookup order, env overrides (`TGDL_CORE_BIN`, `TGDL_CORE_RELEASE_URL`,
`TGDL_CORE_ALLOW_ROOTS`, `TGDL_CORE_SKIP_INSTALL`): see
[core-service/README.md](https://github.com/botnick/telegram-media-downloader/blob/main/core-service/README.md#how-the-app-finds-it).

## When it can't run

The server still starts; the dashboard and `/api/auth_check` never wait
for tgdl-core (it's started from the listen callback, not awaited).

- The dashboard shows a banner with the exact fix; the same text is in
  `GET /api/system/health` → `goCore.problem` and in the log (`[go-core]`,
  once).
- Verify files, Re-index from disk, Find duplicates and Re-cluster answer
  `503 {"code":"TGDL_CORE_UNAVAILABLE","error":"… Fix: …"}` instead of
  starting.
- A finished download is stored without a hash (as after a read error
  before); Find duplicates fills it in later.
- The integrity sweep stops before changing anything
  (`reason: "core_unavailable"`) — nothing is pruned.
- `/api/stats` keeps its last disk-usage figure.
- While tgdl-core is starting or restarting (crash → restart after 2 s …
  5 min backoff; three failed health probes → restart), calls wait for it
  up to 15 s instead of failing.
- An older binary without a feature (e.g. 0.1.0, which only hashes) is
  reported as outdated with the fix; a stale `npm run build:core` binary is
  passed over for the downloaded one.
- The front server can't run either: Node answers `PORT` itself for the
  dashboard, but `/files`, `/photos` and thumbnails answer
  `503 {"code":"TGDL_CORE_UNAVAILABLE"}` — Node has no file serving of its
  own (see [Front server](#front-server-tgdl-core-front)).

`TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `config.advanced.goCore` and
`HASH_WORKER_DISABLE` from earlier versions are ignored (a one-line note in
the log if set).

## Watching it

- `GET /api/system/health` → `goCore`: `state` (`running`, `starting`,
  `downloading`, `binary_missing`, `unsupported`, `exited`, `unhealthy`,
  `stopped`), `problem` (`{message, fix}` or null), `version` /
  `expectedVersion`, `platform`, `binary` (path + source), `allowRoots`,
  `restarts`, `features.<hash|stat|walk|dbscan>.available`; optional
  features are negotiated directly by their callers.
- `GET /api/monitor/status` → `core`: `{state, fix}` while someone needs to
  act (drives the banner; no local paths).
- `/metrics`: `tgdl_gocore_calls_total{feature,result}` — `feature` is
  `hash` / `stat` / `walk` / `dbscan` / `zip` / `faststart` / `thumb` / `seekbar` / `db`, `result` is `ok`, `file_error`,
  `outside`, `timeout` or `error`.

## Parity

Every test run builds tgdl-core from the same commit and checks it against
the Node code it replaced and against Node itself:

| Suite | Checks |
|---|---|
| `tests/gocore-fs.errors.test.js` | **Safety-critical.** Every situation the OS lets it set up — missing file / folder, a file used as a folder, trailing dot / space, reserved characters and names, 255 / 256-char names, paths over 260 and over 32 767 chars, links in / out / dangling / looping, ACL-denied files and folders, a file locked by another process, pre-1970 and post-2038 timestamps, and on Windows `pagefile.sys`, a missing drive, an offline share, an app-execution alias — answered by `stat-batch` and by Node's own `fs.stat`, live: identical, or exactly `EOUTSIDE` where that is expected (paths and links out of the root, NTFS streams, reserved device names), which the app then answers itself; the app-side result is identical in every case and never `EOUTSIDE`. |
| `tests/gocore-integrity.parity.test.js` | `integrity.sweep` prunes exactly the rows and fixes exactly the sizes the old `Promise.all(fs.stat)` block did, for every row shape (legacy prefixes, federated rows, absolute / `../` paths, links out of the folder, folders where files should be, …). |
| `tests/gocore-walk.parity.test.js` | Re-index from disk inserts the same rows in the same order with the same counters as the old nested `fs.readdir` walk (hidden files, `.part`, `.deleted`, links, deeper folders, duplicate message ids, unreadable folders — same thrown error); the disk-usage total equals the old recursive walk. Also against a frozen fixture. |
| `tests/gocore-dbscan.parity.test.js` | Same clusters, members, order, noise count and byte-identical centroids as `ai/dbscan.js` on the existing DBSCAN fixtures and edge cases, and on a seeded 5 000 × 512 set against a frozen digest of `dbscan.js`'s output. |
| `tests/gocore-hash.parity.test.js` | Digests equal `crypto.createHash` (empty, 1 byte, 1 MiB ± 1, 50 MB, Thai / emoji names, paths over 260 chars, concurrent load); unreadable files fail with the same `err.code` and message as `fs`. |
| `tests/gocore-client.test.js`, `gocore-boot.e2e`, `gocore-dedup.e2e`, `gocore-install` | Failure handling (malformed / cut-off answers are errors, never results; 503 + fix when missing; crash mid-request; no orphan process), boot without a binary, the maintenance jobs end to end, the verified download and the platform slugs. |

The Go side has its own unit tests (`cd core-service && go test ./...`),
including the DBSCAN port against a reference implementation with 1, 2, 8
and 16 workers.

## Measured

`node scripts/bench-gocore.js` on an i9-13900K (32 threads), Windows 11,
NTFS on NVMe, warm cache, Node 22. Every pair produced identical results.
"Loop" is the main event loop while the job runs: delay p99 / max
(`monitorEventLoopDelay`) and utilisation — what the dashboard feels.

| Job | Old Node code | tgdl-core | Loop p99 / max, util (Node → Go) |
|---|---|---|---|
| Integrity sweep, 50 000 rows (pages of 64) | 0.19 s | 0.27 s | 1.2 / 1.2 ms, 100 % → 2.7 / 2.8 ms, 30 % |
| Disk-usage walk, 50 000 files | 1.32 s | 0.22 s | 1.1 / 1.3 ms, 38 % → 2.4 / 2.6 ms, 1 % |
| Re-index walk, 50 000 files | 2.45 s | 0.34 s | 1.2 / 1.3 ms, 43 % → 2.6 / 3.1 ms, 23 % |
| DBSCAN 5 000 × 512 | 7.4 s (worker thread) | 0.26 s | 2.3 / 4.2 ms, 1 % → 4.0 / 5.5 ms, 3 % |
| DBSCAN 20 000 × 512 | 129.9 s (worker thread) | 3.6 s | 2.2 / 10 ms, 1 % → 4.5 / 8.5 ms, 1 % |
| SHA-256, 2 GB, one file at a time | 3.1 s (main thread) | 2.0 s | 2.7 / 8.2 ms, 64 % → 2.4 / 3.6 ms, 4 % |

- The sweep's stats are cheap on a warm local disk (a few µs each through
  libuv's thread pool), so there the round trips cost about what the stats
  do: tgdl-core is a little slower in wall time but uses under a third of
  the main thread. It fetches up to 1 024 rows' stats per request for that
  reason. On a cold cache, a spinning disk or a network share, where each
  stat waits on the disk, its 16 parallel stats (libuv: 4) are the
  difference.
- DBSCAN defaults to at most 8 workers so a face scan leaves CPU for the
  Telegram engine and dashboard; `TGDL_DBSCAN_WORKERS` tunes it explicitly.
  The result doesn't depend on how many workers are used.
- tgdl-core's working set: 8 MB idle, ~20 MB for the 50 000-file stat
  sweep and walks, 34 MB for DBSCAN 5 000 × 512, 75 MB for 20 000 × 512
  (it holds the 40 MB of embeddings).
- Phase 1 hashing numbers (worker pool vs tgdl-core, 8 in flight): 6.6–7.6
  GB/s for tgdl-core vs 3.1–5.1 GB/s for the pool; see the v2.28.0 docs.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Process lifecycle, packaging; SHA-256 hashing (shadow parity) | **done** — v2.28.0 |
| 2 | tgdl-core required and the only implementation: hashing, integrity stat sweep, folder walks (re-index, disk usage), face-clustering DBSCAN; installed by `npm install`; parity proven by tests | **done** — tgdl-core 0.2.0 |
| 3 | MTProto byte plane — Go streams file bytes from Telegram to disk; Node keeps sessions, the queue and the DB | planned |
| 4 | Backup providers (S3, SFTP, FTP, Google Drive, Dropbox, local) as Go uploaders | planned |
| 5 | Go front server on `PORT`: `/files` and Range streaming, `/photos`, thumbnail cache hits; everything else proxied to Node. Node's own file serving is removed | **done** — tgdl-core 0.4.0 (see [Front server](#front-server-tgdl-core-front)) |
| 6 | Engine (monitor / downloader orchestration) in Go | gated on the earlier phases in production |

Each later phase follows the same rule as phase 2: Node code is removed
only once tests prove the Go path gives identical results.

The end state — the whole backend in Go, no Node at runtime, gated by the
black-box API contract suite in `tests/contract/` — is planned in
[GO-MIGRATION.md](GO-MIGRATION.md).

## Front server (`tgdl-core front`)

tgdl-core owns the app's `PORT`; the Node server listens on
`127.0.0.1:<random>` behind it. Nothing to configure: same port, same
Docker healthcheck, same responses (status, headers, body) as when Node
answered `PORT` itself.

**What it answers itself** — a local file under `/files/…` (any method,
as Express's handler was), an avatar under `/photos/…` and a cached
thumbnail (`/api/thumbs/:id`), for a valid file token or a session cookie,
the dashboard's auth set up, with Force HTTPS on only for a secure request
or one from the machine itself, and (thumbnails) with the `/api` rate limit
off, so the limiter still counts every request. That includes the rare
cases: a session in the last quarter of its lifetime, a missing file
(`404 File not found`), `If-Match` / `If-Unmodified-Since` (`412`), an
unsatisfiable range (`416`, `Content-Range: bytes */<size>`), the error
answers `400` / `403`, and symlinks — followed, but only inside the
allowed roots (`TGDL_CORE_ALLOW_ROOTS`: downloads, photos, thumbnail cache).
Range (single and suffix ranges, `If-Range`), conditional requests,
`Content-Type`, `Content-Disposition` (RFC 5987) follow `send` / Express
exactly; the security and cache headers (HSTS, CSP and the rest of
helmet, `Cache-Control`, `Vary`) are the ones Node's own middlewares
produce, pushed to tgdl-core on every config change — tgdl-core
hardcodes none.

**What Go never does: write the database.** What only Node may do reaches
it as one small call after the answer went out (`POST /__tgdl/notify` on
Node's loopback port, authenticated with the per-spawn token, in a header
clients can't send, and de-duplicated for 30 s):

- `renew` — the session is in the last quarter of its lifetime; Node
  extends it (`renewSession`). The media response carries no `Set-Cookie`;
  the next dashboard request renews the cookie as usual.
- `missing` — Node re-checks, deletes the row and broadcasts `file_deleted`
  (unchanged rules: not when the folder is missing too).

**Everything else goes to Node**, streamed without buffering (bodies of
unknown length flushed as they come, WebSocket upgrades tunnelled byte
for byte, the path and query passed exactly as sent). For media that is
only what needs Node's libraries or secrets: inline HEIC transcoding
(`?inline=1` on `.heic`, sharp — a transform, not file serving),
`_clusterref` / `?peer=` files (the cluster bridge), thumbnail generation
on a cache miss, `/share`, and every request the dashboard's auth refuses
(login redirect, 401, setup). Node no longer has a local `/files` branch,
`/photos` handler, thumbnail cache-hit fast path or `X-Tgdl-Accel`
hand-back.

**Security model**

- Sessions are checked read-only in `web_sessions`
  (`modernc.org/sqlite`, `mode=ro`, `query_only`); renewals, expiry
  deletes and every refusal (401, redirect to the login page, 503 before
  setup) come from Node. File tokens are verified with the share secret,
  which Node sends over the token-gated control channel on `127.0.0.1` —
  never argv or env.
- Client address: tgdl-core passes the client's `X-Forwarded-*` headers
  through untouched and the connecting address in a private header that
  Node accepts only with the per-spawn token and removes before any route
  runs. Express then applies the app's own `trust proxy` (`TRUST_PROXY`,
  default loopback) to the real client, so `req.ip`, the localhost-only
  setup page, Force HTTPS and the rate limits behave exactly as before.
  `X-Tgdl-*` headers sent by a client are dropped.
- Files are served only inside the allowed roots (downloads, photos,
  thumbnail cache); a symlink or junction is followed, one that leaves
  them is refused (`403`).
- Timeouts are Node's: 70 s for request headers, 65 s keep-alive, no
  write timeout (a video streams as long as it plays), 16 KiB of headers.

**When it can't run** — Node restarts it when it exits or fails three
health checks in a row (after 50 ms, then up to 5 s). If it can't be kept
running (binary missing, won't start, 5 exits in a minute) Node binds
`PORT` itself and logs why, and the dashboard banner says so, so the
dashboard and `/api/auth_check` (the healthcheck) keep working. Media
routes then answer `503 TGDL_CORE_UNAVAILABLE` — there is no Node
file-serving fallback. A port
already in use is fatal with the same message as before.

**Watching it** — `GET /api/system/health?front=1` → `goCoreFront`:
state, pid, restarts, and counters (answered itself per kind, proxied,
WebSockets, bytes, errors).

**Parity gates** — the API contract suite (`npm run test:contract`) runs
through the front server; `tests/front-parity.e2e.test.js` replays 115
frozen v2.28 responses (Range, 304 / 412 / 416, HEAD, tokens, guests,
renewals, HEIC, thumbnails, static assets with compression, WebSockets; seven cases were re-recorded when Go took over the rare ones, see the fixture's `note`); `tests/front-security.e2e.test.js`
compares the security behaviour with Node alone (trust proxy variants,
`/api/auth/setup` local-only, forged private headers, forceHttps, rate
limits, file tokens); the Go unit tests check the ports of `range-parser`,
`fresh`, `send`'s MIME table, `trust proxy`, `qs` and the cookie parser
against answers recorded from the Node libraries
(`core-service/internal/front/testdata/conformance.json`).

### Measured (front server)

`node scripts/bench-front.js --size-mb 512 --requests 200`, i9-13900K /
Windows 11 / Node 22, warm page cache, one run. "Busy" = Node's event
loop blocked 450 ms out of every 500 ms (a CPU burn preloaded into the
server), requests sent open-loop every 25 ms.

| | Node on PORT (before 0.4; measured on 2.30) | tgdl-core front |
|---|---|---|
| Video, 4 MiB ranges, 1 client | 264 MB/s | 599 MB/s |
| Video, 4 MiB ranges, 4 clients | 696 MB/s | 1,883 MB/s |
| Video, 1 client, Node busy | 47 MB/s | 651 MB/s |
| TTFB `/files` 64 KiB range, p50 / p99 | 1.6 / 8.3 ms | 0.9 / 2.2 ms |
| TTFB thumbnail hit, p50 / p99 | 2.0 / 6.2 ms | 0.6 / 1.9 ms |
| TTFB `/files`, Node busy, p50 / p99 | 219 / 452 ms | 1.2 / 4.9 ms |
| TTFB thumbnail hit, Node busy, p50 / p99 | 210 / 455 ms | 1.1 / 2.3 ms |
| RSS idle | Node 119 MB | Node 119 MB + tgdl-core 11 MB |
| RSS after the throughput runs | Node 155 MB | Node 90 MB + tgdl-core 20 MB |
