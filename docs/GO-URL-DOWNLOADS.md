---
title: "Message link downloads"
description: "Engineering note on resolving t.me message links and queueing their media."
parent: "Developer notes"
nav_order: 16
---

# Native Telegram message links

`POST /api/download/url` now resolves Telegram message links and accepts their
media into the shared Go download queue. It requires an administrator session
and never launches another downloader or server runtime. The existing browser
paste-link forms call this endpoint without an adapter.

## Request and result

Send either a newline-separated `url` string or a `urls` array. The array takes
precedence, including an explicitly empty array. Requests are limited to 1 MiB
and 100 links. Missing links return 400, missing API credentials return 500,
and missing saved accounts return 409 with the released error strings.

Each item is independently resolved and committed. The response remains
`{success:true,results:[...]}`; each result retains the original `url` and an
`ok` boolean. Accepted items include `group`, `messageId` and `mediaType`.
Public media labels remain plural (`photos`, `videos`, `documents`, `gifs`,
`stickers`), with `voice`/`audio` distinguished by Telegram's audio attribute.
Catalog media types keep the shared ingestion representation.

`ok:true` means the queue accepted work, including verification of an existing
file. It does not mean that the transfer finished. A duplicate already pending
or transferring may return `ok:false` without an error, as in the released
enqueue result. Queue status and `download_complete` report subsequent progress.
Earlier accepted items survive a later item's error or the HTTP client leaving.
Items not yet committed when a request is cancelled are not accepted.

## Link parsing and account selection

- HTTP(S) `t.me`, `telegram.me` and `telegram.dog` message links, private `/c/`
  links, topic/message paths, `tg://resolve` and `tg://privatepost` are supported.
  Bare Telegram host/path strings, `tg:resolve` and `/s/` preview links are also
  accepted. Fragment and playback-position hints do not change the message.
- IDs must consist entirely of decimal digits and be positive. Message/topic
  IDs are bounded to signed 32-bit values. Private channel IDs are converted
  from MTProto to marked IDs by subtracting them from -1,000,000,000,000.
  The old prefix-stripping/string-concatenation bug is not reproduced.
- Conflicting/repeated routing parameters, extra path components, credentials
  in the URL, non-Telegram hosts and unsupported schemes are rejected. No
  HTTP request is made to the supplied address. Discussion-comment links are
  explicitly rejected rather than downloading the parent channel post.
- A configured account pin determines the source account. If resolving a public
  username reveals a numeric group's pin, the peer is resolved again using that
  account before reading the message. A changed peer is rejected. Unpinned
  requests select the first account in stable ID order. An RPC/access failure
  does not silently select another account.
- Numeric peers lacking a cached access hash use that account's complete dialog
  index. Message reads use the account-bound channel hash or the ordinary
  message RPC as appropriate. Responses must contain the requested message and
  exact peer; service messages have no downloadable media and deleted messages
  report unavailability. Channel PTS and returned user/chat entities are retained.
- One link selects one message, including when the message belongs to an album.
  Album expansion, comment resolution and arbitrary username-subdomain links
  are not implemented by this endpoint.

These address rules follow Telegram's [message-link definitions](https://core.telegram.org/api/links#message-links).
The transport uses [channels.getMessages](https://core.telegram.org/method/channels.getMessages)
and [messages.getMessages](https://core.telegram.org/method/messages.getMessages).
Each message RPC has a 30-second deadline, with a two-minute total resolution
and acceptance deadline per link, also bounded by the HTTP/application context.

## Queue, deduplication and shutdown

URL jobs use the same authenticated account pool, SQLite queue and byte workers
as live updates and history. With the monitor stopped, the pool runs jobs only;
it does not enable subscriptions or claim live backlog. Manual leases keep the
pool alive during lookups, and the shared drainer closes it after manual work
finishes. Starting the monitor promotes that same pool. See [history lifecycle](GO-HISTORY.md).

Explicit URLs bypass subscription media/user/topic filters and may download
disabled groups. Account pins, suspension and peer ownership remain enforced at
acceptance and ingestion. Unknown groups are registered disabled in the same
transaction as their first accepted queue row. Existing unsigned group IDs are
retained when they already own the catalog; marked IDs take precedence.

The persisted `url` origin gives these jobs live priority ahead of history.
An explicit request promotes an existing history/live row instead of making a
second queue. Promotion preserves the ordering watermark of an unchanged
attachment; a delayed same-second edit cannot replace a newer observation.
Fresh channel snapshots use their returned PTS for changed-attachment ordering.

Completed/skipped/failed current identities can be queued for verification.
The shared library verifies existing bytes before reuse, repairs missing or
changed files and deduplicates identical content through the usual identity
and SHA paths. Paused queue rows remain paused; URL acceptance does not override
an operator's queue controls.

Application shutdown cancels unresolved lookups and joins their registered
handlers before closing SQLite. Accepted URL rows survive and drain after
restart even with live monitoring disabled. Purge/account mutations cancel the
account-bound lookup; a late result cannot recreate a purged group. Config and
queue rollback together on a failed acceptance. Acceptance also coordinates with
the drainer's final empty-queue check to prevent stranded manual work.
Requests also capture the purge epoch: a request that was still waiting to open
an account cannot resume after that purge completes, even after the active-purge
flag clears. Remaining items of the same batch are invalidated as well.
The drainer reads pending work after acquiring the same account-operation lock
used by purge, preventing a stale queue count from reopening accounts after a
completed purge removed all manual work.

## Evidence and limits

Native tests cover HTTP through fresh message fixtures, committed queue rows,
real filesystem writes, identity dedup, replay verification and missing-file
repair. Additional cases cover paused acceptance, account pinning and private
RPC errors, shutdown/reopen, suspension/ownership, a concurrent pin change,
known inaccessible chats without connecting, acceptance rollback, purge during
lookup, queue promotion and stale/fresh channel edit ordering. Protocol tests
cover account hashes, peer/message validation, cancellation, metadata and parser
bounds. These fixtures do not establish live Telegram or browser E2E behavior.

The latest full frozen HTTP/WebSocket run passes 214/324 cases, with 110 failing
cases across 14 files. The URL validation/credential case now passes; stories
and proxy actions keep the Telegram-actions file at 1/7. The unchanged frozen
snapshots still record three intentional cleanup corrections. This full run
preceded the final purge-race fix; the final full Go race suite and vet pass.
The history-transfer and URL-lookup purge regressions also pass 20 repetitions
each after correcting the drainer's stale count. Linux builds and Windows amd64/
macOS arm64 cross-builds pass; the foreign binaries have not been run natively.

Reproduce native checks and the HTTP acceptance benchmark from `core-service`:

```sh
go test -race -timeout 120s ./...
go vet ./...
go test ./internal/app -run '^$' -bench '^BenchmarkURLAcceptance$' -benchtime=300x
```

The benchmark uses authenticated local HTTP, fixture account/message lookups and
a paused durable queue. Database/account setup is excluded. It measures request
acceptance, not Telegram/network throughput or a speedup over the previous
runtime. A 300-iteration run on Linux amd64, Core Ultra 7 270K Plus measured
836,892 ns/op (about 0.837 ms), 84,439 B/op and 1,322 allocs/op.
The full migration still requires the domains and release checks in
[migration status](GO-MIGRATION-STATUS.md), including native test tooling and
removal of remaining Node sources/dependencies.
