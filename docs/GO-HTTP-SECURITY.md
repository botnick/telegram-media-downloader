---
title: "HTTP policy"
description: "Engineering note on reverse-proxy trust, HTTPS enforcement, CSP, API quotas and response compression in the Go server."
parent: "Developer notes"
nav_order: 9
---

# Native HTTP policy and compression

The Go application now applies reverse-proxy trust, HTTPS enforcement, live CSP,
optional API quotas and text compression before public route dispatch. Settings
apply to the actual HTTP server, authentication quotas and generated share URLs.
This does not complete the wider migration or establish a security audit.

## Configuration

| Setting | Behavior |
| --- | --- |
| `TRUST_PROXY` absent | Trust immediate loopback proxies and subsequent loopback hops only |
| `TRUST_PROXY=` or `0` | Ignore forwarded addresses and schemes |
| `TRUST_PROXY=1` | Trust exactly one hop; values from 0 through 256 are accepted |
| `TRUST_PROXY=10.2.0.0/16,loopback` | Trust listed addresses/networks; `linklocal` and `uniquelocal` are also supported |
| `TGDL_SECURE_COOKIES=1` | Set Secure on session and logout cookies; use with HTTPS |
| `TGDL_CSP=off` | Explicit recovery setting that disables CSP generation |
| `COMPRESSION_LEVEL=6` | gzip/zlib-deflate/Brotli quality 1–9; 6 is the default; 0 disables compression |

Invalid proxy specifications and compression levels stop startup with an error.
Compose forwards these options; its proxy default is loopback, and an explicit
empty `TRUST_PROXY` remains empty. A container proxy usually has a non-loopback
address: configure the real source IP/network or hop count. A trusted proxy
must overwrite incoming forwarding headers. Hop-count trust assumes clients
cannot bypass part of the configured proxy chain.

The immediate TCP peer is authoritative unless trusted. The application walks
`X-Forwarded-For` from the nearest hop toward the client and stops at the first
untrusted address. IPv4-mapped IPv6 is normalized. Invalid addresses in the
trusted portion fail with 400; the chain is bounded to 8 KiB and 256 entries.
Untrusted peers cannot select their quota bucket or HTTPS state with forwarded
headers. `X-Forwarded-Proto: https` is honored only from an immediate trusted
peer; native TLS remains secure. `Forwarded` and `X-Forwarded-Host` are not
used to choose client identity, host or scheme.

First-admin bootstrap remains stricter: a direct loopback connection is needed,
and any Forwarded/X-Forwarded-For header prevents treating it as local.
The server does not terminate TLS itself; HTTPS deployment needs an external
TLS proxy. This change does not deploy or configure that proxy.

## Live web settings

Each request reads a narrow SQLite projection of `web.forceHttps`, `web.csp`
and `web.rateLimit` from the reader pool. A per-application cache avoids rebuilding
unchanged policies; it does not delay observing committed config changes.
Database or policy decoding failures return 503 instead of silently applying an
older policy. The SQLite projection preserves JSON booleans using `->`.

With `web.forceHttps=true`, insecure remote GET/HEAD requests receive a 308
redirect preserving the host, escaped path and query. Other remote methods
receive 403 without executing the mutation. Direct/effective loopback clients
retain HTTP access for recovery. Secure responses receive one-year HSTS with
includeSubDomains and CSP upgrade-insecure-requests. Disabling forceHttps sends
`Strict-Transport-Security: max-age=0`, matching the released behavior.
Secure cookie flags remain the explicit process option described above.

`web.csp` supports `enabled`, `reportOnly` and a `directives` object. Saving this
object replaces the previous custom CSP; omitted directives use the shipped
defaults, empty source arrays remove a directive, and `csp:null` restores all
defaults. Sources are deduplicated. Custom frame-ancestors removes the otherwise
default SAMEORIGIN X-Frame-Options header to avoid contradictory policies.
The validator rejects malformed names, header separators, control characters,
embedded whitespace, invalid UTF-8, excessive source lengths/counts, more than
64 directives or over 16 KiB of custom policy. Rejected writes leave the saved
policy unchanged. `TGDL_CSP=off` also permits recovery from invalid saved CSP.
The shipped policy still allows the browser bundle's existing inline scripts
and CDN origins; eliminating those remains separate frontend work.

`web.rateLimit={"enabled":true,"perMinute":10000}` enables a fixed 60-second
window per resolved client IP on `/api/` paths, including public API routes.
Values below 10 use the shipped 10,000 default; valid values are capped at
1,000,000. Responses expose RateLimit/RateLimit-Policy, and rejected requests
receive 429 plus Retry-After. Non-API routes are outside this optional limiter.
Login/setup/share quotas remain independent; disabling the global limit does
not disable authentication throttling.

Each limiter has at most 10,000 live client buckets. Capacity is refused rather
than evicting active buckets and granting a fresh quota. An expiry min-heap
reclaims each expired bucket once, replacing a full map scan for every new IP.
These are process-local limits, reset by restart; this is not a distributed
anti-abuse service. IPv6 keys are individual normalized addresses, not subnets.

## Compression and resource bounds

gzip and zlib-wrapped deflate use Go's standard library; Brotli uses the pinned
pure-Go `github.com/andybalholm/brotli v1.2.6`. Accept-Encoding weights and q=0
exclusions are honored, with br/gzip/deflate priority for equal weights. An
explicit higher-priority identity encoding keeps the response uncompressed.
In keeping with the released middleware, lack of an acceptable supported
encoding leaves the existing representation; this layer does not generate 406.

