# Native rescue retention and live dashboard status

Go now records rescue retention before a message enters the download queue,
retains received source-deletion events through transfer and restart, and
removes expired catalog entries through the existing durable file-cleanup
journal. This applies to live messages, history and explicit URL downloads.
Stories retain their separate identity and are excluded from rescue retention.

This is fixture-verified behavior, not a live Telegram reliability guarantee.
See [remaining migration gates](GO-MIGRATION-STATUS.md).

## Retention and source deletion

The global `rescue.enabled` setting supplies the default. A group's `rescueMode`
can explicitly select `on` or `off`. Positive `rescueRetentionHours` overrides
global `rescue.retentionHours`; the default is 48 hours and the effective range
is 1–720 hours. Numeric strings are accepted for migrated configuration.

`tgdl_rescue_messages` stores the first observed deadline, source account and
channel, keyed by group/message. Queue transactions include this receipt, so a
source-delete update can mark the message while it is still waiting to download.
Replay and edits do not extend the deadline. Enabling rescue does not convert
an already permanent catalog entry into an expiring one.

The account update observer persists deletion receipts before returning to the
Telegram update manager. Persistence failure prevents cursor acknowledgement.
It also runs for accounts connected only to execute history or URL jobs.

Channel deletions match channel/message identity across accounts. Ordinary
message deletions have no peer identifier, so matching is confined to the
original account's non-channel receipts. An identically numbered message in
another account or channel is not rescued accidentally. Existing legacy channel
rows can match an exact raw or marked channel group ID. Legacy ordinary rows
without source-account provenance cannot be matched safely and remain subject
to their stored retention deadlines.

Catalog publication applies the receipt in the same SQLite transaction that
registers the file. A deletion received during transfer clears `pending_until`
and persists `rescued_at` when the file is published. The publication journal
uses the same registration path after restart. Dedup siblings keep separate
retention states even when they reference the same physical bytes.

Group recovery moves receipt keys with catalog/work/history keys in one
transaction. A conflicting destination receipt prevents the remap; original
source-account/channel provenance and timestamps are preserved. Group and full
purges remove their corresponding receipts.

## Expiration and file safety

The first sweep runs five seconds after startup. Subsequent sweeps use
`rescue.sweepIntervalMin`, default 10 minutes, bounded to 1–1440 minutes.
Saving rescue settings reschedules the next pass for five seconds later.
Already pending rows are still processed if rescue is subsequently disabled;
the switch controls which new messages receive retention deadlines.

Each pass selects at most 500 expired, unrescued, unpinned catalog rows. The
catalog deletion, derived-asset invalidation, physical-file cleanup requests
and last nonempty batch count commit together. Rollback leaves files intact.
When a full batch succeeds, the next pass runs after one second to drain large
backlogs without occupying the SQLite writer for one unbounded transaction.
Only one sweep runs at a time, with a one-minute attempt context.

Physical cleanup follows the committed outbox and rechecks remaining path
owners under the database writer lock. A rescued, pinned or permanent sibling
retains shared bytes. Directory-handle containment and existing alias checks
also apply. Failed unlink operations remain in the journal for later passes or
startup recovery; they do not restore the already deleted catalog row. The
reported sweep count therefore means catalog entries removed, not confirmed
physical files or disk bytes reclaimed.

Pinned rows are preserved. `/api/rescue/stats` counts all unrescued pending rows,
including expired rows awaiting cleanup, and retains the last nonempty batch
count across process restarts. An empty pass does not erase that count. Query
errors return an error instead of invented zero counters.

Rescue receipts currently remain until group/full purge. Their on-disk history
grows with observed messages; this is not an in-memory identity cache. Dedicated
receipt compaction is not implemented.

## Browser updates and worker lifetime

One application-owned loop publishes `monitor_status_push` every three seconds
using the same projection as `GET /api/monitor/status`. Another publishes
`stats_push` every 30 seconds with local catalog counts and total declared file
size. These totals count references, not unique allocated disk blocks or peer
catalog entries. Both events retain the `{type,payload}` shape and reach admin
and guest clients. The loops skip snapshot construction without subscribers,
use two-second query contexts and never overlap attempts.

The rescue sweep emits ordered flat `file_deleted` frames followed by a flat
`rescue_sweep_done` count and a stats update. One internal queue item carries
the deletion batch; the writer expands it into ordinary individual JSON
frames. A 500-row sweep therefore does not itself overflow the dashboard's
64-item queue. Role filtering applies to every frame, and a batch's writes
share a ten-second deadline bounded by session expiry. Revocation/shutdown
cancellation is checked between frames and closes a blocked transport.

The event hub remains bounded and nonblocking: batches are capped at 512 frames
per item, and a full subscriber queue can still drop later items. It is not a
durable event log or an acknowledged delivery protocol. Sustained overload and
browser resynchronization after lost events remain broader release concerns.

Application shutdown cancels and joins the periodic workers before closing
SQLite. No browser-specific timers, per-tick goroutines, external schedulers or
Node process implement these workflows.

## Verification and boundaries

Native race regressions cover:

- Received source deletion during a blocked transfer, then expiration of a
  duplicate sibling without deleting the rescued shared file.
- Queue-time receipts for live/history/URL work, transaction rollback, Stories
  exclusion and refusal to acknowledge a failed deletion observer.
- Account isolation for ordinary message IDs, permanent-file preservation,
  original deadlines, retention overrides and publication-journal recovery.
- Pinned/rescued/future/shared rows, bounded 500-row batches, SQL rollback and
  physical cleanup retry after reopening the application.
- Recovery group remapping and receipt collisions, HTTP/WebSocket projection
  agreement, idle subscriptions, cancellation and non-overlapping snapshots.
- Ordered batch delivery, per-frame role filtering and bounded queue capacity.

The independent process check uses Python's standard library against the built
Go executable, with a raw RFC6455 handshake/frame reader. It seeds 503 expired
rows plus a permanent shared-file owner, waits for real timers, checks both
500+3 deletion batches and all 503 frames, and verifies file retention/removal,
catalog counts, empty cleanup journal, restart persistence and SIGTERM exit 0.
The script is local development evidence; Python is not a runtime dependency.

The final full Go race suite and `go vet ./...` pass. Linux, Windows amd64 and
macOS arm64 builds pass with the foreign builds using `CGO_ENABLED=0`; the
Windows/macOS executables were not run. The unchanged frozen suite passes
239/324 cases in 23/36 files, including both periodic WebSocket/rescue cases,
in 58.42 seconds. Its other 85 failures remain counted and documented in the
migration status; no snapshots were rewritten to obtain these results.

Telegram transport in the native integration tests is injected. There has been
no live account or browser E2E run for this feature. Updates not received before
expiration cannot rescue bytes that were already deleted. Offline/account-wide
update-gap repair, source message-ID ambiguity in older catalogs and provider
availability remain outside these guarantees. A passing expired-row contract
alone does not establish the entire rescue workflow.

## References

- [Telegram channel deletion update](https://core.telegram.org/constructor/updateDeleteChannelMessages)
- [Telegram ordinary deletion update](https://core.telegram.org/constructor/updateDeleteMessages)
- [Telegram update sequencing and difference recovery](https://core.telegram.org/api/updates)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [Go directory-confined file operations](https://pkg.go.dev/os#Root)

These define the wire fields and storage primitives used above; transaction
ordering, retention policy and batching are application design choices.
