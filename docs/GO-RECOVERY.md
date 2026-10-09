---
title: "Recovery internals"
description: "Engineering note on the maintenance recovery page: resolving downloads whose chat or account changed."
parent: "Developer notes"
nav_order: 13
---

# Native recovery cleanup

The maintenance recovery page now calls Go for its list, count, status, resolve,
disable, ignore/unignore, account assignment and delete operations. Existing
HTTP shapes and recovery WebSocket events are retained. These routes require
administrator authentication.

## Resolution and account selection

The resolver reads active and archived dialogs from each connected account with
complete pagination, independent of the 500-entry UI limit. RPCs have 30-second
deadlines; the account-bound index/probe context lasts at most ten minutes and
cancels when that monitor stops. A failed folder/account aborts enumeration.
The 100,000-entry per-folder/account guard returns an error rather than claiming
the remaining groups do not exist.

Synthetic `unknown:` IDs match usernames, exact titles or their historic folder
spelling, including Unicode stripping, byte truncation and Windows reserved
names. Multiple peer IDs matching the same title are reported as
`ambiguous_title`. Public usernames can also be resolved through the native
Telegram API. Numeric channels absent from dialogs require an access hash
previously obtained by that same account.

Before committing a resolution, Go requests one history entry to establish
readability. An explicit account pin is authoritative. Unpinned candidates use
stable account order; a failed probe does not switch accounts silently.
The user can reassign a group explicitly. Missing/private peers retain failure
markers and a reason on the recovery page.

## Data integrity and work coordination

The engine remains active during lookup/probing. Before changing group IDs or
queued account ownership, recovery stops and joins its workers, then acquires
the media/config locks. It compares the current group against the probed config
snapshot, preserving concurrent changes as `config_changed`.

Each group's config, download/queue IDs, ingestion generations/journals, queue
history and successful access-state cleanup commit in one SQLite transaction.
Physical file paths stay unchanged. Conflicting destination groups or message
IDs are reported as `target_conflict`; unrelated rows are not overwritten.
Transactions are per group, so a later failure can leave earlier resolutions
committed. Status retains the completed results and the error. Resolution job
status itself is in memory; after restart the operator can rerun the operation.

Account reassignment preserves pending bytes as queued metadata, never as
permission to reuse another account's file reference. A durable
`refresh_required` flag forces message refresh with the selected account before
the next byte transfer. Channel PTS remains comparable across accounts; global
PTS from the previous account is cleared. Per-job/global queue pauses are
preserved. Updates and queued ingestion enforce the configured account pin.
Disable/remove joins old transfers and skips remaining native work for the
affected group; historical download rows remain unless purging was requested.

Recovery edits and purge requests exclude conflicting mutations. Monitor
restart occurs once per bulk operation, has a 30-second deadline, and does not
start while failed durable cleanup remains pending. Shutdown joins recovery
workers before SQLite closes.

## Corrected deletion behavior

`delete` with `purgeDownloads:false` removes configuration/access records and
keeps downloaded files/catalog rows. With `purgeDownloads:true`, each group's
request and cleanup plan use the [durable native purge](GO-PURGE.md). It removes
unshared source files and derived caches, preserves other groups' references,
and resumes unfinished plans after restart or a retry of the same request.
An interrupted bulk request can have completed earlier groups; success is
returned only after every requested group completes.

The frozen legacy recovery scenario expected `totalFiles:0` while leaving its
source file orphaned. Go deletes that file and returns `totalFiles:1`. This is
the sole remaining recovery contract difference (8/9 pass). The old snapshot
is unchanged, and native tests assert physical deletion plus shared-file
retention. The eventual Go-only contract runner must encode the corrected
behavior explicitly, not hide the difference or recreate the orphan.

## Verification and limits

- Full `go test -race -timeout 120s ./...` and `go vet ./...` pass. Targeted
  app/engine/Telegram/store race tests also pass after final changes.
- Native tests cover full enumeration beyond the UI cap, username/hash lookup,
  failed probes, pins, ambiguous names, catalog collisions, transactional
  rollback, concurrent config edits, single-flight/shutdown, genuine injected
  byte-transfer cancellation, account-specific reference renewal, existing
  database migration, durable cleanup retry and shared-file retention.
- Latest complete frozen HTTP/WebSocket suite: 210/324 pass, 114 fail in 14
  files. Three failed scenarios reflect documented cleanup corrections (two
  purge, one recovery); other required domains remain incomplete.
- `BenchmarkRecoveryList1000Groups`, ten iterations on Linux amd64 / Core Ultra
  7 270K Plus: 14,827,269 ns/op (14.8 ms), 4,507,543 B/op, 55,293 allocs/op.
  Setup is excluded; the benchmark includes authenticated HTTP handling,
  SQLite aggregation and JSON output for 1,000 groups. It measures local list
  serving, not Telegram/network performance or a comparison with the old server.

Telegram RPCs and account transports in these tests are injected fixtures.
Live Telegram and browser E2E, old queue import and the broader migration
release gates remain required. No production deployment is implied.

## References

- [Telegram dialog pagination](https://core.telegram.org/method/messages.getDialogs)
  defines the folder and offset fields used by enumeration.
- [Username resolution](https://core.telegram.org/method/contacts.resolveUsername)
  supplies a peer and its entities for public-name lookup.
- [History retrieval](https://core.telegram.org/method/messages.getHistory)
  is used for the readability probe.
- [File reference refresh](https://core.telegram.org/api/file_reference)
  explains retaining source-message context for reference renewal.
- [Minimal entities](https://core.telegram.org/api/min) documents why minimal
  access hashes cannot be cached as unrestricted peer credentials.
