# Native Telegram proxy routing

Configured Telegram proxies now reach both the login wizard and every account
created by the Go engine. Live updates, dialog/history/URL/Stories requests,
avatars and media DC pools use those clients and their configured resolver.
There is no separate downloader or runtime for proxy connections.

## Configuration and application

The existing `proxy` configuration block is retained:

```json
{
  "proxy": {
    "type": "socks5",
    "host": "proxy.example.com",
    "port": 1080,
    "username": "alice",
    "password": "example-password"
  }
}
```

Set `proxy` to `null` to explicitly select direct connections. The settings
editor still allows partial saves; connection creation validates the completed
block before constructing a client. An incomplete object, invalid port, unknown
type or invalid credential produces an error. Previously some invalid settings
could be treated as no proxy; Go does not silently make that choice.

Restart the monitor after changing the proxy, as the existing UI instructs.
Running account connections retain their original snapshot until restart.
Manual jobs starting a new jobs-only pool use the current settings; jobs sharing
an existing pool use its snapshot. A login flow captures the settings at its
begin step and retains them through phone/code/password submission, even if an
administrator edits settings meanwhile. A new flow uses the new settings.
The setting applies to all accounts; this does not introduce per-account proxy
configuration or change explicit account pins.

Both proxy passwords and MTProxy secrets are write-only in the normal config
response and masked in the raw-config view. A configured MTProxy secret exposes
`secretSet`, and a redacted config round trip retains the saved secret. Neither
parse errors nor authentication failures contain the submitted credential.

## Supported protocols

| Type | Native behavior |
| --- | --- |
| `socks5` | IPv4, IPv6 and remote hostnames; optional RFC 1929 username/password authentication |
| `socks4` | IPv4 and SOCKS4a remote hostnames; optional user ID, no password or IPv6 destination support |
| `mtproxy` | Plain 16-byte, `dd` padded and `ee` FakeTLS secrets; hex or base64url encoding |

An omitted type defaults to SOCKS5. SOCKS5 credentials require both fields,
each 1–255 bytes, or neither. SOCKS4 rejects a supplied password with an
instruction to use SOCKS5. FakeTLS secrets must include a valid cloak hostname.
HTTP CONNECT remains unsupported and returns an explicit configuration error,
matching the former runtime's supported protocol boundary.

The resolver handles primary, media-only and CDN destinations. SOCKS connects
only to the configured proxy; destination hostnames are passed to it for remote
resolution. MTProxy encodes the destination DC in the obfuscation handshake,
including negative media DC IDs. Changing DC or reconnecting retains the same
proxy configuration. A refused connection or failed authentication never causes
a direct connection attempt. Environment proxy variables do not override this
explicit Telegram routing policy.

Multiple Telegram DC candidates can connect concurrently through the same
proxy. Each attempt owns its socket through its handshake; selecting a winner
cancels and joins the losing attempts without closing the returned connection.
The complete TCP/proxy/MTProto transport handshake has a 30-second limit or the
caller's earlier deadline. Cancellation closes a stalled socket, including
FakeTLS reads. Successful handshakes clear temporary deadlines and transfer
socket ownership to gotd for normal operation.

The pinned gotd FakeTLS parser assumes the initial server records contain its
32-byte digest at offset 11. A Go connection wrapper checks record types and
lengths before handing that prefix to the parser, so malformed responses fail
before digest processing. Each of the three records is bounded to 18,432 bytes;
a wrong digest remains a protocol error. This guard does not alter or implement
Telegram's encryption or authentication algorithms.

`POST /api/proxy/test` remains a five-second TCP reachability probe. It does not
perform SOCKS authentication or MTProxy negotiation. Its public-target rule is
specific to this probe; an administrator may deliberately configure a local or
private proxy for Telegram connections.

## Verification

Native tests use real protocol bytes over in-memory sockets and a loopback TCP
listener. They verify:

- SOCKS4/5 destination addresses, user/password negotiation and data exchange
  through primary/media/CDN routes, with no direct dial.
- Plain and `dd` MTProxy obfuscation, payload exchange and negative media DCs.
- `ee` FakeTLS client hostname, authenticated server response, obfuscated media
  exchange, wrong digest and malformed/oversized response rejection.
- Stalled handshake cancellation, refused proxy negotiation, losing-attempt
  cleanup and continued data exchange after handshake-context cancellation.
- The actual native gotd login client's initial transport reaching a local
  SOCKS5 server with the configured credentials.
- HTTP configuration reaching multiple account factories, monitor restart,
  jobs-only URL acceptance, active login snapshot preservation, explicit clear,
  invalid-config refusal and secret redaction/round-trip preservation.

These fixtures establish routing and lifecycle behavior. They do not establish
successful login or media downloading through a public proxy on Telegram's live
network. Browser and live Telegram E2E remain release requirements. See
[migration status](GO-MIGRATION-STATUS.md) for the full application's remaining
work and contract results.

The full Go race suite passes, as do vet and Linux builds. Windows amd64 and
macOS arm64 cross-builds pass; neither binary was run on its target OS. Protocol
fixtures also pass ten race-enabled repetitions. The full frozen HTTP/WebSocket
suite remains at 223/324 passing, with 101 failures in 12 files; accounts,
configuration and Telegram-action contracts remain green. No snapshots changed.

`BenchmarkNativeSOCKS5Handshake`, run in isolation on Linux amd64 / Core Ultra 7
270K Plus for three sets of 1,000 iterations, measured:

| Run | ns/op | B/op | allocs/op |
| --- | ---: | ---: | ---: |
| 1 | 30,352 | 9,667 | 73 |
| 2 | 37,030 | 9,678 | 73 |
| 3 | 28,851 | 9,642 | 73 |

This includes both sides of an in-memory SOCKS5 negotiation, the Telegram
transport header, connection cleanup and joining the fixture goroutine.
Resolver construction is excluded. It measures neither real network latency
nor media throughput and provides no Node comparison. Reproduce from
`core-service` with:

```sh
go test ./internal/telegram -run '^$' -bench '^BenchmarkNativeSOCKS5Handshake$' -benchtime=1000x -count=3 -benchmem
```

## References

- [gotd transport and proxy configuration](https://gotd.dev/docs/advanced/transports-and-proxy/)
- [Pinned gotd DC resolver implementation](https://github.com/gotd/td/tree/v0.115.0/telegram/dcs)
- [Pinned gotd FakeTLS parser](https://github.com/gotd/td/blob/v0.115.0/mtproxy/faketls/server_hello.go)
- [Telegram transports and obfuscation](https://core.telegram.org/mtproto/mtproto-transports)
- [SOCKS5 protocol, RFC 1928](https://www.rfc-editor.org/rfc/rfc1928)
- [SOCKS5 username/password authentication, RFC 1929](https://www.rfc-editor.org/rfc/rfc1929)
- [Go SOCKS5 dialer](https://pkg.go.dev/golang.org/x/net/proxy#SOCKS5)
