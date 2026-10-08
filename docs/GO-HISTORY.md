# Native Telegram history jobs

The Go server now owns the public history start/list/status/cancel/delete routes.
Accepted requests persist in `tgdl_history_jobs` before acknowledgement. Only one
enumerator per group can run; the database also enforces this constraint.
Shutdown preserves running jobs and their committed account, bounds and cursor.
Startup resumes them after database and purge recovery.

History uses the same authenticated accounts, durable work queue, workers and
identity/content deduplication as live updates. Starting a history job while the
monitor is stopped creates a jobs-only run: live updates are ignored and live
queue rows are not claimed. Pending automatic gap recovery can still persist
its backlog, which waits for live monitoring before transfer. Starting the
monitor promotes the existing run without creating another account client.
Stopping the live subscription keeps explicit history work alive. Internal
account changes, purge and application shutdown still stop the whole run; an
interrupted request reports an error, while application shutdown preserves it
for restart. Accounts opened only for jobs close after enumeration and queued
manual transfers have drained.

Purge always joins the account engine, including jobs-only transfers. Its
transaction also removes resumable history for the purged group (all groups for
reset), and concurrent unresolved jobs whose destination cannot yet be proven.
Those requests cannot auto-register a removed group after purge or restart.

## Filtering, bounds and progress

- History may download a disabled group without enabling its live subscription.
  Media, user and topic filters, account pins, suspension and peer ownership
  still apply. A previously unconfigured dialog is registered disabled.
- A pinned account is authoritative. An unpinned request selects the first
  account in stable ID order and persists that choice. Lookup never switches
  accounts after an RPC error. Numeric peers without a reusable hash are looked
  up in that same account's complete active/archive dialog index.
- `pull-older` starts below the catalog's smallest positive message ID.
  `catch-up` reads descending from newest, above the largest catalog ID.
  `rescan` starts at newest, or below an explicitly supplied offset. Synthetic
  negative catalog IDs do not determine history bounds.
- Limit defaults to 100 and is bounded to 1–50,000; zero means unlimited.
  Service/deleted placeholders count as processed messages and advance the
  cursor. Short pages continue; wrong peers and nonadvancing cursors fail.
- Each accepted queue row and the job's next cursor/counters commit in the same
  SQLite transaction. A failed checkpoint cannot leave an uncounted accepted
  message, or skip a message that never reached the queue.
- The released `downloaded` field counts accepted queue work, not finished byte
  transfers. Terminal history status means enumeration ended. Queue progress
  and `download_complete` report actual file completion separately.
- Rescan rechecks completed/skipped/failed work for the same current identity.
  The library reuses a verified existing file or downloads missing/changed
  bytes. Requeued verification is counted as accepted work even when no new
  bytes are needed. Delayed older versions cannot replace a newer attachment.
- Cancellation stops enumeration; already accepted work remains in the normal
  queue and can be controlled through its pause/cancel endpoints.

Queue claims prioritize live/URL work over history. History respects the
configured backpressure cap (bounded to 1–10,000), maximum wait and short/long
break cadences. Zero disables a cadence; enabled breaks use deterministic
2-second/60-second pauses. Per-page RPCs are bounded to 30 seconds. The global
queue's complete rate/TTL policy and cross-job account-wide pacing remain
separate unfinished release work.

Finished history projects to the existing `history_jobs` KV value. Native
completion and this projection commit together; retention bounds persisted
finished entries. Live entries remain available for five minutes, while
`/api/history/jobs` merges persisted/live entries and returns 30 recent jobs.
Deletion preserves running jobs and emits the released flat WebSocket events.

## Validation and database dependency

Native tests cover actual HTTP start through account fixtures, Telegram message
metadata, SQLite, queue, real file bytes and deduplication; disabled subscriptions;
cancel/single-flight; monitor promotion/demotion; bounds and auto-registration;
checkpoint rollback; backpressure timeout; rescan reuse and missing-file repair;
shutdown and resumption at the committed cursor. Telegram pager fixtures cover
channels, groups, users, exclusive bounds, overlap, service/deleted messages,
entities, short pages and nonadvancing/foreign responses. These do not constitute
a live Telegram network or browser E2E run.

Cancellation testing reproduced a leaked-statement lock in `modernc.org/sqlite`
v1.36.0: immediate reopen failed with `SQLITE_BUSY` in 5 of 10 repetitions. The
driver is now pinned to v1.60.1 with its required libc v1.77.1, raising the module
minimum to Go 1.26; the selected toolchain remains 1.26.8. All 10 repetitions
passed after the upgrade. Pool DSNs apply busy timeout, synchronous mode and
foreign keys to every replacement/new connection. This addresses an upstream
[cancellation leak](https://gitlab.com/cznic/sqlite/-/merge_requests/81); see the
[pinned release changelog](https://github.com/modernc-org/sqlite/blob/v1.60.1/CHANGELOG.md).

Protocol references: [messages.getHistory](https://core.telegram.org/method/messages.getHistory),
[Telegram pagination](https://core.telegram.org/api/offsets), and
[gotd v0.115.0](https://github.com/gotd/td/tree/v0.115.0).

At the history checkpoint, the full frozen HTTP/WebSocket run passed 213/324
cases (22/36 files); see [migration status](GO-MIGRATION-STATUS.md) for the latest run.
The monitor file improves from 2/8 to 5/8; its remaining failures belong to
resync/restart maintenance, not the three history contract cases. Full Go race
tests and vet pass. Focused lifecycle regressions also pass after the final
purge/account/drain changes. Linux builds and Windows amd64/macOS arm64
cross-builds pass; the foreign binaries were not executed natively.

`BenchmarkAtomicHistoryEnqueue` (1,000 iterations, Linux amd64, Core Ultra 7
270K Plus) measured 126,605 ns/op, 3,227 B/op and 68 allocs/op. Each iteration
commits an encoded Telegram message and its cursor checkpoint in one SQLite
transaction. Database creation is excluded; this is not a network throughput
measurement or comparison with the former runtime. Reproduce with:

```sh
go test ./internal/engine -run '^$' -bench '^BenchmarkAtomicHistoryEnqueue$' -benchtime=1000x
```

Direct message links now use the same pool and queue; see [URL downloads](GO-URL-DOWNLOADS.md).
Still required: text-link extraction/export parity,
broader account routing/proxies, live Telegram/browser verification, and the
remaining migration domains. History support alone does not make the Go server
a complete replacement for the released application.
