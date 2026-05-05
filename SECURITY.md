# Security

## Reporting a vulnerability

**Don't open a public issue.** Use [GitHub's private vulnerability reporting](https://github.com/botnick/telegram-media-downloader/security/advisories/new).

Please include the affected component, version / commit, a minimal repro, and the impact you believe it has. We aim to acknowledge within **5 business days** and to ship a fix within **30 days** for high/critical issues.

Only the latest release on `main` receives security fixes.

## Scope

In scope: dashboard auth, path traversal, file disclosure / deletion, XSS / CSRF, command injection, secret leakage in API responses or logs, cryptographic weaknesses, supply-chain weaknesses (lockfile, post-install scripts, Docker base image).

Out of scope: anything that requires a compromised Telegram account, self-XSS, or DoS via deliberately tiny resource limits.

## Hardening tips for operators

- **Set a dashboard password** (`pnpm auth` or first-run wizard). Without it the dashboard fails closed.
- **Don't expose `:3000` directly.** Put it behind a reverse proxy with TLS.
- **Back up `data/secret.key`** — losing it makes every saved session unrecoverable.
- **Run only one writer to `data/db.sqlite`** at a time (CLI monitor or web server, not both).
- **Pin the Docker image by digest**, not the floating tag.

See [`docs/AUDIT.md`](docs/AUDIT.md) for the full audit history.
