# telegram-media-downloader Go server

`cmd/tgdl-server` is the Go backend under development. It serves the embedded
SPA and implemented HTTP/WebSocket routes directly. Packaging selects it,
but live Telegram verification and public API parity remain incomplete.
See [verified coverage and remaining release work](../docs/GO-MIGRATION-STATUS.md).
The executable does not start or proxy to a Node server.

The browser JavaScript under `internal/webassets/public` is client code and runs in the
user's browser. ffmpeg and explicitly configured AI services are external
workers with clear errors; they are not server fallbacks.

## Run

```sh
TGDL_DATA_DIR=/var/lib/telegram-media-downloader PORT=3000 \
  ./tgdl-server
```

`TGDL_DATA_DIR` is required. The server creates `db.sqlite` and applies the
same idempotent schema used by existing installations. `PORT` defaults to
`3000`; `TGDL_SESSION_TTL_DAYS` defaults to 7. The existing session cookie
name is preserved as `tg_dl_session`.

Useful commands:

```sh
./tgdl-server version
./tgdl-server help
```

## HTTP and WebSocket surface

- `GET /health` reports readiness without authentication.
- `POST /api/auth/setup`, `POST /api/login`, `POST /api/logout`, and
  `GET /api/auth_check` manage the compatible scrypt/session flow.
- `GET /` and asset paths serve the embedded SPA.
- `GET /` or `GET /ws` upgrades an authenticated session; events
  are bounded and role-filtered so a slow browser cannot block workers.
- `/v1/db/*` exposes the read projections used by the gallery, maintenance,
  AI, NSFW, integrity, dedup and cluster surfaces. They run directly against
  a query-only pool and require a valid session.
- Pin mutations, job status/cancellation, SQLite backup and cluster pairing
  are owned by Go and commit before broadcasting their event.
- `/api/history` runs native durable backfills using the shared account/queue
  engine, including jobs-only operation, cancellation and restart resumption.
  See [history limits, semantics and validation](../docs/GO-HISTORY.md).

## Data safety

SQLite uses WAL, `synchronous=NORMAL`, `busy_timeout=5000` and foreign keys.
Schema creation is embedded and idempotent. Application ingestion looks up
Telegram identities in the existing catalog before network I/O, retaining a
separate message reference for each forward. Verified hashes include OS file
identity/change metadata; active coordination is bounded by the worker limit.
Transfers write a sibling `.part` file, sync it, then publish through directory
handles with an exclusive rename. A durable journal recovers completed files
when registration fails, and message generations prevent stale recovery from
reverting edits. Cancelled transfers remove their partial files.

Backups use SQLite `VACUUM INTO` and publish a timestamped file only after the
snapshot is complete; each result includes byte count and SHA-256.

## Telegram engine boundary

`internal/telegram` extracts photo/document metadata directly from MTProto
messages and provides an account-bound gotd media transport. `App.IngestTelegram`
connects that metadata to the durable library, existing gallery files and
WebSocket events. Integration tests use a fixture byte transport. The adapter
does not dial during construction; network activity starts from `Run`.

Monitor start/stop/restart now owns native gotd account connections and a durable
SQLite work queue. Existing encrypted sessions are imported into a separate
native directory; duplicate authentication keys and simultaneous servers using
the same data directory are refused. Workers use their source account, refresh
expired references, recheck filters and publish through the ingestion library.
The queue snapshot reports actual byte progress and persists recent outcomes.
SIGINT/SIGTERM stops HTTP acceptance, joins workers and closes browser sockets.

Telegram cursors are stored per account/user/channel. Difference payloads are
durably accepted before gotd can advance a cursor; persistence failures latch
account shutdown. Oversized update gaps preserve a history-recovery marker and
prevent restart until repaired. Automatic history repair, login, full queue
controls, account routing/proxies and live Telegram E2E remain release work.
Tests use injected accounts and actual gotd update processing with fake RPCs.
See the [migration status](../docs/GO-MIGRATION-STATUS.md) for remaining gates.

Transfer attempts have a deadline of two minutes plus one second per 16 KiB,
capped at 24 hours, so internal RPC retries cannot occupy a worker forever.
Shutdown/edit cancellation returns work to pending without spending a retry;
a transfer deadline consumes one of the configured attempts. Queued Telegram
payloads stay private: the dashboard receives a bounded field projection.
Set `TGDL_SECURE_COOKIES=1` when serving behind HTTPS.

References:

- [gotd introduction](https://gotd.dev/docs/intro/)
- [gotd first client](https://gotd.dev/docs/getting-started/first-client/)
- [Telegram API](https://core.telegram.org/api)
- [Telegram update sequence and differences](https://core.telegram.org/api/updates)
- [Pinned gotd update manager](https://github.com/gotd/td/tree/v0.115.0/telegram/updates)
- [Go net/http](https://pkg.go.dev/net/http)
- [modernc SQLite](https://pkg.go.dev/modernc.org/sqlite)

## Development checks

```sh
/usr/local/go/bin/go test ./...
/usr/local/go/bin/go test -race ./...
/usr/local/go/bin/go vet ./...
/usr/local/go/bin/go build ./cmd/tgdl-server
```

The recorded Node contract fixtures remain a development oracle while the
remaining domain handlers are ported. They are never copied into the
production image, and the production process tree contains only
`tgdl-server` plus explicitly configured sidecars.
