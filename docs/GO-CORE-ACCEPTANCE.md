# Core delivery verification — 2026-10-09

The owner narrowed delivery to necessary downloads, deduplication, queue,
library/dashboard and access controls. Optional AI workflows, advanced cluster
parity and additional cloud providers are not part of this delivery. Existing
sidecar projects remain independent.

**Acceptance is incomplete.** Native implementation and the checks below are
available, but no real Telegram account is configured in this development
workspace. Fixture success does not establish live Telegram E2E. No release,
production deployment or GitHub CI result is claimed.

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

The development workspace currently has no configured Telegram API credentials,
account metadata or session files. That blocks this final live verification;
repeating offline fixtures cannot resolve it. The working library and other
rooms' accounts have not been used as test data.

A separate password-protected native preview is prepared for account acceptance.
The listener binds to loopback, guest login is disabled, public setup is locked,
and HTTPS login/config access/logout and secure cookies have been checked. During
publication an authoritative DNS lookup returned the new record while a recursive
resolver retained NXDOMAIN; the TLS checks used the observed edge address without
disabling certificate verification. This preview is a way to supply the missing
test account, not evidence that live Telegram acceptance has passed.
