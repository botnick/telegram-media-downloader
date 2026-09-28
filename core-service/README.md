# core-service (`tgdl-core`)

The Go companion process of
[telegram-media-downloader](https://github.com/botnick/telegram-media-downloader).
The Node app spawns it, talks to it over HTTP on `127.0.0.1`, and moves
CPU- and I/O-heavy work into it one feature at a time. Phase 1 ships one
feature: SHA-256 file hashing. See [docs/GO-CORE.md](../docs/GO-CORE.md)
for the plan and the rules every feature follows.

Nothing here is required. If the binary is missing, can't be downloaded,
crashes or answers wrong, the app does exactly what it did before (the
Node worker pool). tgdl-core never opens `db.sqlite`.

## Commands

```
tgdl-core serve               run the HTTP service (settings from env, below)
tgdl-core version             print "tgdl-core <version> <os>/<arch> <go version>"
tgdl-core hash [--json] <path>...
                              print SHA-256 digests like sha256sum (debugging)
```

## Environment (`serve`)

The Node app passes only these (never argv, so the token doesn't show up
in `ps`), plus the few OS variables a Go binary needs (`PATH`,
`SystemRoot`, temp dirs, `GOMAXPROCS`/`GOMEMLIMIT`/`GOGC` if you set them).

| Variable | Default | Meaning |
|---|---|---|
| `TGDL_CORE_TOKEN` | — (required) | Shared secret; every route except `/health` needs it as `X-API-Token`. The app mints a new one per spawn. |
| `TGDL_CORE_PORT` | `0` | Port on `127.0.0.1`; `0` picks a free one. The bound address is printed as one JSON line on stdout: `{"event":"listening","addr":"127.0.0.1:NNNNN","version":"0.1.0","pid":123}`. |
| `TGDL_CORE_WATCH_STDIN` | off | `1`: exit when stdin reaches EOF. The app keeps the pipe open, so when the app dies (crash, `kill -9`, Task Manager) tgdl-core exits instead of lingering as an orphan — Windows doesn't reap children with their parent. |
| `HASH_WORKER_POOL_SIZE` | `min(8, max(2, ⌊cpus/2⌋))` | Files hashed at once. Same parsing as the Node worker pool (`parseInt`, values ≥ 1 capped at 32). |
| `TGDL_CORE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`, to stderr. |

## HTTP API

All responses are JSON. Errors are `{"error":{"code":"ENOENT","message":"…"}}`.

| Route | Auth | |
|---|---|---|
| `GET /health` | open | `{ok, service:"tgdl-core", version, features:["hash"], pid, go, platform, hash:{concurrency}}` |
| `POST /v1/hash` | token | Body `{"path":"/absolute/file"}` → `{"sha256":"<64 lowercase hex>","size":<bytes hashed>,"mtimeMs":<float>}` |
| `GET /v1/stats` | token | Counters: `{uptimeSec, hash:{concurrency, inFlight, waiting, completed, failed, bytes}}` |

`/v1/hash` status codes:

| Status | Codes | Meaning |
|---|---|---|
| 200 | — | Digest of the whole file, read until EOF (identical to Node's `crypto.createHash('sha256')` over `fs.createReadStream`). |
| 400 | `EINVAL` | Bad body, empty or relative path, NUL byte. |
| 401 | `EAUTH` | Missing / wrong token (also for unknown routes). |
| 422 | `ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`, `EMFILE`, `EBUSY`, `EIO` | The file can't be read — the codes Node reports for the same failure on the same OS. |
| 503 | `EQUEUEFULL` | More than 1024 requests waiting for a hash slot. |

Implementation notes:

- Streams with a 1 MiB buffer; the request context is checked between
  reads, so a caller that times out or disconnects stops the read and
  frees its slot.
- On Windows files are opened with `FILE_SHARE_DELETE` and the `\\?\`
  prefix, like libuv does for Node: the app can delete or rename a file
  while tgdl-core reads it (download-time dedup unlinks a fresh duplicate
  right after hashing), and paths over 260 characters work.
- No `WriteTimeout`: a multi-GB hash legitimately takes minutes; the
  client's deadline is what bounds it.

## Build

```bash
npm run build:core                  # host binary → core-service/bin/tgdl-core-<slug>(.exe)
npm run build:core -- --release     # all targets → core-service/dist/*.tar.gz + SHA256SUMS
cd core-service && go vet ./... && go test ./...
```

Go 1.22+ (CI and releases use 1.25). CGO is off, so every target
cross-compiles from any host:

| Slug | GOOS/GOARCH |
|---|---|
| `win-x64` | windows/amd64 |
| `win-arm64` | windows/arm64 |
| `linux-x64` | linux/amd64 |
| `linux-arm64` | linux/arm64 |
| `linux-x86` | linux/386 (Synology DSM x86, older NAS) |
| `mac-arm64` | darwin/arm64 |

Other hosts (macOS on Intel, 32-bit Windows, FreeBSD, …) get no binary
and keep using Node; `TGDL_CORE_BIN` can point at a hand-built one.

## How the app finds it

`src/core/gocore/spawn.js`, first hit wins:

1. `TGDL_CORE_BIN` — an explicit path; when set, nothing else is tried.
2. `/app/bin/tgdl-core` — built into the Docker image.
3. `core-service/bin/tgdl-core-<slug>` — `npm run build:core`.
4. `data/core-service/bin/tgdl-core-<slug>` — downloaded from the GitHub
   release `core-v<CORE_VERSION>` (`tgdl-core-<slug>.tar.gz`), verified
   against the release's `SHA256SUMS`, with a `.version` marker so a
   `CORE_VERSION` bump fetches the new build. `TGDL_CORE_RELEASE_URL`
   overrides the release URL (mirrors, air-gapped installs).

## Releasing

1. Bump `Version` in `internal/version/version.go` and `CORE_VERSION` in
   `src/core/gocore/spawn.js` together (a test checks they match).
2. Push the tag `core-v<version>`. `.github/workflows/release-core-service.yml`
   checks the tag against `CORE_VERSION`, runs the Go tests, builds the six
   tarballs + `SHA256SUMS`, smoke-runs the Linux binary and attaches it all
   to the release (never marked Latest).
3. Only then release an app version that pins it.
