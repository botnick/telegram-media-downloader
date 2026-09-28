# API contract suite

A black-box record of what the backend answers today: every HTTP route
and every WebSocket event, captured from the Node server against a
deterministic seed and committed as golden snapshots. It is the gate for
the move to Go ([docs/GO-MIGRATION.md](../../docs/GO-MIGRATION.md)): a
domain switches to Go only when these files pass with `CONTRACT_TARGET=go`.

## Running

```
npm run test:contract                 # compare against the goldens (Node target)
npm run test:contract:update          # re-record the goldens from Node, then run the checker
node scripts/contract-run.mjs --update files share   # re-record only matching files
npm run contract:inventory            # regenerate inventory.json after adding routes/events
npm run contract:schema               # re-freeze fixtures/schema.sql after a DB schema change
```

| Variable | Meaning |
|---|---|
| `CONTRACT_TARGET` | `node` (default): spawns `node src/web/server.js`. `go`: spawns `$CONTRACT_GO_BIN` (default `core-service/bin/tgdl-server[.exe]`). `url`: attaches to `$CONTRACT_URL` (nothing spawned or seeded — seed the server's data dir with `node scripts/contract-seed.mjs <dir>` and restart it between files; `$CONTRACT_DATA_DIR` enables path masking; scenarios that need their own seed/env/extra server refuse to run). |
| `CONTRACT_UPDATE=1` | Record instead of compare (Node only — use `npm run test:contract:update`). |
| `CONTRACT_WORKERS` | Files run in parallel (default 4). Each file runs its own server(s). |

`npm test` excludes this directory; CI runs it as its own job on Ubuntu and
Windows.

## Layout

```
harness.js                  spawn a target on a fresh seed, sessions, request/record, WS recorder
lib/normalize.js            masks and placeholders (documented below)
lib/snapshot.js             golden store: compare / record, stale-entry check
lib/inventory.js            parses src/web/server.js + src/** for routes and WS event types
inventory.json              generated inventory + hand-written `skip` reasons
inventory.contract.test.js  coverage checker (no server)
fixtures/seed.js            the deterministic data dir
fixtures/schema.sql         frozen SQLite schema (generated from src/core/db.js)
fixtures/media/             the committed media bytes (tiny images, clips, docs)
fixtures/make-media.mjs     how those bytes were produced (don't re-run casually)
fixtures/sandbox.mjs        network sandbox preloaded into the Node target
*.contract.test.js          scenarios, one golden file each in __snapshots__/
```

## The seed

`fixtures/seed.js` builds a data dir **straight into each target's temp
`TGDL_DATA_DIR`** with plain better-sqlite3 and the frozen schema — no app
code, so the same seed feeds Node and Go. It is small (20 download rows,
~40 KB of media) and fixed in every detail:

- 5 chats (4 in config — one disabled, one in rescue mode — plus one that
  exists only in the DB), photos (JPEG/PNG/WebP, one with a Thai file
  name), two short H.264 clips (one faststart, one not), PDF, text, ZIP and
  gzip documents; 2 pinned rows; dedup duplicates (separate copies of the
  same bytes across chats) and a download-time dedup *reference* (two rows,
  one file); NSFW scores on five photos (one whitelisted) and one blocklist
  hash; a seekbar sprite; a group avatar.
- AI: 3 people (2 labelled), 7 faces (one on a video frame, one unassigned).
- Share links: active, expired, revoked.
- Backup: 3 destinations (local, S3, SFTP — disabled, fake credentials in
  the real `TGDC` encrypted format) with job history.
- Cluster: fixed identity, two peers (one with a per-pair secret, one
  legacy), a cached peer catalog, audit and failover rows.
- A chat the account left (`chat_access`), update history.
- Config: admin + guest passwords (scrypt with fixed salts), a fixed share
  secret, the seekbar sidecar pointed at an unreachable URL and the faces
  backend disabled, so no machine-specific binary is spawned.
- Every timestamp is either in 2024 or ≥ 2099 — outside the normaliser's
  clock window — and every seeded file has the same fixed mtime.

Scenarios adjust it per file with `useContract(url, { configPatch, afterDb,
beforeStart, env, nodeEnv })`; `h.extra(opts)` starts another server in the
same file (different seed/config/env).

## Sessions

The seed holds two dashboard sessions with fixed tokens valid until 2100,
so no scenario spends the login limiter: `as: 'admin'` (default),
`as: 'guest'`, `as: 'anon'` (no cookie), or `cookie: '…'` for anything
else. The real login / setup / reset flows have their own scenarios.

## Network sandbox

The Node target runs with `--import fixtures/sandbox.mjs`: DNS answers
`ENOTFOUND` for every name but localhost, TCP to non-loopback IPs is
refused, and the cluster's UDP LAN discovery binds loopback and drops its
broadcasts. Result: the GitHub update check, sidecar/model downloads, fake
backup hosts and `*.invalid` peers all fail instantly and identically on a
dev box, a CI runner or an air-gapped host, and parallel test servers never
discover each other. The target also gets a minimal environment (nothing
from your shell leaks in), `TZ=UTC`, `TGDL_GO_CORE=off` and proxy
variables pointing at a dead port. A Go target needs the same isolation
(see docs/GO-MIGRATION.md).

## What an entry records

```json
{
  "route": "GET /api/downloads/:groupId",
  "request": { "method": "GET", "path": "/api/downloads/-1001000000001?limit=2", "as": "admin" },
  "status": 200,
  "headers": { "cache-control": "no-store, max-age=0", "content-type": "application/json; charset=utf-8", "etag": "W/\"<express-etag-of-body>\"", "vary": "Cookie, Accept-Encoding" },
  "security": "e30ca64edb",
  "body": { "json": { "…": "…" } }
}
```

- `route` is the inventory key the request maps to (the coverage checker
  counts these).
- `headers`: every response header except `date`, `connection`,
  `keep-alive`, `transfer-encoding`; `content-length` only for non-text
  bodies (for JSON/text it depends on member order, i.e. framing).
  `Set-Cookie` is parsed (value masked, attributes kept).
- `security`: id of the set of security headers (CSP, HSTS, COOP, CORP,
  X-Frame-Options, …); the full set is stored once per file under
  `securityProfiles`. A changed header changes the id, and the checker then
  diffs the two sets.
- `body`: `json` (normalised, object keys sorted), `text` (≤ 4000 chars),
  `textSha256` (longer text), `sha256` + `bytes` (binary — original files
  must be byte-identical), `image` (derived images: format, width, height),
  `zip` (entry names, sizes, CRCs), or a derived fact (`bodyRecord`, e.g.
  `{ sameAsFile, identical }` for SPA assets).
- Large request bodies (> 2000 chars, e.g. over-the-cap id lists) are
  recorded by digest.

## Normalisation

Masks exist only for values that legitimately differ between two runs of
the **same** code. They keep the JSON type (`<time:ms>` replaces a number,
never a `null`), so a field that disappears or changes type still fails.

Global masks (`lib/normalize.js`, applied to every string / number / header):

| Mask | Replaces | Why it is safe |
|---|---|---|
| `<DATA>`, `<REPO>`, `<TMP>`, `<HOME>`, `<NODE>` | the temp data dir, repo root, temp root, home dir, node binary path (native, `/`, `\\`-escaped and URL-encoded forms) | machine-specific locations |
| `/` for `\` | backslashes in any string | Windows vs POSIX path separators |
| LF for CRLF | line endings in strings and text bodies | checkout / OS line endings |
| `<HOST>`, `<PORT>` | `127.0.0.1:<port>` (and localhost / ::1), a `port` field equal to the target port | free port picked per run |
| `<version>` | the exact package.json version | changes every release; checked once against package.json in `static` |
| `<time:ms>` | integers in [2025-01-01, 2098-01-01) as epoch ms | "now" stamped by the server; seed times are outside the window |
| `<time:s>` | the same window in epoch seconds, only under time-like keys (`…At`, `…_at`, `ts`, `exp`, `expires`, `since`, `until`, …) | as above, without catching counts |
| `<time:iso>`, `<time:sql>`, `<time:http>` | ISO-8601 / SQLite `YYYY-MM-DD HH:MM:SS` / HTTP dates in the window | as above |
| `<key:number>` | values of `uptime*`, `durationMs`, `elapsedMs`, `tookMs`, `latencyMs`, `rttMs`, `ms`, `pid`, `ppid`, `rss`, `heap*`, `external`, `arrayBuffers`, `freemem`, `totalmem` | wall-clock durations and host resources |
| `<uuid:N>` | random UUIDs (seeded ids are kept) | generated ids; numbered in order of appearance so equal ids stay equal |
| `<hexL:N>` | runs of ≥ 32 hex chars with a digit and a letter, unless seeded (tokens, secrets, file hashes of seeded media) | random tokens; seeded digests stay literal, so a wrong hash still fails |
| `<sig:N>` | `?s=` / `?sig=` URL signatures not in the seed | HMACs over a "now"-based expiry |
| `<filetoken:N>` | `<exp>.<sig>` file tokens with an expiry in the window | minted from "now" |
| `<session-token>` | a 64-hex `Set-Cookie` value | random session token |
| `W/"<express-etag-of-body>"` | an ETag equal to Express' weak ETag of the body | it *is* the body hash; member order must not matter |
| `W/"<express-etag>"` | the same on a body-less 304 / HEAD | nothing to hash |
| `W/"<size-hex>-<mtime-hex>"`, `<http-date>` | static-file ETag / Last-Modified of non-seeded files | SPA assets carry their git-checkout mtime; content is checked separately |
| `reset=<s>`, `<seconds>` | `RateLimit` reset and `Retry-After` | countdown clocks |

Per-exchange masks (`mask: { 'json.path': 'reason' }`, `headerMask`) are
written into the entry itself under `masked`, with their reason, so a
reviewer sees them next to the value they hide:

```
grep -n '"masked"' -A 3 tests/contract/__snapshots__/*.snap.json
```

They cover host details (Node/platform/CPU/memory in system health, ffmpeg
and hardware-acceleration probes, Python in the AI doctor), encoder-dependent
byte sizes of generated thumbnails and sprites, directory-walk order that
differs between NTFS and ext4, SQLite page accounting after VACUUM (the
relations are recorded instead), network stack error texts, random
auth-flow ids, and the current UTC minute in bulk-ZIP file names.

Where a mask would lose a relation, the scenario records a **derived fact**
instead (`t.store.record(label, {...})`): share-link signatures are
recomputed and compared, `expiresAt − createdAt` equals the clamped TTL,
VACUUM's reclaimed bytes equal before − after, SPA assets are compared with
the files in `src/web/public` after the documented `?v=` rewrite, and
`/api/version` equals package.json.

Arrays keep their order (it is contract) unless the exchange lists the path
in `unordered` (e.g. rows produced by concurrent jobs), which is also
written into the entry.

## WebSocket recording

`t.ws({ as })` opens a dashboard socket and buffers every message;
`t.recordWs(label, messages, opts)` records a normalised sequence.

- Timer-driven types (`monitor_status_push` every 3 s, `stats_push` every
  30 s, `log`) are dropped unless a scenario keeps them — they are not
  caused by the action under test.
- `collapse: ['x_progress']` folds runs of progress ticks into one marker:
  their count depends on timing, their presence and position don't.
- `unorderedEvents: true` sorts a sequence of concurrent, independent
  events.
- `stats_update` (the per-role stats push, 400 ms debounced) is ignored in
  sequences where its position races other events, and recorded on its own
  where it matters.
- `/ws/cluster` exchanges are recorded as `{ ws: 'cluster', sent, received,
  events }`: what the fake peer sent, what the node sent back, and the
  dashboard events that followed.

## Inventory and coverage

`inventory.json` lists every route registered in `src/web/server.js`
(method + Express path; `app.use` mounts that serve content; the SPA files
served by the static middleware) and every WS message type the backend can
emit (literal `broadcast({type})` calls anywhere in `src/`, job-tracker
`<prefix>_progress` / `_done` families, engine events relayed through
`runtime`, direct socket writes, the `/ws/cluster` send/accept types).

`inventory.contract.test.js` fails when:

- `inventory.json` no longer matches the sources (run
  `npm run contract:inventory`), or a dynamic broadcast site can't be
  resolved (add it to `DYNAMIC_SITES` in `lib/inventory.js`);
- `fixtures/schema.sql` no longer matches `src/core/db.js`;
- a route or event is neither exercised by a golden entry nor marked
  `"skip": "<reason>"` in `inventory.json` — or is both;
- a golden references a route or event type the inventory doesn't know.

It prints the coverage numbers as `[contract coverage] {…}`.

## Adding or changing a scenario

1. Add exchanges to the domain file (or a new `<domain>.contract.test.js`).
   Labels are unique per file and describe the case.
2. `node scripts/contract-run.mjs --update <file>`, read the new entries in
   the snapshot diff — every placeholder must be explainable.
3. Run the file three times without `--update`; it must pass every time.
4. For a new route/event: `npm run contract:inventory`, then cover it (or
   add a `skip` with a real reason).

Rules that keep runs deterministic:

- One fresh seed per file (per `h.extra()`); scenarios inside a file run in
  order and may depend on each other's mutations.
- Keep a server's lifetime under ~25 s: the integrity sweep's first pass
  fires 30 s after boot.
- Never wait on wall-clock sleeps for an outcome — wait for the WS event or
  poll the status route (`until()`).
- Don't record values that depend on the host (paths, tools on `PATH`,
  CPU, encoders) — mask them with a reason or record the invariant.

## Known bugs pinned by the goldens

Recorded as today's behaviour. Fix them in Node first (then re-record),
never silently in the Go port.

- Guests can read `GET /api/groups/:id/files`, `/stats`, `/purge/status` and
  `/refresh-info/status` (the guest allow-list matches the `/api/groups`
  prefix).
- `DELETE /api/purge/all` (factory reset) has no `{ confirm: true }` guard.
- `advanced.share.rateLimitMax` / `rateLimitWindowMs` never take effect
  (the route keeps the limiter it was registered with).
- A JSON array body to `POST /api/config` is spread into the config as index
  keys.
- `POST /api/downloads/bulk-delete {ids:[null]}` starts a job (`Number(null)`
  is 0).
- `GET /api/system/health` always reports `disk: null` (`JSON.parse` on an
  object).
- `files_verify` summary `removed` is always 0 (the sweep returns `pruned`).
- Dedup delete reports `missingFiles: 1` when a deleted copy had a
  reference row.
- The `thumbs_done` event loses the requested build kind.
- `POST /api/maintenance/recovery/reassign` echoes `monitorAccount` as sent
  but stores it as a string; `PUT /api/groups/:id` stores a new group id
  that starts with `-` as a number.
- `PATCH /api/ai/people/:id` with a blank label answers `""` but stores NULL.
- `advanced.nsfw.enabled: "true"` (a string) switches NSFW off.
- "No Telegram API credentials" answers 503 on some routes, 400 on the
  account wizard steps and 500 on history / stories / URL download;
  `/api/queue/batch` checks the engine before validating the body.
- `src/core/secret.js` (session-file key) and the NSFW model cache
  (`data/models`) ignore `TGDL_DATA_DIR` and live under `<repo>/data`.
- Face crops and sprites send `Pragma: no-cache` together with
  `Cache-Control: … immutable`; `/files/*` answers any HTTP method.
- Cluster: `POST /api/cluster/sign-url` stores `expires_at` in ms but signs
  seconds, so every minted direct-stream URL answers `401 bad_sig`;
  `GET /api/cluster/peer-thumbs/:id` sends a JSON object labelled
  `image/webp` (with the absolute thumb-cache path) instead of the image;
  the pairing-code handshake always fails (`401 bad_signature`: the
  initiator signs with the code-derived secret, the receiver only accepts
  the per-pair secret or the cluster token); the lazy engine starter is
  registered after the cluster routes, so sync / WS channel / discovery /
  failover only start after `POST /api/cluster/failover/run` or an unknown
  `/api/cluster` path, and inbound `/ws/cluster` events reach the DB but not
  the dashboard until then; the legacy cluster-token fallback verifies any
  `X-Peer-Id`.
- Express' own errors (e.g. an undecodable path parameter) go through the
  last-resort handler and answer 500 instead of their status.
- Backup: `unlock` accepts any passphrase (even empty); `run` on a disabled
  or unknown destination answers `200 started:true`; `DELETE` of an unknown
  destination still broadcasts `backup_destination_removed`.
- Sprite / meta 404s send `Cache-Control: no-store` for a missing sprite but
  `no-store, max-age=0` for a bad id.
