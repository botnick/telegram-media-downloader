---
title: "Sessions and WebSockets"
description: "Engineering note on dashboard session revocation and WebSocket lifetime in the Go server."
parent: "Developer notes"
nav_order: 17
---

# Dashboard session and WebSocket lifetime

The Go dashboard now closes established sockets when their sessions lose access.
Password changes also invalidate previous admin HTTP sessions. This deliberately
changes two insecure behaviors recorded by the frozen legacy contracts.

## Revocation scopes

| Successful operation | Invalidated sessions and sockets |
| --- | --- |
| Logout | All tabs/connections using that cookie token |
| Change admin password | Every previous admin session; the response issues a new admin cookie |
| Change, clear or disable guest password | Every guest session |
| Save `web.guestEnabled=false` through the config API | Every guest session |
| Save `web.enabled=false` through the config API | Every session; login remains disabled |
| Operator-token password reset | Every session; the response issues a new admin cookie |
| Maintenance revoke-all | Every session |

Admin password changes leave guest access intact. Logout leaves other tokens,
including other sessions with the same role, intact. Failed credential/config
transactions preserve both the old credentials and the existing sessions and
sockets. If issuing the replacement cookie fails after a successful credential
commit, the new password remains authoritative; sign in with it.

## Ownership and ordering

Registration revalidates the token and dashboard policy under the same
credential mutex used for login, config saves and revocation. A session cached
by the HTTP gateway cannot register after a concurrent reset. Sensitive auth,
config and revoke-all handlers similarly recheck the admin session after
acquiring that mutex. Duplicate cookies use the same last-value selection as
the HTTP gateway.

The event subscription exists before HTTP 101 becomes observable. A response
wrapper registers the raw hijacked connection before the handshake is written;
this closes the interval where revocation could otherwise miss an upgrade
still in progress. The handshake has a ten-second timeout, further limited by
the session's current expiry.

After the database commits revocation, the application cancels each matching
subscriber, removes it from the event hub and closes its transport before
returning the successful credential response. Closing the transport interrupts
a blocked writer. Buffered application events are discarded, not drained.
Bytes already handed to the network before revocation cannot be recalled.
This is database atomicity plus ordered transport shutdown, not a distributed
transaction between SQLite and the browser.

Revocation closes the transport directly and does not promise a WebSocket close
code or a final `sessions_revoked` event to the revoked socket. Waiting for a
peer to read a close frame must not keep privileged data flowing. The browser's
existing reconnect attempts use the current cookie and are subject to HTTP
authentication again; this change does not add an immediate login-screen
redirect on disconnect.

## Expiry and shutdown

Each socket has one reusable expiry timer. At the deadline it checks persisted
state again so an HTTP renewal can extend an already-open connection. WebSocket
messages, pings and pongs never renew a session. Events check expiry before
sending, and each write deadline is the earlier of ten seconds and the known
session expiry. One reader and one writer own the WebSocket protocol state.

The thirty-second heartbeat rechecks the session, role and dashboard policy.
Database/config errors fail closed; revalidation has a two-second context
timeout. Normal application revocations notify the registry immediately.
Direct out-of-band SQL changes have no immediate notification and are detected
at the next heartbeat or expiry check. Do not edit the live database as an
alternative to the authenticated application endpoints.

`App.Close` prevents new registrations, closes owned transports, and joins both
the writer handlers and reader goroutines before closing SQLite. Registration
validation is also counted while using the database. This explicitly covers
hijacked connections that `http.Server.Shutdown` does not own.

## Verification and compatibility

Native tests use actual loopback HTTP/WebSocket connections for logout across
multiple tabs, role isolation, password/guest/config/reset/revoke-all changes,
replacement cookies, expiry and HTTP renewal, duplicate cookies and shutdown.
Deterministic transport barriers exercise revocation during the HTTP 101 write
with a full event queue, and interrupt a stalled event writer during logout and
shutdown. Other regressions cover stale middleware contexts, invalid persisted
roles/config, and a failed SQLite DELETE trigger rolling back a password change.

Full `go test -race -timeout 180s ./...` passes (app package 48.828 seconds).
Additional blocked-writer/revalidation race cases pass after that run; final
`go vet ./...` passes. An independent Python standard-library client validates
the raw RFC6455 handshake against the compiled executable, then tests multiple
tabs, logout, guest disable, password rotation, short-lived expiry, SIGTERM,
exit status zero and a persisted replacement session after restart. Windows
amd64 and macOS arm64 builds are cross-compiled, not executed there. These are
local transport/process checks, not live Telegram or browser E2E.

The full immutable Go-executable legacy run reports **236/324 passing, 88
failing**, with **22/36 files passing** (56.51 seconds). No golden expectations
were edited and no cases were skipped:

- Four failures in `auth-password`: the old-session-keeps-working assertion now
  fails; stopping that test before its two login requests changes the limiter
  counters expected by three following reset cases. Native tests independently
  verify successful reset and new-session behavior.
- One failure in `system`: it waits for `sessions_revoked` on an already-revoked
  guest socket. Immediate transport closure replaces that delivery guarantee.
- A snapshot-backup case captured its messages before the final queue-drained
  event. It waits for HTTP idle and earlier socket events, not that final event.
  An isolated rerun passes this case (backup 16/17, provider metadata still
  differs). The full run's failure remains in the count. The native contract
  runner must synchronize on terminal events instead of assuming HTTP idle
  means a browser has received every frame.
- The other 82 failures remain listed in the migration status. Earlier token
  clock-normalization and VACUUM-size assumptions also remain test-runner work.

## References

- [Gorilla WebSocket concurrency contract](https://pkg.go.dev/github.com/gorilla/websocket@v1.5.3#hdr-Concurrency)
  permits one reader and one writer, with Close allowed concurrently.
- [Go HTTP server shutdown](https://pkg.go.dev/net/http#Server.Shutdown) excludes
  hijacked connections; applications must manage their lifetime.
- [Go network connection contract](https://pkg.go.dev/net#Conn) defines concurrent
  method calls, deadlines and unblocking pending I/O on Close.
