# Native cluster foundation

The Go application now pairs two instances, authenticates peer HTTP requests,
reconciles added/edited/deleted catalog rows automatically and proxies ranged
media from a paired instance. Authenticated WebSockets announce changes; a
durable revision feed provides recovery after disconnection. This remains a
partial cluster implementation: discovery, ownership/config replication and
failover are not implemented yet.

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
| `GET /api/cluster/catalog/changes` | Revision pages with epoch/reset and tombstones |
| `GET /api/cluster/search/peer` | Bounded local filename/group search |
| `GET /api/cluster/groups/snapshot` | Whitelisted group metadata |
| `GET /api/cluster/accounts/snapshot` | Account ID/label/phone/disabled metadata |
| `GET`, `HEAD /api/cluster/files/*` | Confined media reads with HTTP ranges |

Snapshots omit sessions and credentials; nested custom metadata also strips
credential-bearing field names. They are read surfaces, not account/session
replication. Failed probes retain the last successful contact time, and a probe's
status and audit commit together against the current endpoint and secret.

## Catalog and media

Downloads triggers update `tgdl_cluster_catalog` and its global revision in the
same SQLite transaction as the original mutation. Each download ID retains its
latest published row or deletion tombstone, including ID changes. Repeated edits
replace that entry; they do not accumulate an event for every historical edit.
Tombstones currently remain indefinitely. Deleting them safely requires an
explicit epoch reset/compaction policy; audit retention also remains future work.

`GET /api/cluster/catalog/changes?after=<revision>&epoch=<epoch>&limit=500`
returns a consistent read snapshot: peer ID, random epoch, head, next revision,
reset/more flags and changes. Invalid query bounds return 400. Each page is
limited to 500 entries and 512 KiB of encoded changes; source payload projection
is also byte-limited before scanning into Go. JSON escaping expansion counts
against the encoded limit. A single oversized record is an explicit sync error.
The response envelope remains below the client's 1 MiB cap. Revisions, rather
than row IDs, ensure an old row edited during paging is visited again.

A single-flight pass uses up to four peer workers and a one-minute deadline.
Each peer consumes up to ten bounded pages before yielding. More pages schedule
another pass; connection/change notifications also wake the same loop, and a
30-second timer provides periodic reconciliation. This is one protocol and one
cursor, with no ID-only fallback. Peers lacking the changes endpoint fail
explicitly. Manual `POST /api/cluster/sync/run` shares the guard and returns 409
while a pass is active.

Cache writes, reset, revision cursor, success status and audit commit together.
The writer rechecks the current peer URL, secret and cursor; stale responses and
failed writes cannot advance them. Valid pages require strictly increasing
revisions, positive row IDs, paths and nonnegative sizes. Failed syncs persist
and return their error. Successful cache changes, including a reset to an empty
catalog, notify dashboards. Once a revision cursor owns the cache, unversioned
socket row events are only hints and cannot resurrect deleted rows.

Ordinary restarts retain the epoch and cursor. An epoch mismatch or a cursor
beyond the source head resets the receiver cache. The reset and first page are
atomic; subsequent pages progressively repopulate the cache, so this is not an
atomic whole-library replacement. Native `backup-restore` rotates the epoch in
its private staged database before publication. This detects divergent restore
history even if its new head has overtaken the old receiver cursor. Manual
replacement of database files bypasses this safeguard and is not a verified
recovery workflow. Media files are not included in snapshot archives.

### Peer WebSockets

`GET /ws/cluster` uses its own per-pair authentication before dashboard setup or
cookie checks. Connect query parameters are `peer`, `ts`, and hex HMAC-SHA256 of
`connect|<timestamp_ms>`. Messages contain `type`, `payload`, `ts`, `sig`; the MAC
covers `type|ts|hex_sha256(JSON.stringify(payload || {}))`. A native bounded JSON
encoder preserves non-integer property order, numeric-key ordering, decoded
strings including surrogate escapes, and binary64 number formatting. Independent
signature fixtures cover Thai, HTML escapes, U+2028, exponent forms and key order;
this is tested protocol coverage, not an exhaustive ECMAScript conformance claim.
Both connect and event receipts use the durable clock/replay checks. A failed
cache mutation rolls back its receipt so the same event can be retried.

One application supervisor polls catalog revision and pairing membership each
second. There is one outbound reconnect worker per peer (maximum 128), up to
256 established sockets total, and at most two inbound or outbound sessions per
peer/direction. Each socket has one reader and one writer, a 1 MiB frame limit,
512 KiB payload limit, depth-64 JSON limit, 15-second signed heartbeat/control
ping, 40-second read deadline and 10-second write deadline. Reconnect backoff
caps at 30 seconds. A silent handshake is interruptible on shutdown. Application
cancellation closes sockets and joins workers before database closure.

Connections send signed `catalog_changed` hints at startup and on local revision
changes. They wake durable HTTP reconciliation; they are not the data journal.
Current pairing is checked for every accepted event and by the supervisor;
revocation or endpoint/key changes close existing links on the next membership
check. Failed storage reads also close links. HTTP media transfers already in
flight are still not actively revoked. The sender does not mark a peer online
merely because an unauthenticated WebSocket upgrade succeeded.

Legacy unversioned download events can populate a cache before revision sync
has initialized it. Full legacy outbound events and dashboard event shapes remain
incomplete. Known group/config/failover workflows reject explicitly and close the
socket rather than reporting that the change was applied. Unknown extension
messages are authenticated liveness messages without workflow effects. Browser
and peer sockets are separate authorization/lifecycle paths.

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

The live-catalog checkpoint adds a second independent Python client experiment
using two actual Go processes. Without a manual sync request, 502 rows converge;
a source restart publishes offline edits/deletes/additions below the previous
maximum ID. Receiver restart preserves its cursor. The native CLI restores an
older snapshot, rotates its epoch, and correctly replaces a divergent receiver
cache even after ten new source revisions overtake the old cursor. Independent
WS HMAC checks, forged-message rejection, a socket surviving eleven seconds,
revocation closure and clean SIGTERM exits also pass. The client's first attempt
assumed a config.json file existed; the fixture was corrected to treat it as
optional because fresh native setup stores configuration in SQLite.

Native race tests also cover empty-reset dashboard notification, old unversioned
events after a committed deletion, replay rollback with an injected cache write
failure, bounded JSON expansion, concurrent pagination edits and rekeys, silent
handshake cancellation, successful upgrade survival, unsigned sockets before
setup, and relative/absolute native restore destinations. These tests do not
establish live Telegram, WAN/TLS interoperability or browser E2E completion.

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

Full released peer event/dashboard compatibility; metadata ingestion; discovery; federated search controls and cluster statistics;
thumbnail proxies; signed direct-stream URLs; relay and cross-peer delete;
dedup sweep/conflict resolution; failover and ownership/config replication;
in-flight peer revocation; audit pruning; live TLS/network interoperability;
mixed-version migration and complete browser E2E remain unverified or unfinished.

References: [Go HMAC comparison](https://pkg.go.dev/crypto/hmac),
[HTTP clients and transports](https://pkg.go.dev/net/http#Client),
[HTTP response control](https://pkg.go.dev/net/http#ResponseController),
[SQLite transactions](https://www.sqlite.org/lang_transaction.html),
[SQLite trigger semantics](https://www.sqlite.org/lang_createtrigger.html),
[Gorilla concurrency and control frames](https://pkg.go.dev/github.com/gorilla/websocket#hdr-Concurrency),
[ECMAScript JSON serialization](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify).