Eligible text/JSON/XML/script responses are compressed at 1,024 bytes. Only
that prefix is buffered to make the decision, after which encoding streams.
The downstream JSON handler may still marshal its full response: the 1 KiB
bound describes this middleware, not all application allocations. Existing
Content-Encoding, no-transform, partial responses, byte-range requests,
X-No-Compression, image/audio/video types, event streams and the raw file/share/
photo/cluster-file mounts retain their bytes. HEAD and protocol upgrades bypass
encoding. Flush before the threshold preserves prompt streaming. Strong ETags
become weak when representation bytes change, and stale Content-Length is
removed. Go may add the correct compressed length for small buffered output.

Each application permits at most eight active encoders, retaining at most two
idle writers per encoding. Brotli's window is fixed to 256 KiB. A full encoder
pool waits at most 30 seconds or until request cancellation, then reports 503;
it does not switch to another runtime. Encoder socket writes and flushes have
30-second deadlines. Those deadlines are cleared between writes, so local
application pauses do not count as a stalled client. Shutdown, failed writes
and handler panics release encoders; incomplete streams abort the connection.
These bounds do not replace the HTTP server's overall connection limits.

## Verification and limits

Native tests cover proxy chains/CIDRs/hop counts, spoofed headers, IPv4-mapped
addresses, TLS, malformed chains, runtime policy changes through authenticated
HTTP handlers, invalid CSP writes and reset, denied insecure mutations, global
quota isolation/concurrency/capacity, independent login throttling, and explicit
recovery from corrupt saved CSP.

Actual loopback HTTP tests decode all three formats, including fragmented
writes, thresholds, opt-out/range/media behavior, WebSocket upgrade and early
flush. A stalled net.Pipe client verifies socket timeout and encoder release;
a separate delayed producer verifies that application pauses remain valid.
A native executable check uses independent curl/zlib/Brotli decoding of the
embedded SPA and verifies live HTTPS/CSP/API-limit changes and Secure cookies
after restart. This is loopback process integration, not browser or public TLS
deployment E2E.

A parser fuzz run found an invalid-UTF-8 source whose JSON replacement changed
its length. The validator now rejects that input and retains the regression
fixture. A subsequent 30-second, two-worker run passed 240,808 executions;
this is bounded testing, not exhaustive validation or an independent audit.

The full Go race suite and vet pass; subsequent transport deadline changes also
pass focused race regressions. Windows amd64/macOS arm64 binaries are
cross-compiled, not executed on those platforms. The legacy development
contract launcher now maps its production-cookie scenario to
`TGDL_SECURE_COOKIES=1` for Go; no production NODE_ENV alias was added and no
frozen expectations were changed. The HTTP security contract passes 4/5 cases;
the remaining redirect case expects `X-Powered-By: Express`. Go omits that
framework header. Native tests exercise the subsequent HEAD/mutation/HSTS
branches which that stopped legacy test cannot reach. The difference remains
counted as a failure in [the migration totals](GO-MIGRATION-STATUS.md).

A subsequent increment now closes established WebSockets on revocation, expiry
and shutdown, and invalidates old admin sessions on password changes. This
deliberately changes the legacy contracts. See [session lifetime, tests and
limits](GO-WEBSOCKET-SESSIONS.md); this is not a claim that every security issue
in the application has been resolved.

## Measured local cost

On Linux amd64, Go 1.26.8, Intel Core Ultra 7 270K Plus, three runs of 100
iterations of `BenchmarkHTTPCompression` processed a preallocated, repetitive
192,000-byte JSON-shaped input with warm encoder pools and discarded output:

| Encoding | Time per response | Allocated bytes / objects per response |
| --- | --- | --- |
| gzip | 0.389–0.450 ms | 2,920–2,923 / 42 |
| Brotli | 0.318–0.346 ms | 2,521–2,523 / 22 |
| deflate | 0.646–1.311 ms | 2,922–2,924 / 42 |

Other checks belonging to this task were stopped. Setup/input allocation and
initial encoder allocation are excluded; retained encoder workspaces are not
counted as new allocations. These figures exclude sockets, JSON marshaling,
SQLite policy lookup, peak RSS and real browser/WAN latency. They are not a
comparison against Node. The higher variation in deflate is retained as measured.

`BenchmarkRateLimiterManyClients`, three runs of 100,000 iterations, reports
36.6–48.7 ns for one already-known client and 77.2–152.4 ns while rotating over
10,000 existing clients, with zero new allocations. This measures warm quota
checks; it excludes insertion, expiry, policy lookup, request handling and
concurrent contention. Capacity/expiry correctness is checked separately.

The final unstripped Linux executable is 40,297,749 bytes, 1,198,605 bytes more
than the FTP checkpoint. This includes Brotli and the HTTP policy changes;
it is file size, not resident memory. The final immutable executable's frozen
API/WS run at this HTTP-policy checkpoint passes 242/324 tests in 57.18 seconds, with 82 failures retained.

## References

- [RFC 9110, Accept-Encoding](https://www.rfc-editor.org/rfc/rfc9110.html#name-accept-encoding)
  describes quality weights and representation negotiation.
- [Go ResponseController](https://pkg.go.dev/net/http#ResponseController)
  documents deadline, flushing and wrapper behavior.
- [Go compress/gzip](https://pkg.go.dev/compress/gzip) and
  [compress/zlib](https://pkg.go.dev/compress/zlib) provide native encoders.
- [Pinned Brotli source](https://github.com/andybalholm/brotli/tree/v1.2.6)
  documents its Go encoder options and streaming API.
- [SQLite JSON operators](https://www.sqlite.org/json1.html#the_and_operators)
  distinguish preserving JSON values from scalar SQL extraction.
- [Released proxy-trust semantics](https://expressjs.com/en/guide/behind-proxies/)
  describe the right-to-left trust boundary and deployment assumptions retained
  by the native implementation.
- [Compose variable interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
  distinguishes an unset variable from an explicitly empty value.
