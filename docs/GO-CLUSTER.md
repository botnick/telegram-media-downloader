# Native cluster foundation

The Go application now pairs two instances, authenticates peer HTTP requests,
pulls new catalog rows automatically and proxies ranged media from a paired
instance. This is a partial cluster implementation. Peer WebSockets, catalog
edit/delete reconciliation, discovery and failover are not implemented yet.

## Pairing and identity

Identity and bootstrap tokens live in the existing SQLite `kv` table. New
instances generate a UUID and 32 random bytes encoded as hex. Existing valid
identities are retained; corrupt persisted identities/tokens fail startup.
The dashboard requires an admin session for identity, token, pairing-code,
peer-registry, probe, audit and manual-sync operations.

Pairing uses either an explicitly supplied bootstrap token or an eight-character
code issued by the destination. Codes expire after five minutes; at most 32
active codes are retained. The code-derived key signs the handshake containing
a newly generated per-pair secret. Code consumption, replay receipt, remote
identity, per-pair secret and audit commit in one transaction. A failed write
does not consume the code. The outbound instance saves its registry only after
the response acknowledges exactly the secret it proposed.

There is no distributed transaction between the two machines. If the receiving
machine commits and the acknowledgement is lost, or the caller's local commit
fails, the receiving registry can contain a one-sided pair. The caller reports
failure; pair again with a new code to install a common secret. Crossed
simultaneous pairing and repair after this boundary need additional coverage.

`PUBLIC_URL`, when set, supplies the caller's callback URL. Otherwise the
request's host and trusted HTTPS resolution supply it. URLs require HTTP(S),
a hostname, and no embedded credentials, query or fragment. The peer client
does not follow redirects or inherit environment HTTP proxies. HTTP is
supported for local networks; confidentiality requires HTTPS or an encrypted
network. HTTPS uses normal certificate verification.

Established requests use only the stored per-pair key. A bootstrap token does
not authenticate a paired request. Legacy rows without a valid per-pair key
remain visible with `migrationRequired:true` and need pairing again. Rotating
the bootstrap token clears issued codes but retains existing per-pair keys.
Revocation removes the registry row, cached catalogs/metadata/jobs and sync
cursor atomically. It prevents subsequent authentication and stale sync/probe
results from restoring the peer. Already authorized transfers are not actively
cancelled by peer revocation in this checkpoint.

## Signed HTTP protocol

Headers are `X-Peer-Id`, `X-Peer-Ts` and `X-Peer-Signature`. The timestamp is
integer epoch milliseconds. The signature is lowercase hex HMAC-SHA256 over:

```text
METHOD + "\n" + escaped_request_target_with_query + "\n" +
timestamp_ms + "\n" + hex_sha256(raw_body)
```

The hex-encoded secret is used as its UTF-8 bytes, not decoded to binary.
Escaping, query order and body whitespace are significant. Verification uses
constant-time MAC comparison and a 60-second clock window. Accepted signatures
are persisted for 120 seconds in `tgdl_cluster_replay`; replay rejection survives
restart. Entries expire during later accepted requests. The sender gives each
request a unique millisecond timestamp and permits at most one second of lead;
bursts or clock rollback wait with context cancellation rather than producing
invalid future timestamps. This protocol limits sustained timestamp allocation
to approximately 1,000 requests per second per client.

Handshake bootstrap verification is separate from the paired-request gate.
Header and body peer IDs must agree. Requests and JSON responses are bounded
to 1 MiB; response headers are bounded to 64 KiB. JSON requests have a ten-second
deadline and each peer transport permits eight connections per host. Request
contexts and workers are owned by the application and joined before SQLite
closes. Audit strings have bounded length; audit-history retention is not yet
implemented.

Implemented signed endpoints:

| Endpoint | Behavior |
| --- | --- |
| `POST /api/cluster/handshake` | Atomic pairing and secret acknowledgement |
| `GET /api/cluster/health` | Identity/version and committed peer liveness |
| `GET /api/cluster/downloads/since` | Ordered local catalog after `sinceId` |
| `GET /api/cluster/search/peer` | Bounded local filename/group search |
| `GET /api/cluster/groups/snapshot` | Whitelisted group metadata |
| `GET /api/cluster/accounts/snapshot` | Account ID/label/phone/disabled metadata |
| `GET`, `HEAD /api/cluster/files/*` | Confined media reads with HTTP ranges |

Snapshots omit sessions and credentials; nested custom metadata also strips
credential-bearing field names. They are read surfaces, not account/session
replication. Failed probes retain the last successful contact time, and a probe's
status and audit commit together against the current endpoint and secret.

## Catalog and media

