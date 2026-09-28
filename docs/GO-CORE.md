# Go core (`tgdl-core`)

`tgdl-core` (source: [`core-service/`](../core-service/README.md)) is the
app's Go engine. The Node app starts it, talks to it over HTTP on
`127.0.0.1`, and relies on it for the work that used to block or burden
Node's single thread:

| What | Where it's used | tgdl-core route |
|---|---|---|
| SHA-256 of a file | download-time duplicate check, Find duplicates, NSFW hash blocklist | `POST /v1/hash` |
| `fs.stat` of many files | Verify files, the boot and hourly integrity sweep | `POST /v1/fs/stat-batch` |
| recursive `fs.readdir` + `fs.stat` | Re-index from disk, the disk-usage figure while the library is empty | `POST /v1/fs/walk` |
| DBSCAN over face embeddings | face scan, Re-cluster | `POST /v1/dbscan` |

It is the **only** implementation of these. The Node code it replaced (the
hash worker pool, the `Promise.all(fs.stat)` sweep, the recursive folder
walks, the DBSCAN worker) is removed; Node keeps thin client calls.

## Rules

1. **Node is the single DB writer.** tgdl-core never opens `db.sqlite`.
   It answers questions; Node decides what to store, prune or fix — every
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
4. **Only the app's media folders.** The app passes its download folders
   as `TGDL_CORE_ALLOW_ROOTS`; a path outside them (as written or after
   resolving links) gets `EOUTSIDE` and Node answers that one path with
   plain `fs` — so the result is still exactly what `fs` says. No roots =
   nothing is read.
5. **Can't outlive the app.** It exits when its stdin pipe closes, binds
   `127.0.0.1` only, and needs a per-spawn token for everything but
   `/health`.
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
[core-service/README.md](../core-service/README.md#how-the-app-finds-it).

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

`TGDL_GO_CORE`, `TGDL_GO_FEATURES`, `config.advanced.goCore` and
`HASH_WORKER_DISABLE` from earlier versions are ignored (a one-line note in
the log if set).

## Watching it

- `GET /api/system/health` → `goCore`: `state` (`running`, `starting`,
  `downloading`, `binary_missing`, `unsupported`, `exited`, `unhealthy`,
  `stopped`), `problem` (`{message, fix}` or null), `version` /
  `expectedVersion`, `platform`, `binary` (path + source), `allowRoots`,
  `restarts`, `features.<hash|stat|walk|dbscan>.available`.
- `GET /api/monitor/status` → `core`: `{state, fix}` while someone needs to
  act (drives the banner; no local paths).
- `/metrics`: `tgdl_gocore_calls_total{feature,result}` — `feature` is
  `hash` / `stat` / `walk` / `dbscan`, `result` is `ok`, `file_error`,
  `outside`, `timeout` or `error`.

## Parity

Every test run builds tgdl-core from the same commit and checks it against
the Node code it replaced and against Node itself:

| Suite | Checks |
|---|---|
| `tests/gocore-fs.errors.test.js` | **Safety-critical.** Every situation the OS lets it set up — missing file / folder, a file used as a folder, trailing dot / space, reserved characters and names, 255 / 256-char names, paths over 260 and over 32 767 chars, links in / out / dangling / looping, ACL-denied files and folders, a file locked by another process, pre-1970 and post-2038 timestamps, and on Windows `pagefile.sys`, a missing drive, an offline share, an app-execution alias — answered by `stat-batch` and by Node's own `fs.stat`, live: identical, or `EOUTSIDE` for the few the app then answers itself; the app-side result is identical in every case. |
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
- DBSCAN uses every core but one; the result doesn't depend on how many.
- tgdl-core's working set: 8 MB idle, ~20 MB for the 50 000-file stat
  sweep and walks, 34 MB for DBSCAN 5 000 × 512, 75 MB for 20 000 × 512
  (it holds the 40 MB of embeddings).
- Phase 1 hashing numbers (worker pool vs tgdl-core, 8 in flight): 6.6–7.6
  GB/s for tgdl-core vs 3.1–5.1 GB/s for the pool; see the v2.28.0 docs.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Process lifecycle, packaging; SHA-256 hashing (shadow parity) | **done** — v2.28.0 |
| 2 | tgdl-core required and the only implementation: hashing, integrity stat sweep, folder walks (re-index, disk usage), face-clustering DBSCAN; installed by `npm install`; parity proven by tests | **this release** (tgdl-core 0.2.0) |
| 3 | MTProto byte plane — Go streams file bytes from Telegram to disk; Node keeps sessions, the queue and the DB | planned |
| 4 | Backup providers (S3, SFTP, FTP, Google Drive, Dropbox, local) as Go uploaders | planned |
| 5 | Go front server for static files, `/files` and Range streaming, proxying the API to Node | in progress (separate branch) |
| 6 | Engine (monitor / downloader orchestration) in Go | gated on the earlier phases in production |

Each later phase follows the same rule as phase 2: Node code is removed
only once tests prove the Go path gives identical results.
