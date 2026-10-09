---
title: "Go migration status"
description: "Scope, packaging checks and test evidence recorded during the Go migration, before the 3.0.0 release."
parent: "Developer notes"
nav_order: 1
---

# Go migration status

> **Historical note.** This page was written on the development branch before
> 3.0.0 was released, when the Go application was not yet a complete
> replacement for the 2.x downloader and was not meant for production
> libraries. 3.0.0 has since shipped; see [Install and deploy](DEPLOY.md),
> [Upgrading from 2.x](UPGRADING.md) and [Features](FEATURES.md#not-in-30) for
> the released behaviour and its known gaps. The evidence below is kept as a
> record.

## Current delivery scope

On 2026-10-09 the owner narrowed the migration to necessary functionality to
reduce time and cost. Prioritize Telegram downloads, download-time deduplication,
queue reliability, file management, the usable dashboard and access controls.
Do not extend the migration into optional AI/image-analysis workflows or advanced
cluster features. Preserve and verify completed work; do not port unused features
just to reproduce every historical API. The legacy contract totals below remain
honest compatibility evidence, but optional feature failures are not a mandate to
build those features. Production must still use Go without a Node runtime fallback.

## Build and delivery path

The root Makefile, direct Unix/PowerShell launchers and application CI now use
Go without npm. Docker Compose builds this checkout with a local tag rather than
pulling an older published image; bind paths must exist and UID/GID are explicit.
Production builds send only the Go module and embedded assets to the builder.
CI checks the native image before publication, and app tags build server archives
plus checksums with `scripts/build-server-release.sh`. Unix, PowerShell and Windows
batch launchers execute the native binary. The obsolete companion
release workflow was removed. Application version output now matches AppVersion.

Initial setup from a Docker-published port correctly remains forbidden. The
native `tgdl-server setup --password-stdin` command now configures the running
server over its own loopback interface. It accepts no password argument, ignores
proxy environment variables, refuses redirects, bounds reads, and cannot replace
an existing password. Setup-page/API instructions point to this command.

Packaging verification on 2026-10-09:

- Native build, vet and the full server-command race suite pass. Focused setup
  tests also pass under the race detector, including remote/forwarded-header
  rejection and password setup/login/logout.
- An actual Linux amd64 image passes fresh host-owned bind storage, non-root
  UID/GID 1000, no `node`/`npm`/`npx`, external setup rejection, local command setup,
  duplicate-setup rejection, login, embedded dashboard/assets, exact ranged media
  bytes, persistent login/library after restart, and graceful exit code 0.
- Linux/Windows amd64 release archives build and pass SHA-256 checks; the extracted
  Linux binary runs the setup command help. Unix launcher works from another cwd.
- Both Compose manifests validate; shell scripts and workflow YAML parse. Windows
  execution, other release architectures and remote GitHub Actions have not been
  run in this packaging check. No image, release or branch was published.

The obsolete backend/duplicate browser tree, npm packages and executable Node
test/build helpers have been removed. Their source remains in Git at `aa83eed`.
Canonical browser JavaScript stays embedded in Go; frozen JSON/schema/media
fixtures remain as historical evidence. Native Go tests are the active test
path. Historical contract totals below were measured before harness removal,
not rerun or relabeled as passing. This cleanup does not establish live Telegram
E2E or optional feature support. Sidecar projects remain independent.

After removal, the complete Go race suite and `go vet ./...` pass, and the
server builds without the deleted tree or installed Node dependencies. A fresh
standalone binary launched outside the checkout passes health, initial setup,
embedded dashboard/modules/styles and CSP metadata, then exits cleanly on
SIGTERM. The tracked-file audit finds no package manifests or executable
JavaScript outside the required embedded browser assets. Windows launchers were
reviewed but not executed on Windows. Frozen contract totals below remain
historical; no live Telegram claim follows from these checks.

## Core browser check (2026-10-09)

A real Chrome window against an isolated Go server verified first-time setup,
login/logout, dashboard and empty queue navigation, connected WebSocket status,
gallery search, image decoding, pin/unpin, pin/session persistence across process
restart, and confirmation-based deletion of both the catalog row and physical
file. Browser input/clicks also saved and reset CSP settings; response headers
changed immediately. This is a focused browser smoke check, not full browser or
live Telegram E2E.

Two reproduced failures were corrected: the security editor's missing admin
`GET /api/csp` metadata route, and gallery URLs that incorrectly placed an existing
root-level file under a synthesized group directory. The latter retains an
existing legacy group file when basenames collide, treats permission/I/O errors
as inconclusive, confines filesystem checks to the media root, and does not use
local files to resolve peer rows. Regression tests verify root, legacy and shared
paths through all/group/search feeds and actual media reads, plus same-basename
collisions and inaccessible legacy directories. Focused race tests also cover
native raw-message ingestion/dedup, history and URL downloads with fixture RPCs.

The browser still requests optional AI/NSFW status routes that are absent; those
ports remain outside current scope. A synthetic group with no cached avatar
returns 404 for its photo as expected. The first image fixture had invalid PNG
bytes and was replaced with a valid generated fixture; that decoding failure was
not attributed to application code. Project-local data contains no configured
Telegram API credentials or account sessions, so a real Telegram network run
remains unverified. No other room's accounts or data were inspected.

## Verified in the current application

- `download.maxSpeed` now limits aggregate media payload throughput across all
  download workers/accounts. Values are whole bytes/second; zero/null means
  unlimited. Saving applies to active transfers immediately and persists across
  restart; the queue reports the effective cap. A shared cancellable bucket
  permits at most 100 ms of burst credit (one byte minimum, 32 KiB maximum).
  Deliberate pacing waits do not consume the attempt timeout, while actual
  stalled work remains bounded. Streaming backpressure bounds transfer speed;
  Telegram's existing chunk verification/read-ahead and protocol overhead are
  not an exact wire-level byte cap. This corrects the old per-worker help text.
  Deterministic worker tests and HTTP-to-queue fixture tests cover shared limits,
  live changes, cancellation, validation and restart. This is not a live Telegram
  network measurement.

- The settings page no longer offers inert legacy requests/minute and polling
  controls or rewrites them from presets. Stored legacy values remain preserved.
  Concurrency and attempt counts are validated as whole numbers within the
  engine's supported ranges at save time, and the browser sliders match the API
  (1–50 concurrent files; 1–20 total attempts including the first).

- Native backup management and local/S3/SFTP/FTP mirror/snapshot jobs include automatic
  transactional enqueue, edit revisions, real file comparison, retries, pause,
  cron, consistent archives and a durable retention outbox. Native wire fixtures
  verify signed S3 multipart transfers and SSH/SFTP with persisted host-key
  checks. Upload pacing is separate from network deadlines. A durable journal
  cleans owned S3 multipart uploads and SFTP/FTP temporary files after process death,
  including destination edits/deletion; actual child-process kill tests pass.
  FTP supports explicit/implicit TLS, strict MLSD listings and content readback
  before rename. A separate pyftpdlib server verifies the real HTTP/queue/upload/
  encrypted-snapshot/offline-restore path over loopback.
  Local/snapshot staging cleanup and empty S3/FTP reservation boundaries remain
  open. TGDB v1 encrypted uploads and offline decrypt/restore commands now use bounded
  buffers, private staging and authentication before publication. Native tests
  restore database/config/sessions and reject corrupt or unsafe archives; this
  is not an independent crypto audit or live recovery E2E. Drive and
  Dropbox remain incomplete even when frozen contracts pass; unsupported or
  locked pending jobs display an explicit error without sending plaintext.
  See [scope and independent native tests](GO-BACKUP.md).

- Authentication, first-time setup, password changes/reset, guest access,
  session expiry/renewal, cross-origin guards and browser WebSocket transport.
- Native periodic status/statistics pushes and rescue retention now run in Go.
  Queue-time source receipts cover live/history/URL messages and survive source
  deletion during transfer or publication recovery. Bounded expiration batches
  preserve pinned and shared-file owners; actual process checks cover 503 rows,
  ordered browser frames and restart. See [rescue scope and limits](GO-RESCUE.md).
- Native cluster identity, atomic code pairing, per-pair request authentication,
  persistent replay checks, automatic paged catalog pulls and actual peer-file
  range proxying are implemented. An independent two-process experiment verifies
  restart, 502-row pagination, the real timer discovering row 503, key rotation
  and revocation. Signed sockets now trigger durable add/edit/delete reconciliation;
  a second two-process check verifies offline edits, receiver restart and an older
  native snapshot restored beyond the old cursor. Epoch rotation also covers
  relative restore destinations. Full legacy peer-event/config/failover workflows
  remain incomplete and outside the narrowed core delivery scope.
  See [cluster scope, limits and measurements](GO-CLUSTER.md).
- Native reverse-proxy trust, live HTTPS/CSP enforcement and optional API quotas
  now apply before route dispatch. Login and share quotas use the same resolved
  client identity. Text compression streams gzip/deflate/Brotli with bounded
  encoder concurrency, waits and network writes; raw media/ranges are preserved.
  Actual socket, process and independent decoder checks pass. See
  [HTTP policy and remaining security limits](GO-HTTP-SECURITY.md).
- Signed share creation/listing/revocation, expiry/signature rejection,
  partial transfers, access counters and configurable request limiting.
- The latest full black-box run against the Go executable passes
  **246 of 324 tests**, with **21 of 36 files passing** (217.01 seconds).
  The remaining **78 failed cases in 15 files** are recorded failures, not
  waived expectations. This live-cluster run used one contract worker. Peer WS
  authentication now passes (3/4 cases still fail); maintenance again differs
  on the legacy non-growth VACUUM assertion. The preceding cluster checkpoint
  passed 246/324 in 62.92 seconds with 22/36 files passing. Its cluster/peer
  contracts improved from 33 to 25 failures;
  the file suite adds one failure for the real peer proxy's error/cache headers
  instead of its former fabricated response. Both periodic WebSocket/rescue
  contracts pass. The preceding rescue checkpoint passed 239/324. The
  prior session checkpoint passed 236/324; its snapshot-backup terminal-frame
  timing failure is absent in this run (backup 16/17, metadata difference only).
  The HTTP transport checkpoint passed 242/324; session
  revocation adds five failures in auth-password/system for deliberately changed
  legacy behavior, including three cascading limiter-counter expectations.
  See [session lifetime coverage and differences](GO-WEBSOCKET-SESSIONS.md).
  The FTP checkpoint passed 239/324. HTTP security now
  passes 4/5: its remaining case expects an Express framework header on the
  HTTPS redirect; Go omits that header. Native tests cover all HTTPS branches.
  The development launcher now translates its production-cookie scenario to
  Go's explicit Secure-cookie option; production does not read NODE_ENV.
  The earlier encrypted-backup checkpoint passed
  238/324: a file-token case differed only in the request normalizer placeholder
  (`filetoken:1` versus `filetoken:3`); status 200, headers and file hash matched.
  Separate mint requests can cross a second and produce different expiry/signature
  values in both implementations. The current file suite passes 13/14, with
  only the peer-proxy difference above; that separate file-token
  timing assumption still needs correction in the native contract runner.
  Another difference is the additional SFTP host-key fingerprint and FTP
  passive-mode/CA fields in provider
  metadata (backup 16/17). Maintenance is 7/8 in this run. Its earlier
  VACUUM failure reproduced legitimate 129 → 130 page growth; the additional
  host-key table changes the fixture's packing again. Actual sizes remain
  visible, and one green run does not prove VACUUM never grows a database. These are
  fixture-based HTTP/WebSocket contracts, not live Telegram or browser E2E.
- Passing domains include accounts, basic authentication/setup, shares, queue controls,
  chats, downloads/groups, local files/static assets, configuration, AI library reads
  and edits, dedup, deletion, thumbnails, faststart, database/file maintenance
  and system reads. Credential revocation and system revoke-all deliberately differ
  from the frozen expectations described above. Telegram-action validation and preflight
  contracts now pass 7/7. Inventory and two Go packaging/smoke fixtures
  are also included in the totals. Normal WebSocket messages retain
  `{type,payload}`; released event families that use top-level fields remain flat.
- The native chat-access projection, single-flight recheck job, gallery queries
  (including peer rows, search, paging, pinning and durations), group sidebar
  federation, per-group files/stats, cached avatars, group edits and both
  refresh jobs match their frozen HTTP/WebSocket contracts. Refresh jobs retain
  terminal status in memory and join their workers during shutdown.
- Focused Go regressions exercise secret redaction, partial config saves,
  config notifications without credentials, shared-file reference retention,
  directory traversal/symlink containment, explicit purge confirmation and
  retrying persisted file cleanup after restart.
- Single-row deletion verifies the requested path and retains shared-file
  references; path deletion intentionally removes all references. Bulk deletion
  runs asynchronously, shares the duplicate finder's single-flight guard,
  retains progress/results and joins before database shutdown. Deletions reuse
  the ingestion outbox for durable thumbnail/seekbar cleanup. Cached seekbar
  metadata and sprites are served through directory-confined Go handlers.
- Group/file purges and factory reset now have durable Go jobs with transactional
  catalog/config/outbox changes, restart recovery and monitor/maintenance
  coordination. Native tests cover rollback, shared files, symlinks, active
  transfers and prevention of reindex resurrection. Two frozen purge scenarios
  differ because the new implementation fixes orphaned files, incorrect file
  counts and stale access records; the unchanged legacy suite passes 6/8.
  See [native purge behavior and verification](GO-PURGE.md).
- Native Telegram session storage uses authenticated encryption and atomic
  replacement. Tests cover reopening, wrong secrets, tampering, cancellation,
  private permissions, import preservation and corrupt-state rejection. This
  verifies the adapter/storage layer; it is not a live Telegram E2E run.
- The download handoff exclusively claims each queued identity before network
  I/O, checks the declared media size, honors cancellation, and publishes with
  an OS-level exclusive rename. Race regressions cover competing workers and
  a destination created during the download. Creation and publication remain
  bound to directory handles even when an ancestor is renamed during transfer.
- The application ingestion boundary extracts exact Telegram document/photo
  identities from MTProto messages, including progressive photo sizes, without
  converting 64-bit IDs through floating point. Existing catalog references
  persist dedup across restart. Only active coordination lives in memory.
- Ingestion hashes bytes during transfer and merges identical content across
  different Telegram IDs. Reuse checks file identity, size, modification time,
  OS change token and previous verified SHA; missing or changed candidates are
  rejected. Message edits serialize and invalidate obsolete analysis and cached
  thumbnails/seekbar files through a durable cleanup queue.
- A publication journal recovers a completed file when catalog registration
  failed. Message generations prevent an older journal entry from reverting a
  newer edit. Interrupted claims return to the durable pending queue; starting
  the monitor resumes them with their original account.
- A Go integration test exercises raw MTProto metadata through application
  ingestion, WebSocket notification, authenticated HTTP range serving, deletion
  of one shared-file reference and restart. Its Telegram byte transport is a
  fixture. The native gotd media transport compiles but has not been exercised
  against Telegram's network.

- Native monitor start/stop/restart and auto-start now feed real account updates
  through durable SQLite claims into ingestion. Injected-account HTTP integration
  covers update → queued work → actual file, duplicate replay without a second
  transfer, active byte progress, shutdown during transfer and restart recovery.
- Account fingerprints and OS locks prevent duplicate authentication-key owners
  and concurrent servers recovering the same library. Stop cancels account startup
  promptly and joins account/worker lifetimes before closing SQLite.
- Telegram cursors and channel access hashes persist by account/user. A regression
  using the real gotd update Manager and fake RPCs verifies that channel difference
  edits commit before cursor advancement. Oversized gaps cannot advance the old
  cursor; unresolved durable recovery markers prevent restart.
- Equal-second edits use Telegram ordering (channel PTS across accounts; global
  PTS within one account). Newer observations of unchanged media update ordering
  without requeueing. Refresh preserves user/chat entities and rechecks filters;
  a rejected replacement is durably skipped. Deadlines bound transfer attempts.
- Linux process smoke check: HTTP health → SIGTERM exit 0 → reopen the same data
  directory → SIGTERM exit 0. Linux, Windows amd64 and macOS arm64 server builds
  pass; Windows/macOS binaries were not run natively.
- The monitor contract file passes **8/8**, including history and native
  resync/restart maintenance. Name/avatar refresh now reads complete Telegram
  metadata through the shared accounts, preserves chosen names, batches SQLite
  changes and confines atomic avatar writes. Fixture integration verifies
  cancellation, pins, rollback, purge and restart with actual file bytes.
  See [maintenance scope and performance](GO-MONITOR-MAINTENANCE.md).

Native account management now runs through Go: filesystem account discovery,
encrypted phone/code/2FA login, bounded cancellation and expiry, durable add and
remove journals, config metadata merge, legacy-session preservation with an
explicit import marker, matching group-pin and recovery-marker cleanup, and one
monitor refresh per successful mutation. The wizard retains the password prompt
when Telegram's optional hint request fails and treats gotd's nil-on-cancel
result as a terminal error. HTTP integration reopens the encrypted gotd session;
the frozen accounts contract is green. Live Telegram E2E remains unverified.

Channel update gaps now persist a recovery marker together with the remote PTS.
On the next authenticated account start, Go paginates `messages.getHistory` for
the affected channel, feeds every recovered message through the normal filter,
queue and dedup path, then advances the channel cursor and removes the marker in
one durable completion step. Missing access hashes, incomplete markers and
global account-wide `updates.getDifferenceTooLong` still stop startup with the
marker intact; they are not silently treated as healthy.

Channel history repair continues through short slice/channel responses instead
of treating their length as proof of completion. Every RPC has a 30-second
deadline. The pager validates the requested channel, skips overlapping message
IDs, and rejects a nonadvancing cursor. Service messages and deleted-message
placeholders advance pagination without entering the media queue. Native tests
interrupt both a later RPC and the ingestion sink, reopen SQLite, and verify
that the old cursor and recovery marker survive until all pages are accepted.
This repairs automatic channel-gap recovery. Public history start, status,
cancellation, deletion and restart resumption now also run through the shared
Go accounts and queue. Jobs-only runs do not enable live subscriptions; their
cursor checkpoints commit with accepted work. Rescan verifies existing bytes
and repairs missing files. Text-link extraction/export remains incomplete.
See [history behavior and evidence](GO-HISTORY.md).

Direct message URL downloads now resolve fresh messages through the shared Go
account pool and commit explicit work into its durable queue. They work with
live monitoring disabled, preserve account pins, check subscription-independent
suspension/ownership rules, and reuse or repair existing bytes through the same
dedup library. HTTP/SQLite/filesystem fixtures verify restart, rollback, purge
cancellation and per-account transport. Strict message-link parsing corrects
legacy private-ID conversion and rejects ambiguous message IDs. See [URL scope,
protocol references and validation](GO-URL-DOWNLOADS.md). Album/comment expansion
and live network/browser E2E remain outside the verified boundary.

Stories now use native peer/all-page reads and full-object downloads through the
shared accounts and durable queue. Story IDs occupy a separate catalog namespace
from messages; identified legacy story rows migrate without changing row IDs or
files. Fresh media identities reuse dedup, stale references refresh through the
story RPC, and accepted batches survive restart. Account-scoped user access hashes
persist without advancing Telegram update cursors. The native proxy probe checks
TCP reachability with bounded DNS/dialing and private-target rejection. Fixture tests cover
these workflows; see [Stories, proxy probe and validation](GO-STORIES.md).

Configured SOCKS4/5 and MTProxy routing now reaches every native account and the
login wizard, including media DC connections. Bounded handshakes, concurrent
destination selection and cancellation retain the proxy route. Invalid settings
and protocol failures produce errors rather than direct connections. Native
socket and HTTP fixtures verify routing, restart, login snapshots and secret
redaction; public-proxy/live Telegram E2E remains unverified.
See [proxy configuration, protocols and evidence](GO-PROXIES.md).

A WebSocket handshake race exposed by the full contracts is fixed: subscription
now precedes writing HTTP 101, so an immediate browser action cannot lose its
first event. A deterministic native test reproduces the old ordering's failure
and passes ten race-enabled repetitions with the fix. Contract expectations and
timing were not changed. One earlier full run also hit a test-harness port
allocation collision; the final complete run executed all 324 tests without
skips. Atomic port allocation remains work for the native test runner.

Media subscription filters now use the UI's `files` key and distinguish voice
messages from music using Telegram's audio `voice` attribute. Both remain
`audio` in the catalog. Images sent as documents use `photos`, GIFs use `gifs`,
and video/animated stickers retain the opt-in `stickers` switch. A WebP without
a sticker attribute is an image. Classification preserves the exact document
identity and account-specific file location, including IDs above JavaScript's
safe integer range. A native monitor integration test verifies that disabled
files, voice messages and images never enter the queue or byte transport while
enabled music downloads normally. These are fixture tests, not live Telegram
or browser E2E evidence. The policy uses Telegram's
[voice attribute](https://core.telegram.org/constructor/documentAttributeAudio)
and [history pagination](https://core.telegram.org/api/offsets) definitions;
see also [messages.getHistory](https://core.telegram.org/method/messages.getHistory).

The native `/api/dialogs` endpoint now fans out `messages.getDialogs` across
every running Go account, reads active and archived folders, merges duplicate
marked peer IDs, preserves configured filters/forwarding defaults and exposes
the durable chat-access registry. The projection is covered by fixture tests;
live Telegram dialog ordering and access failures still need an authorized
network E2E run.

Dialog reads now paginate in batches of at most 100, explicitly select both
folder IDs (including the presence flag for zero), and match the offset message
to its peer. A short slice is not treated as the final page. Pinned entries,
overlapping pages and nonadvancing cursors have native regressions. A failed
account/folder now fails the request instead of publishing an incomplete list
as successful. Stopped accounts are rejected and in-flight reads cancel with
their account. Reusable channel hashes are cached per account without advancing
update cursors or poisoning ingestion on browser cancellation. The UI still
requests at most 500 dialogs per folder/account; this bounded list is not an
  exhaustive recovery index. Native recovery now uses a separate complete
  enumeration with the same pager and explicit error bounds.
See [dialog pagination and verification](GO-DIALOGS.md).

Recovery cleanup now has native list/count/status/resolve/disable/ignore/
unignore/reassign/delete routes. The resolver enumerates active and archived
dialogs, resolves public usernames when necessary and probes history readability
before changing a group. Explicit account pins are enforced; ambiguous names,
target collisions and concurrently changed configuration are preserved for
inspection instead of being silently merged. Config, media/queue IDs, ingest
journals and queue history change transactionally per group, retaining physical
file paths. Reassignment joins active transfers and forces account-specific
message refresh before the next download. Native HTTP/SQLite/byte-transfer tests
cover these paths, rollback and shutdown. Purging through recovery reuses durable
cleanup, retains shared files and supports retry after failure. The unchanged
frozen recovery suite passes 8/9: its final difference is the correction from
leaving a file behind/counting zero to actually deleting it/counting one.
See [native recovery behavior and evidence](GO-RECOVERY.md). Live network/browser
E2E remains unverified.

Queue control is now durable in Go. Global pause state and per-job pause flags
are stored in SQLite, migrated into existing databases, and checked by every
claim. Admin routes support pause/resume/cancel/retry, retry-all, batch actions,
clear-finished and persisted queue-history snapshots; cancelling an active row
also cancels its in-flight media context. The queue contract and focused store
regressions cover the stopped-engine security boundary, idempotent cleanup and
the durable pause/claim behavior.

The former development-time contract runner has been removed. Its frozen
responses, schema and fixtures remain historical references; active regression
checks run in Go. See the cleanup verification near the top of this document.

## Historical full-migration checklist

This broader checklist predates the owner's scope reduction. Optional AI, advanced
cluster and cloud-provider ports are deferred, not requirements for the current
core delivery. Recheck current implementation and evidence before selecting an
item; the scope and verification sections above take precedence.

- Validate native Telegram login/account management, history, URL and Stories
  jobs on a real account; complete account-wide oversized-gap repair, broader
  account routing and forwarding. Validate configured proxies on the live
  network as well. Channel history gaps are
  repaired natively; an unresolved global
  or incomplete marker still prevents restart and must never be cleared merely
  to make startup succeed.
- Complete queue rate limiting, priority/TTL handling, old queue-history import
  and full browser interaction. Durable Go pause/resume/cancel/retry controls
  and the queue snapshot are implemented, but the complete queue workflow still
  needs browser and performance coverage.
- Complete Drive, Dropbox, local/snapshot staging cleanup and empty S3/FTP
  reservation boundaries. Validate encrypted backup and restore with real
  providers; S3/SFTP/FTP wire fixtures and loopback interoperability checks do
  not establish live provider or full migration E2E coverage.
- Resolve the 14 remaining contract files: cluster/peer/cluster-WebSocket,
  AI jobs, NSFW, seekbar, backup provider metadata, recovery, purge, security,
  updates, federated files, plus auth-password/system compatibility
  for prompt session revocation. Three cleanup corrections and the
  added SFTP/FTP form fields and omitted Express response header are documented
  differences, still counted as failures.
  The old VACUUM non-growth assumption also remains incorrect in general even
  though the current schema's fixture passes it.
  A low-level Go projection or helper is not a replacement for a public workflow.
- Finish the native test runner, remove the old server sources and launchers,
  and run the full HTTP/WebSocket/browser/data-migration E2E and performance
  checks. Live Telegram E2E still requires an authorized test account.

Established WebSockets now close on application session revocation, expiry and
shutdown. Password changes revoke previous admin sessions, and disabled guest
access revokes guest sessions even when changed through the generic config API.
Native wire/race/process coverage verifies the deliberate legacy differences;
see [session lifetime and remaining limits](GO-WEBSOCKET-SESSIONS.md).

## Implementation references

Media opens and cleanup use directory-relative `os.Root` operations so a
symlink or path rename cannot escape the library. Cleanup paths are persisted
in SQLite in the deletion transaction; cleanup rechecks retained references
under the writer lock. Failures remain queued and are reported, then retried
on restart or the next deletion. SQLite and filesystem operations are not a
single atomic transaction. The durable queue makes interrupted cleanup
recoverable. See the [Go traversal-resistant file APIs](https://go.dev/blog/osroot)
and [os.Root reference](https://pkg.go.dev/os#Root).

The module requires Go 1.26 or newer and selects Go 1.26.8. Docker and the main
Go CI workflows use the same toolchain. Other API references:
[net/http](https://pkg.go.dev/net/http),
[SQLite driver](https://pkg.go.dev/modernc.org/sqlite),
[gotd](https://gotd.dev/docs/intro/),
[Telegram API](https://core.telegram.org/api),
[update ordering and differences](https://core.telegram.org/api/updates).
Channel gap repair uses [messages.getHistory](https://core.telegram.org/method/messages.getHistory)
with the account's persisted channel access hash.
The adapter targets [gotd v0.115.0 update internals](https://github.com/gotd/td/tree/v0.115.0/telegram/updates):
`state_channel.go` asynchronously dispatches difference edits before saving PTS,
so a handler-only persistence latch is insufficient. `update_api.go` commits
all difference payloads before returning them to that manager.

Exclusive media publication uses Linux `renameat2(RENAME_NOREPLACE)`, macOS
`renameatx_np(RENAME_EXCL)` and Windows `NtSetInformationFile` with
`FileRenameInformation`, `ReplaceIfExists=false` and a directory handle.
An OS/filesystem refusal is returned to the caller. See
[Go syscall wrappers](https://pkg.go.dev/golang.org/x/sys/unix#Renameat2) and
[Windows FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).
Linux regression tests pass; Windows amd64 and macOS arm64 test binaries were
cross-compiled, not executed natively.

## Focused ingestion measurement

`go test -run '^$' -bench BenchmarkLibraryForwardedMedia -benchtime=100x ./internal/download`
measured **1.08 ms/op with one existing reference** and **2.39 ms/op with 1,000
references** on this Linux amd64 development machine (Core Ultra 7 270K Plus).
The fixture is a verified 1 MiB file; every timed operation runs without a
network transport and must reuse the existing file. This measures catalog
registration and verified-cache lookup, not Telegram network throughput or the
complete application. The benchmark source is included for repeatable comparison.
