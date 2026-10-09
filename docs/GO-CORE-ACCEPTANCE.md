# Core delivery verification — 2026-10-09

The owner narrowed delivery to necessary downloads, deduplication, queue,
library/dashboard and access controls. Optional AI workflows, advanced cluster
parity and additional cloud providers are not part of this delivery. Existing
sidecar projects remain independent.

**Acceptance is incomplete.** Native implementation and the checks below are
available, and an authorized Telegram account is now configured in the protected
preview. Live chat listing has passed; real media transfer and deduplication E2E
remain unverified. No release, production deployment or GitHub CI result is claimed.

| Requirement | Current evidence | Limit |
| --- | --- | --- |
| Go production without Node or a runtime fallback | Native Makefile/launchers, Go-only Docker build, tracked-file inventory, actual Linux container and standalone-process checks | Browser JavaScript remains necessary and is embedded in Go; Windows launchers were reviewed, not executed on Windows |
| Fresh Telegram metadata feeds download-time dedup | `internal/app/ingest_test.go`, `internal/download` and `internal/engine` regressions cover raw updates, identity/content reuse, edits, missing files, shared references, publication recovery and restart | Telegram byte transport is a fixture |
| Durable downloads and queue controls | App monitor/history/URL integration tests cover actual files, replay, cancellation, restart, history checkpoints, URL batches, pinning and account ownership | Real account login, update delivery and transfer remain unverified |
| Saved download controls work | `download_speed_test.go` drives HTTP configuration through a real fixture queue and restart; shared-worker deterministic tests cover pacing, live changes, cancellation and attempt budgets | Sustained payload cap, not exact wire-level shaping |
| Settings cannot save counts the engine rejects | `download_config_test.go` reproduces then rejects zero/excess/fractional attempt counts; browser ranges match accepted limits | Stored unsupported legacy settings remain preserved, with their inert controls removed |
| Dashboard and media work in a browser | Actual Chrome checks cover setup/login/logout, WebSocket connectivity, gallery image/search/pin/delete, persistence, CSP save/reset and settings auto-save/reload | Empty queue navigation and fixture media do not establish the full live-account browser workflow |
| Data/API/WS access controls | Native Go suite covers authentication, redaction, session revocation, media ranges, queue ownership and persistent data; actual container restart preserves session/library | Historical frozen contracts had 246/324 passes before the old harness was removed; this is not a claim of complete legacy parity |
| Build, race checks and packaging | Full Go race/vet suite passed after Node removal; subsequent full engine/app race suites passed after bandwidth changes; final config-focused race/vet/build and browser checks passed after settings cleanup | No remote GitHub Actions result; Linux executable/container tested, other platforms cross-compiled only |
| Repeatable performance evidence and references | Existing ingestion and atomic-history benchmarks plus [implementation references](GO-MIGRATION-STATUS.md#implementation-references) | Local fixtures, not Telegram throughput or a blanket speedup claim |

The native settings check verified 50 concurrent downloads and 20 total attempts
survive browser reload, compatibility presets set concurrency to 1/3/5, and old
stored RPM/polling values survive current settings saves. The old controls no
longer imply that the native engine uses them. Total attempts include the first
attempt; setting 1 disables retries.

The implementation retains explicit errors for unsupported recovery situations,
including incomplete/account-wide oversized update gaps. They are never marked
repaired merely to start the monitor. See the detailed scope and historical
differences in [migration status](GO-MIGRATION-STATUS.md).

## Required live acceptance

Use a dedicated authorized Telegram account and test chat. Configure the API and
log in through Settings, then verify login, new media, forwarded duplicates,
edited media, history/URL jobs, cancellation/retry, stop/restart and the resulting
files through the dashboard. Confirm that replay/restart does not create another
physical copy and that deleting one shared reference preserves the remaining
owner. Exercise a configured proxy if it will be used in deployment.

The protected preview now has API credentials and one saved account supplied by
the owner. The earlier missing-account blocker is resolved. Live media acceptance
still requires a designated test chat/media; other rooms' accounts have not been
used as test data.

A separate password-protected native preview is prepared for account acceptance.
The listener binds to loopback, guest login is disabled, public setup is locked,
and HTTPS login/config access/logout and secure cookies have been checked. During
publication an authoritative DNS lookup returned the new record while a recursive
resolver retained NXDOMAIN; the TLS checks used the observed edge address without
disabling certificate verification. This preview is a way to supply the missing
test account, not evidence that full live Telegram acceptance has passed.

## Live chat browsing correction

The first account's chat picker returned `503 not_connected`: saving an account
did not start the monitor, but the dialogs route required an already connected
engine. An administrator's chat request now opens the saved accounts in manual
mode, without enabling live downloads or changing `monitor.autoStart`. A dialog
session keeps its account run available during reads; account removal and hard
shutdown still cancel those reads. The existing guest denial remains enforced.
Telegram listing failures are reported separately from a disconnected engine.

The protected preview reproduced the failure before the fix. After updating its
native executable with the same data directory and listener, the live request
returned HTTP 200 with 183 chats from one account in 2.15 seconds. The monitor
remained stopped and the active/pending download counts remained zero. This
establishes actual Telegram connectivity and listing, not media-download E2E.
Chrome also rendered all 183 chat rows on the existing HTTPS preview after a
reload; the monitor stayed stopped with zero active/pending downloads.

Regression coverage is in `internal/app/dialogs_api_test.go` and
`internal/engine/controller_test.go`: first-account browsing, browsing after
monitor stop, concurrent connection reuse, no automatic live downloads, guest
denial, incomplete archive errors, idle drain protection and hard-stop cancellation.
The complete app/engine race suites, affected-package vet and native build pass.

## Unavailable chats, account removal and profile photos — 2.32.2

Fresh Telegram entities now classify each chat per account. Available chats are
separated from restricted, migrated, deleted-account and inaccessible entries.
An inaccessible group/channel is not assumed deleted; missing/minimal metadata
stays unknown. An account that can still read a chat takes precedence over an
account that cannot. The complete active/archive listing is used, including
entries beyond the former 500-chat boundary. Recheck refreshes Telegram metadata.

The unavailable list provides a per-chat leave/remove sheet with an explicit
account selection and final confirmation. The authenticated endpoint validates
both before selecting that exact account. It leaves channels/groups or removes
DM history for the selected account only; it never revokes another person's
history or deletes a channel globally. Downloaded files remain intact. Local
subscription cleanup runs only after confirmed remote success and only for a
single-account instance; partial cleanup and remote failures stay visible.

Profile photos load lazily from the account-bound dialog metadata, with four
concurrent transfers, coalesced requests, bounded validated JPEGs and atomic
publication. Reading a chat list no longer requires pending history recovery:
the connection authenticates in jobs-only mode, preserving recovery markers and
update cursors until monitor promotion. Promotion reuses the connection; stopping
promotion preserves existing manual work. Hard stop still cancels the account.

Actual photo requests also uncovered an existing download transport error:
`Client.DC` exported authorization to the account's own datacenter, which Telegram
rejected with `DC_ID_INVALID`. Home-datacenter downloads now use `Client.Pool`;
foreign datacenters retain explicit authorization transfer. Byte verification is
retained, and transport errors are propagated without switching transports.

Live read-only verification on the protected preview returned 187 chats from
one account in 1.54 seconds: 153 available, 27 restricted, four migrated and three
deleted accounts. Three real profile JPEG requests returned HTTP 200 (11,196,
6,384 and 11,040 bytes). Pending recovery markers were preserved; monitor state
remained stopped with zero active/queued downloads. The initial verification did
not execute remote leave/delete against the owner's real chats. Removal is covered by
transport fixtures, HTTP authorization/account/confirmation tests and isolated
browser fixtures; live browser checking opens and cancels confirmation only.

Chrome on the existing HTTPS preview loaded version 2.32.2, displayed 153 rows
with no blocked entries in Available, and 34 blocked rows in Deleted/unavailable.
Seventeen real profile images decoded. The removal sheet required choosing the
single account before enabling confirmation; cancellation before and after
selection sent zero removal requests. Monitoring remained stopped and idle.

After the owner explicitly requested a real test with two named chats, the same
authenticated removal endpoint was exercised against exactly those targets: one
channel and one supergroup. Both requests returned HTTP 200 with confirmed success
and no warning. A subsequent fresh active/archive read from Telegram confirmed
both IDs absent and the dialog count decreased from 187 to 185. The same single
account remained connected, with monitoring stopped and zero active/queued jobs.
Neither chat had a local subscription or downloaded media; download rows stayed
at zero. Consequently this live test proves channel/supergroup leave behavior,
but existing-file preservation, basic-group cleanup and DM removal still rely on
the corresponding fixtures. No other chat was targeted. No account was rejoined.

Affected app/engine/Telegram race suites, targeted promotion-stop and verified
transport regressions, vet and the native build pass. The asset and service-worker
versions advance together to 2.32.2 so previously cached modules cannot retain the
old chat list after reload. This work does not establish the still-outstanding
live media deduplication acceptance described above.

Primary references:

- [Telegram user flags](https://core.telegram.org/constructor/user),
  [unavailable basic groups](https://core.telegram.org/constructor/chatForbidden),
  [unavailable channels](https://core.telegram.org/constructor/channelForbidden),
  [group migration](https://core.telegram.org/constructor/chat) and
  [platform-specific restrictions](https://core.telegram.org/constructor/restrictionReason).
- [Leaving a channel](https://core.telegram.org/method/channels.leaveChannel),
  [leaving a basic group](https://core.telegram.org/method/messages.deleteChatUser)
  and [history removal and its revoke flag](https://core.telegram.org/method/messages.deleteHistory).
- [gotd current-datacenter pool](https://pkg.go.dev/github.com/gotd/td/telegram#Client.Pool)
  and [Telegram authorization transfer](https://core.telegram.org/method/auth.exportAuthorization).
