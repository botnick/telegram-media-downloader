# Go migration status

This branch is still under development. Its packaging runs `tgdl-server`,
but the Go application is not yet a complete replacement for the released
downloader. Passing package tests does not establish end-to-end Telegram
functionality. Do not deploy this branch over a working library yet.

## Verified in the current application

- Authentication, first-time setup, password changes/reset, guest access,
  session expiry/renewal, cross-origin guards and browser WebSocket transport.
- Signed share creation/listing/revocation, expiry/signature rejection,
  partial transfers, access counters and configurable request limiting.
- The latest full black-box run against the Go executable passes **210 of 324
  tests**, with **22 of 36 files passing**. The remaining **114 failed cases in
  14 files** are still release blockers, not waived expectations. These are
  fixture-based HTTP/WebSocket contracts, not live Telegram or browser E2E.
- Passing domains include accounts, authentication, shares, queue controls,
  chats, downloads/groups, files/static assets, configuration, AI library reads
  and edits, dedup, deletion, thumbnails, faststart, database/file maintenance
  and system/session maintenance. Inventory and two Go packaging/smoke fixtures
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
- The two basic monitor control contract cases matched their frozen responses.
  The partial contract command still exits nonzero because the harness requires
  all history/maintenance entries; **the complete monitor suite has not passed**.

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

The contract runner still uses development-time JavaScript dependencies to
compare the Go server with frozen responses. It does not launch a Node server
for these Go-target tests. Removing this test tooling remains part of the
migration; the current source tree is not yet free of Node dependencies.

## Required before release

- Validate native Telegram login/account management on a real account; complete history/URL jobs,
  account-wide oversized-gap repair, account routing/proxies, stories and
  forwarding. Channel history gaps are repaired natively; an unresolved global
  or incomplete marker still prevents restart and must never be cleared merely
  to make startup succeed.
- Complete queue rate limiting, priority/TTL handling, old queue-history import
  and full browser interaction. Durable Go pause/resume/cancel/retry controls
  and the queue snapshot are implemented, but the complete queue workflow still
  needs browser and performance coverage.
- Complete backup, cluster/peer/cluster-WebSocket, AI-job, NSFW, seekbar
  maintenance, monitor/history, Telegram-action, recovery, purge, security,
  update and periodic WebSocket contracts. These are the 14 failing files in
  the latest full run. A low-level Go
  projection or helper is not a replacement for the public workflow.
- Finish the native test runner, remove the old server sources and launchers,
  and run the full HTTP/WebSocket/browser/data-migration E2E and performance
  checks. Live Telegram E2E still requires an authorized test account.

Existing WebSockets can remain open after their HTTP session is revoked,
matching the frozen contract. Closing those connections promptly remains
security debt to address deliberately with updated compatibility coverage.

## Implementation references

Media opens and cleanup use directory-relative `os.Root` operations so a
symlink or path rename cannot escape the library. Cleanup paths are persisted
in SQLite in the deletion transaction; cleanup rechecks retained references
under the writer lock. Failures remain queued and are reported, then retried
on restart or the next deletion. SQLite and filesystem operations are not a
single atomic transaction. The durable queue makes interrupted cleanup
recoverable. See the [Go traversal-resistant file APIs](https://go.dev/blog/osroot)
and [os.Root reference](https://pkg.go.dev/os#Root).

The module requires Go 1.25 or newer and selects Go 1.26.8. Docker and the main
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
