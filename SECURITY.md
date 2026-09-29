# Security

How to report a vulnerability in Telegram Media Downloader, what is in scope, and how to harden a deployment.

## Supported versions

| Component | Supported |
|---|---|
| App | the latest release (currently 2.31.x) |
| tgdl-core, faces-service, nsfw-service, seekbar-service | the latest release of each |

Older versions do not receive fixes; update first (see [Updating](README.md#updating)).

## Reporting a vulnerability

**Don't open a public issue.** Use [GitHub's private vulnerability reporting](https://github.com/botnick/telegram-media-downloader/security/advisories/new).

Please include the affected component, version / commit, a minimal repro, and the impact you believe it has. We aim to acknowledge within **5 business days** and to ship a fix within **30 days** for high/critical issues.

## Scope

In scope: dashboard auth, path traversal, file disclosure / deletion, XSS / CSRF, command injection, secret leakage in API responses or logs, cryptographic weaknesses, supply-chain weaknesses (lockfile, post-install scripts, Docker base image).

Out of scope: anything that requires a compromised Telegram account, self-XSS, or DoS via deliberately tiny resource limits.

## Hardening tips for operators

- **Set a dashboard password** (`npm run auth` or first-run wizard). Without it the dashboard fails closed.
- **Keep tgdl-core private.** It is the front server on `PORT` and talks to Node over `127.0.0.1` with a per-start token; do not publish any other port it uses.
- **Don't expose `:3000` directly.** Put it behind a reverse proxy with TLS.
- **Back up `data/secret.key`** — losing it makes every saved session unrecoverable.
- **Run only one writer to `data/db.sqlite`** at a time (CLI monitor or web server, not both).
- **Pin the Docker image by digest**, not the floating tag.
- **Don't expose sidecars without a token.** When a faces / NSFW / seekbar sidecar runs on another host, set its API token and keep its port off the public internet; restrict path mode with `TGDL_*_ALLOW_ROOTS` (see [`docs/AI.md`](docs/AI.md)).

See [`docs/AUDIT.md`](docs/AUDIT.md) for the full audit history.
