# Security

How to report a vulnerability in Telegram Media Downloader, what is in scope, and how to harden a deployment.

## Supported versions

| Component | Supported |
|---|---|
| App (`tgdl-server`, Docker image) | the latest release (currently 3.0.x) |
| faces-service, nsfw-service, seekbar-service | the latest release of each |

Older versions, including 2.x, do not receive fixes; update first (see
[Updating](README.md#updating)).

## Reporting a vulnerability

**Don't open a public issue.** Use [GitHub's private vulnerability reporting](https://github.com/botnick/telegram-media-downloader/security/advisories/new).

Please include the affected component, version / commit, a minimal repro, and the impact you believe it has. We aim to acknowledge within **5 business days** and to ship a fix within **30 days** for high/critical issues.

## Scope

In scope: dashboard auth, path traversal, file disclosure / deletion, XSS / CSRF, command injection, secret leakage in API responses or logs, cryptographic weaknesses, supply-chain weaknesses (Go module checksums, build workflows, Docker base image).

Out of scope: anything that requires a compromised Telegram account, self-XSS, or DoS via deliberately tiny resource limits.

## Hardening tips for operators

- **Set a dashboard password** (`tgdl-server setup --password-stdin` inside the running container, or the setup form on the same machine). Until then the dashboard fails closed.
- **Don't expose port 3000 directly.** Put it behind a reverse proxy with TLS, then set `TGDL_SECURE_COOKIES=1` and a `TRUST_PROXY` value that matches only your proxy. For a native install with the proxy on the same host, set `TGDL_BIND_HOST=127.0.0.1`.
- **Back up `data/secret.key`.** It encrypts the saved Telegram sessions; without it you have to sign in to Telegram again.
- **Run one server per data folder** (one writer to `data/db.sqlite`); the server refuses a second one.
- **Protect `/metrics`** with `TGDL_METRICS_TOKEN` if the dashboard is reachable by others.
- **Keep the watchtower token private.** It lives in `data/watchtower/api-token`; the watchtower service publishes no port.
- **Pin the Docker image by digest** if you need strict supply-chain control; the one-click update follows the tag in your compose file.

See [Configuration](docs/CONFIGURATION.md) for every variable and
[`docs/AUDIT.md`](docs/AUDIT.md) for the historical v2.0 audit.