An application-owned timer starts a sync pass every 30 seconds, with one pass
at a time and up to four peer workers. Manual `POST /api/cluster/sync/run` uses
the same guard and returns 409 when busy. A pass has a one-minute deadline.
Each peer fetches up to ten pages of 500 rows. Remaining pages wait for the next
pass. A page's cache writes, cursor, success status and audit commit together.
Rows must have strictly increasing IDs, a path and a nonnegative file size.
Rejected pages and database errors cannot advance the cursor. Failed syncs
persist their status and return an error, rather than reporting successful
completion merely because their error was saved.

Current peer identity, endpoint, secret and cursor are rechecked in the write
transaction. Removing or editing a peer while a fetch is running cannot publish
that stale response. `GET /api/cluster/sync/state` exposes persisted cursors and
errors. Successful nonempty passes emit a dashboard `peer_catalog_update`.
This append-only cursor does not discover edits or deletions to old rows.

The admin media routes `GET /files/*?peer=<id>` and
`GET /files/_clusterref/<peer-id>/<remote-id>` now fetch actual peer bytes. Ghost
references resolve through the stored peer catalog. Guests cannot use this
bridge. File paths are decoded once and opened through the existing confined
media APIs; literal percent/plus filenames retain their meaning. Ghosts cannot
recursively proxy other ghosts.

Range/conditional headers are forwarded; browser cookies and authorization
headers are not. Responses use `private, no-store`. Transfers use a 32 KiB copy
buffer, ten-second connection/header limits and a rolling 30-second inactivity
deadline, with no ten-second whole-file timeout. Peer streaming uses HTTP/1
so socket deadlines belong to one active response. Shutdown cancels blocked
transfers. A truncated upstream body aborts the downstream response rather than
producing a clean, incomplete chunked response. Direct signed-share streaming,
peer thumbnails and cross-peer delete are still absent. A peer configured for
direct mode receives an explicit 501 instead of silently selecting proxy mode.

## Verification and measurements

Native tests cover an independent Python-calculated HMAC vector; exact request
bytes; malformed/extreme timestamps; concurrent one-time code use; injected
transaction failure and retry; durable replay after database reopen; rejection
of bootstrap-key fallback; identity substitution; secret redaction; revocation;
stale probe/sync responses; cursor rollback; failed-sync reporting; and shutdown
while waiting on another instance.

Two real Go HTTP applications pair with different bootstrap tokens, sync 502
rows across page boundaries, and serve matching range bytes for explicit peers
and ghost references. A separate client test streams a body for eleven seconds
and verifies that browser credentials are not forwarded. A deliberately broken
chunked peer proves that the proxy reports truncated delivery as an error.

An independent Python standard-library experiment starts two compiled Go
processes on loopback with fresh data directories. It verifies code pairing,
Python-signed requests, durable replay after process restart, 502-row manual
sync, matching range bytes, persisted identities/sessions and the real 30-second
timer discovering row 503. Bootstrap rotation preserves the pair; a bootstrap-
signed request is rejected; revocation clears the cursor; both processes exit
zero on SIGTERM. This is process/HTTP coverage, not browser or live Telegram E2E.

The stream benchmark measures the Go client plus a loopback HTTP fixture,
including its server allocations, not end-to-end disk/TLS/browser performance
or process RSS. Three runs of ten iterations on Linux amd64, Intel Core Ultra 7
270K Plus, measured 59,576–62,184 allocated bytes per 1 MiB transfer and
60,680–65,282 per 64 MiB transfer (174–177 allocations). Timings varied from
0.74–4.00 ms and 37.9–56.3 ms respectively under concurrent tests. Allocation
stays approximately constant with payload size in this fixture. These numbers
do not establish a speed advantage over the old server.

The frozen legacy suite remains unchanged. Cluster differences include actual
application versions instead of a missing package-environment value, durable
per-pair migration state, refusal of the global-key fallback, mandatory secret
acknowledgement, last-successful-contact semantics, and clearer failure output.
The federated-files case now differs in error text and cache/Vary headers. These
are still counted as failing frozen cases, not silently waived. See the current
[whole-application totals and remaining work](GO-MIGRATION-STATUS.md).

## Remaining cluster work

Peer WebSockets and resynchronization after lost events; catalog edits/deletes;
metadata ingestion; discovery; federated search controls and cluster statistics;
thumbnail proxies; signed direct-stream URLs; relay and cross-peer delete;
dedup sweep/conflict resolution; failover and ownership/config replication;
in-flight peer revocation; audit pruning; live TLS/network interoperability;
mixed-version migration and complete browser E2E remain unverified or unfinished.

References: [Go HMAC comparison](https://pkg.go.dev/crypto/hmac),
[HTTP clients and transports](https://pkg.go.dev/net/http#Client),
[HTTP response control](https://pkg.go.dev/net/http#ResponseController),
[SQLite transactions](https://www.sqlite.org/lang_transaction.html).
