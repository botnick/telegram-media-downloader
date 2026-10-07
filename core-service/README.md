# core-service (`tgdl-core`)

The Go engine of
[telegram-media-downloader](https://github.com/botnick/telegram-media-downloader).
The Node app spawns it, talks to it over HTTP on `127.0.0.1`, and relies on
it for:

| Feature (`/health.features`) | Route | Used by |
|---|---|---|
| `hash` | `POST /v1/hash` | download-time dedup, the duplicate scan, the NSFW hash blocklist |
| `stat` | `POST /v1/fs/stat-batch` | the integrity sweep (Verify files, boot + hourly) |
| `walk` | `POST /v1/fs/walk` | Re-index from disk, the disk-usage fallback of `/api/stats` |
| `remove-tree` | `POST /v1/fs/remove-tree` | Group-folder cleanup while preserving shared physical files (optional; Node fallback) |
| `dbscan` | `POST /v1/dbscan` | face clustering (scan runner Phase B) |
| `zip` | `POST /v1/zip` | STORE-mode bulk ZIP streaming (optional; old binaries fall back to Node) |
| `faststart` | `POST /v1/faststart` | MP4 `moov` relocation with bounded ffmpeg workers (optional; old binaries fall back to Node) |
| `thumb` | `POST /v1/thumb/{video,image,audio}` | Media decode/scale/WebP thumbnail generation with bounded ffmpeg workers (optional; old binaries fall back to Node) |
| `seekbar` | `POST /v1/seekbar` | Video sampling, tiling and sprite encode with bounded ffmpeg workers (optional; old binaries fall back to Node) |
| `db` | `POST /v1/db/group-aggregates`, `/v1/db/stats`, `/v1/db/group-stats`, `/v1/db/group-files`, `/v1/db/downloads/all`, `/v1/db/downloads/group`, `/v1/db/downloads/by-ids`, `/v1/db/downloads/search`, `/v1/db/share-links`, `/v1/db/update-history`, `/v1/db/nsfw-tiers`, `/v1/db/nsfw-histogram`, `/v1/db/nsfw-list`, `/v1/db/nsfw-candidates`, `/v1/db/people`, `/v1/db/thumbs-list`, `/v1/db/seekbar-list`, `/v1/db/faces-by-download`, `/v1/db/person-groups`, `/v1/db/person-photos`, `/v1/db/ai-counts`, `/v1/db/ai-candidates`, `/v1/db/recovery-stats`, `/v1/db/cluster-downloads`, `/v1/db/cluster-downloads-since`, `/v1/db/cluster-search`, `/v1/db/telegram-media-candidates`, `/v1/db/file-hash-candidates`, `/v1/db/file-name-candidates`, `/v1/db/seekbar-candidates`, `/v1/db/faststart-candidates`, `/v1/db/integrity-candidates`, `/v1/db/dedup-candidates`, `/v1/db/dedup-groups`, `/v1/db/dedup-files` | Read-only SQLite dashboard projections (optional; Node falls back to its local queries) |

A second process of the same binary, `tgdl-core front`, serves the app's
`PORT` ([Front server](#front-server-front)).

For the required file and clustering features it is the only implementation;
optional features are used when advertised and retain a Node compatibility path.
The required answers remain identical to Node: same digests, the same
`fs.stat` / `fs.readdir` results and error codes, the same clusters. See
[docs/GO-CORE.md](../docs/GO-CORE.md) for how that is proven and what the
app does when tgdl-core can't run.

tgdl-core never writes `db.sqlite` (Node is the only writer; the front
server reads `web_sessions` over a read-only connection). It reads media
inside the directories the app allows (`TGDL_CORE_ALLOW_ROOTS`) and writes
video-thumbnail and seekbar temporary output only beneath the configured cache roots.

## Commands

```
tgdl-core serve               run the HTTP service (settings from env, below)
tgdl-core front               run the front server on the app's PORT (env, below)
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
| `TGDL_CORE_ALLOW_ROOTS` | empty = refuse everything | Directories files may be read from and thumbnail/seekbar output may be written to, separated like `PATH` (`:` on Linux / macOS, `;` on Windows; quote an entry containing `;` on Windows). The app passes its download directories and `<data dir>/thumbs` + `<data dir>/seekbar`, plus anything in its own `TGDL_CORE_ALLOW_ROOTS`. Anything else is refused with `EOUTSIDE` and the app handles that path itself. |
| `TGDL_CORE_DB` | unset | Absolute `db.sqlite` path for the read-only aggregate projection. The Node parent remains the only writer. |
| `TGDL_CORE_PORT` | `0` | Port on `127.0.0.1`; `0` picks a free one. The bound address is printed as one JSON line on stdout: `{"event":"listening","addr":"127.0.0.1:NNNNN","version":"0.4.0","pid":123}`. |
| `TGDL_CORE_WATCH_STDIN` | off | `1`: exit when stdin reaches EOF. The app keeps the pipe open, so when the app dies (crash, `kill -9`, Task Manager) tgdl-core exits instead of lingering as an orphan — Windows doesn't reap children with their parent. |
| `HASH_WORKER_POOL_SIZE` | `min(8, max(2, ⌊cpus/2⌋))` | Files hashed at once (`parseInt`, values ≥ 1 capped at 32). |
| `TGDL_DBSCAN_WORKERS` | `min(8, NumCPU-1)` | DBSCAN workers; set a positive integer to tune CPU use for a large face scan. |
| `FASTSTART_CONCURRENCY` | `2` (max `8`) | Concurrent MP4 faststart remuxes. Keep this low on HDD/NAS storage. |
| `FFMPEG_PATH` | `ffmpeg` on `PATH` | Optional absolute ffmpeg executable path used by faststart and thumbnail workers. |
| `THUMBS_IMG_CONCURRENCY` | `4` (max `32`) | Concurrent image and audio thumbnail jobs in tgdl-core. Keep this below the number of cores available to the Telegram engine. |
| `THUMBS_VID_CONCURRENCY` | `6` (max `16`) | Concurrent video thumbnail jobs in tgdl-core. Keep this below the number of cores available to the Telegram engine. |
| `SEEKBAR_CONCURRENCY` | `2` (max `8`) | Concurrent video sprite encodes in tgdl-core. Keep this low on HDD/NAS storage. |
| `TGDL_CORE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`, to stderr. |

## Front server (`front`)

`tgdl-core front` serves the app's public `PORT`: local media from
`/files`, `/photos` and the thumbnail cache itself, everything else
proxied to the Node server on `127.0.0.1` (see
[docs/GO-CORE.md](../docs/GO-CORE.md#front-server-tgdl-core-front)). Code in
`internal/front`. The app starts it with these (never argv):

| Variable | Meaning |
|---|---|
| `TGDL_CORE_TOKEN` | Control-channel token (`X-API-Token`), required. |
| `TGDL_FRONT_LISTEN` | Public address, `:<PORT>`. Can't bind → exit status 3 and `{"event":"error","code":"EADDRINUSE",…}` on stdout. |
| `TGDL_FRONT_UPSTREAM` | The Node server, `127.0.0.1:<port>` (loopback only). |
| `TGDL_FRONT_UPSTREAM_TOKEN` | Sent to Node as `X-Tgdl-Front` with the client's address; Node trusts that address only with this token. The same token authenticates the events Go posts to Node afterwards (`X-Tgdl-Notify`: session renewal, a missing file to prune) — Go never writes the database. |
| `TGDL_FRONT_TRUST_PROXY` | The app's Express `trust proxy` value (`TRUST_PROXY`, default `loopback`). |
| `TGDL_FRONT_DB` | `db.sqlite`, opened read-only for `web_sessions`. |
| `TGDL_FRONT_DOWNLOADS_DIR`, `TGDL_FRONT_PHOTOS_DIR`, `TGDL_FRONT_THUMBS_DIR` | What `/files`, `/photos` and `/api/thumbs/:id` resolve against. |
| `TGDL_CORE_ALLOW_ROOTS` | Every file served must be inside one of these. |
| `TGDL_CORE_PORT`, `TGDL_CORE_WATCH_STDIN`, `TGDL_CORE_LOG_LEVEL` | As for `serve`. |

Control channel (`127.0.0.1:<TGDL_CORE_PORT>`, `X-API-Token`):
`GET /health`, `POST /v1/front/state` (Node pushes the share secret,
whether auth is set up, Force HTTPS, the `/api` rate-limit switch and the
response headers its middlewares produce for each fast-path route — on
boot and on every config change, re-checked every 2 s), `GET
/v1/front/stats`.

## HTTP API

Errors are `{"error":{"code":"ENOENT","message":"…"}}`.

| Route | Auth | |
|---|---|---|
| `GET /health` | open | `{ok, service:"tgdl-core", version, features:["hash","hash-batch","tar-gz","stat","walk","remove-tree","dbscan","zip","faststart","thumb","seekbar","db"], pid, go, platform, hash:{concurrency, roots}, fs:{maxBatch, fastStat}}` (`roots` is a count) |
| `POST /v1/hash` | token | Body `{"path":"/abs/file"}` → `{"sha256","size","mtimeMs"}` |
| `POST /v1/fs/stat-batch` | token | Body `{"paths":["/abs/a", …]}` (≤ 1000) → `{"results":[…]}`, see below |
| `POST /v1/fs/walk` | token | Body `{"root","maxDepth","stat","entries"}` → NDJSON stream, see below |
| `POST /v1/fs/remove-tree` | token | Body `{"root":"/abs/dir","keep":["/abs/file", …]}` → `{kept,removed}`; removes unkept files and leaves non-empty directories |
| `POST /v1/dbscan` | token | Query `n, dim, eps, minPts, weights=0|1`, binary body → NDJSON stream, see below |
| `POST /v1/zip` | token | JSON `{entries:[{path,name}]}` → streamed STORE-mode ZIP; paths are rechecked against allow-roots |
| `POST /v1/faststart` | token | JSON `{"path":"/abs/file.mp4"}` → `{status:"already"|"optimized",newSize?}`; writes atomically inside an allow-root |
| `POST /v1/thumb/{video,image,audio}` | token | JSON `{"path":"/abs/media","output":"/abs/thumb.tmp","width":320}` → `{status:"ok",size}`; output must be inside an allow-root |
| `POST /v1/seekbar` | token | JSON `{"path":"/abs/video","output":"/abs/sprite.tmp","frames":120,"intervalSec":4,"cols":10,"rows":12,"tileWidth":160,"format":"webp","quality":75}` → `{status:"ok",size}`; output must be inside an allow-root |
| `POST /v1/db/group-aggregates` | token | JSON `{}` → `{rows:[{group_id,best_name,any_name,count,size}]}` from a query-only `db.sqlite` connection |
| `POST /v1/db/stats` | token | JSON `{}` → `{totalFiles,totalSize}` from a query-only `db.sqlite` connection |
| `POST /v1/db/group-stats` | token | JSON `{"groupId":"…"}` → per-group counts, type totals and message timestamps |
| `POST /v1/db/group-files` | token | JSON `{"groupId":"…","limit":50,"offset":0,"type":"video"}` → paginated file rows |
| `POST /v1/db/downloads/all` | token | JSON `{"limit":50,"offset":0,"type":"images","pinnedOnly":false,"pinnedFirst":false}` → local gallery page |
| `POST /v1/db/downloads/group` | token | JSON `{"groupId":"…","limit":50,"offset":0,"type":"videos","pinnedOnly":false,"pinnedFirst":false}` → local group gallery page |
| `POST /v1/db/downloads/by-ids` | token | JSON `{"ids":[1,2]}` → bounded download rows for bulk file operations |
| `POST /v1/db/downloads/search` | token | JSON `{"query":"IMG","limit":50,"offset":0,"groupId":"…","type":"images","pinnedOnly":false,"pinnedFirst":false,"order":"relevance"}` → local FTS/LIKE page |
| `POST /v1/db/share-links` | token | JSON `{"downloadId":1,"includeRevoked":true,"limit":500,"offset":0,"search":"IMG"}` → joined local share-link page |
| `POST /v1/db/update-history` | token | JSON `{"limit":25}` → newest update audit rows |
| `POST /v1/db/nsfw-tiers` | token | JSON `{"fileTypes":["photo"]}` → tier/scanned/whitelist counters |
| `POST /v1/db/nsfw-histogram` | token | JSON `{"fileTypes":["photo"],"bins":20}` → dense score histogram |
| `POST /v1/db/nsfw-list` | token | JSON `{"fileTypes":["photo"],"tier":"def_not","page":1,"limit":50}` → paginated scored rows |
| `POST /v1/db/nsfw-candidates` | token | JSON `{"fileTypes":["photo"],"limit":50}` → bounded unscanned rows |
| `POST /v1/db/people` | token | JSON `{"limit":100,"offset":0,"sort":"face_count","dir":"desc"}` → local people page |
| `POST /v1/db/thumbs-list` | token | JSON `{"limit":60,"cursor":0,"kind":"all","cachedOnly":false,"cacheRoot":"/abs/data/thumbs"}` → thumbnail maintenance page |
| `POST /v1/db/seekbar-list` | token | JSON `{"limit":50,"offset":0}` → seekbar sprite catalog |
| `POST /v1/db/faces-by-download` | token | JSON `{"downloadId":123}` → face boxes and optional person labels |
| `POST /v1/db/person-groups` | token | JSON `{"limit":50}` → compact people grouping |
| `POST /v1/db/person-photos` | token | JSON `{"personId":1,"limit":50,"offset":0}` → person gallery page |
| `POST /v1/db/ai-counts` | token | JSON `{"fileTypes":["photo"]}` → AI maintenance counters |
| `POST /v1/db/ai-candidates` | token | JSON `{"fileTypes":["photo"],"limit":50}` → bounded unindexed AI rows |
| `POST /v1/db/recovery-stats` | token | empty JSON body → grouped recovery counters |
| `POST /v1/db/cluster-downloads` | token | JSON `{"limit":200,"offset":0}` → local catalog page rows |
| `POST /v1/db/cluster-downloads-since` | token | JSON `{"sinceId":0,"limit":500}` → local catalog delta rows |
| `POST /v1/db/cluster-search` | token | JSON `{"query":"…","limit":50}` → local catalog search rows |
| `POST /v1/db/telegram-media-candidates` | token | JSON `{"kind":"document","id":"…","size":123}` → bounded dedup candidates |
| `POST /v1/db/file-hash-candidates` | token | JSON `{"hash":"…","size":123}` → first content-dedup candidate |
| `POST /v1/db/file-name-candidates` | token | JSON `{"groupId":"…","fileName":"…","size":123}` → first filename/size candidate |
| `POST /v1/db/seekbar-candidates` | token | JSON `{"beforeId":123, "limit":200}` → keyset-paged videos without sprites |
| `POST /v1/db/faststart-candidates` | token | JSON `{"beforeId":123, "limit":50}` → keyset-paged catalogued videos |
| `POST /v1/db/integrity-candidates` | token | JSON `{"beforeId":123, "limit":64}` → keyset-paged local file rows |
| `POST /v1/db/dedup-candidates` | token | JSON `{"beforeId":123, "limit":200}` → keyset-paged unhashed files |
| `POST /v1/db/dedup-groups` | token | JSON `{"afterHash":"…", "limit":5000}` → keyset-paged hash groups |
| `POST /v1/db/dedup-files` | token | JSON `{"hashes":["…"]}` → batched duplicate file details |
| `GET /v1/stats` | token | Counters: `{uptimeSec, hash:{…}, fs:{statCalls, statPaths, walks, walkFiles}}` |

### `/v1/hash`

| Status | Codes | Meaning |
|---|---|---|
| 200 | — | Digest of the whole file, read until EOF (identical to `crypto.createHash('sha256')` over `fs.createReadStream`). |
| 400 | `EINVAL` | Bad body, empty or relative path, NUL byte. |
| 401 | `EAUTH` | Missing / wrong token (also for unknown routes). |
| 403 | `EOUTSIDE` | Not inside an allowed root, as written or after resolving symlinks / junctions. |
| 422 | `ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`, `EMFILE`, `EBUSY`, `EIO` | The file can't be read. |
| 503 | `EQUEUEFULL` | More than 1024 requests waiting for a hash slot. |

### `/v1/fs/stat-batch` — `fs.stat`, exactly

Each result is `{"ok":true,"size":N,"mtimeMs":F,"isFile":B,"isDir":B}` or
`{"code":"…"}`, in request order. `code` is what Node's `fs.stat` puts in
`err.code` for the same path on the same OS — `src/core/integrity.js`
deletes a library row on `ENOENT` / `ENOTDIR` and on nothing else, so this
is the part that must never be wrong:

- **Windows**: the same calls in the same order as libuv 1.51
  (`fs__stat_impl_from_path`): `GetFileInformationByName` when the OS has
  it (found the way libuv finds it), else / then `CreateFileW` with
  `FILE_READ_ATTRIBUTES` + `NtQueryVolumeInformationFile` /
  `NtQueryInformationFile`, and on access-denied / sharing-violation the
  parent directory listing (`fs__stat_directory`) — on the `\\?\` path
  Node builds. The Win32 error is named by `uverr_windows.go`, generated
  from libuv's `uv_translate_sys_error` (all 100 cases; anything else is
  `UNKNOWN`). Directories report size 0, like libuv. `mtimeMs` reproduces
  Node's 32-bit `tv_sec` on Windows, including its wrap for dates before
  1970. Go's own `os.Stat` is not used: it reports an offline network
  share (`ERROR_BAD_NETPATH`) as "does not exist", which libuv — and so
  Node — reports as `UNKNOWN`.
- **Linux / macOS**: `lstat` then `stat` for links, `errno` named from
  libuv's `UV_ERRNO_MAP` (`ESTALE` and anything else outside it is
  `UNKNOWN`, as in Node).
- `EOUTSIDE`: the path (as written, its parent folder with links resolved,
  or the link itself) is outside the allowed roots. Paths with a NUL byte
  get `ERR_INVALID_ARG_VALUE`, relative ones `EINVAL`.

`tests/gocore-fs.errors.test.js` compares every situation it can set up on
the OS it runs on against Node's own `fs.stat`, live.

### `/v1/fs/walk` — recursive `fs.readdir(…, {withFileTypes})` (+ `fs.stat`)

Request: `root` (absolute, inside a root), `maxDepth` (entries of the root
are depth 1; directories at `maxDepth` are listed, not entered; `0` = no
limit), `stat` (`none` | `files`: entries that are files | `nondir`: every
entry that is not a directory, following links), `entries` (default `true`;
`false` sends only the summary). Streams one JSON object per line, in the
order a recursive Node walk visits them — depth first, pre-order, each
directory in libuv's order (file-system order on Windows, `strcmp` order
elsewhere):

```
{"t":"d","p":"group/images"}                                   a directory entry
{"t":"f","p":"group/images/a.jpg","k":"file","ok":true,"size":N,"mtimeMs":F,"isFile":true,"isDir":false}
{"t":"f","p":"group/link","k":"link","code":"EOUTSIDE"}        any other entry (k: file|link|char|…)
{"t":"e","p":"group/locked","code":"EACCES"}                   a directory that could not be listed ("" = root)
{"t":"end","dirs":N,"files":N,"errors":N,"stated":N,"bytes":N,"outside":["group/link"]}
```

`p` is relative to the root with `/` separators; names are what Node would
see (invalid UTF-8 / lone UTF-16 surrogates as U+FFFD). Links are entries,
never entered. `bytes` sums the stat'ed entries that are files. A stream
without an `end` line was cut off.

### `/v1/dbscan` — face clustering

Query `n` (≤ 524 288), `dim` (≤ 4 096, n × dim ≤ 2²⁸), `eps`, `minPts`,
`weights=1` when per-face float64 weights follow the n × dim float32
embeddings in the body (little endian). Over those limits: 413 `EINVAL`;
bad parameters or a body that is not exactly the size they call for: 400
`EINVAL`, both before anything is allocated. One clustering runs at a time (4 may wait; more → 503
`EQUEUEFULL`). The answer streams `{"t":"progress","done":D,"n":N}` about
once a second, then
`{"t":"result","count":C,"noiseCount":K,"starts":b64,"members":b64,"centroids":b64}`
— int32 / int32 / float32, the packing of the old Node cluster worker —
or `{"t":"error",…}`. It is a line-by-line port of
`src/core/ai/dbscan.js`: the same visit order and queue, float64 sums in
dimension order with no fused multiply-add, the same `_rejectBound` early
exit, Float32 centroid arithmetic. Neighbour lists are computed on all
cores ahead of use and consumed in the exact sequential order, so the
result does not depend on the number of cores. A client that disconnects
stops the work.

## Implementation notes

- Containment (`internal/hash/roots.go`): checked as written first (a path
  outside every root is refused without touching the file system), then
  with links resolved — for hashing via `filepath.EvalSymlinks`, for stats
  per directory (a plain directory under an inside directory is inside;
  only a link costs a full resolution; verdicts are reused for 2 s). Each
  check is `filepath.Rel` + `filepath.IsLocal` (UNC share roots compared
  without a trailing separator: `filepath.Rel` never returns for that
  pair). Residual race: someone who can write inside a root could swap a
  directory for a link between the check and the read; that needs write
  access to the downloads folder, which is already the app's own data.
- Windows files are opened with `FILE_SHARE_DELETE` and the `\\?\`
  prefix, like libuv: the app can delete or rename a file while tgdl-core
  reads it, and paths over 260 characters work.
- No `WriteTimeout`: a multi-GB hash or a 50 k-face clustering
  legitimately takes minutes; the client's deadline cancels the request
  context instead.

## Build

```bash
npm run build:core                  # host binary → core-service/bin/tgdl-core-<slug>(.exe)
npm run build:core -- --release     # all targets → core-service/dist/*.tar.gz + SHA256SUMS
npm run install:core                # what `npm install` runs: download, else build, else explain
cd core-service && go vet ./... && go test ./...
```

`npm test` builds tgdl-core from this tree (Go on PATH; cached by a hash of
the sources) and runs every suite against it — including the Node-vs-Go
parity suites (`tests/gocore-*.test.js`).

Go 1.22+ (CI and releases use 1.25). CGO is off, so every target
cross-compiles from any host:

| Slug | GOOS/GOARCH |
|---|---|
| `win-x64` | windows/amd64 |
| `win-arm64` | windows/arm64 |
| `linux-x64` | linux/amd64 |
| `linux-arm64` | linux/arm64 |
| `linux-arm` | linux/arm, GOARM=7 (Raspberry Pi 2+, 32-bit ARM NAS) |
| `linux-x86` | linux/386 (Synology DSM x86, older NAS) |
| `mac-arm64` | darwin/arm64 |
| `mac-x64` | darwin/amd64 |

Other hosts (32-bit Windows, ARMv6, FreeBSD, …) get no binary: build one
with Go and point `TGDL_CORE_BIN` at it.

## How the app finds it

`src/core/gocore/spawn.js`, first hit wins:

1. `TGDL_CORE_BIN` — an explicit path; when set, nothing else is tried.
2. `/app/bin/tgdl-core` — built into the Docker image.
3. `core-service/bin/tgdl-core-<slug>` — `npm run build:core`, used only
   when it reports the pinned version.
4. `data/core-service/bin/tgdl-core-<slug>` — `npm install`
   (`scripts/install-core.js`) or the app itself at startup downloads the
   GitHub release `core-v<CORE_VERSION>` (`tgdl-core-<slug>.tar.gz`),
   verified against the release's `SHA256SUMS`, with a `.version` marker so
   a `CORE_VERSION` bump fetches the new build. `TGDL_CORE_RELEASE_URL`
   overrides the release URL (mirrors, air-gapped installs).

## Releasing

1. Bump `Version` in `internal/version/version.go` and `CORE_VERSION` in
   `src/core/gocore/spawn.js` together (a test checks they match), and
   add a line to `CHANGELOG.md` below.
2. Push the tag `core-v<version>`. `.github/workflows/release-core-service.yml`
   checks the tag against `CORE_VERSION`, runs the Go tests, builds the
   eight tarballs + `SHA256SUMS`, smoke-runs the Linux binary and attaches
   it all to the release (never marked Latest).
3. Only then release an app version that pins it.

## Changelog

- **0.4.0** — `front` answers the rare cases itself: 412 / 416 / ranges,
  symlinks inside `TGDL_CORE_ALLOW_ROOTS`, a missing file (404) and a session
  due for renewal. Node is told afterwards (it alone writes the database);
  the `X-Tgdl-Accel` hand-back is gone.
- **0.3.0** — `front`: the app's front server on `PORT` — `/files`,
  `/photos` and cached thumbnails served from Go, everything else proxied
  to the Node server ([Front server](#front-server-front)).
- **0.2.0** — `stat` (`/v1/fs/stat-batch`), `walk` (`/v1/fs/walk`) and
  `dbscan` (`/v1/dbscan`); builds for `linux-arm` (ARMv7) and `mac-x64`;
  containment no longer hangs on a UNC share root and no longer re-resolves
  missing roots on every request.
- **0.1.0** — `hash` (`/v1/hash`).
