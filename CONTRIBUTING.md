# Contributing

How to set up a dev environment, what CI checks, and the ground rules for a pull request.

```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
npm ci
npm run doctor       # verify Node/ABI/SQLite/port/ffmpeg before you go further
npm run lint
npm test
npm start            # dashboard at http://localhost:3000
```

Requires **Node.js 22+** (24 LTS recommended). `npm ci` downloads the pinned **tgdl-core** (the required Go binary) for your platform and verifies its checksum. To build it from source instead (or when you change `core-service/`), install the **Go toolchain** (1.22 or newer) and run `npm run build:core`. If `npm run doctor` reports `NODE_MODULE_VERSION` mismatch on `better-sqlite3` after a Node upgrade, run `npm rebuild better-sqlite3`.

## Submitting a change

1. Branch off `main` (`feat/...`, `fix/...`).
2. Run `npm run lint && npm test && npm run doctor` before pushing.
3. Add tests for non-trivial changes (vitest, see `tests/`). If you touch an HTTP route or WebSocket event, run the API contract suite, `npm run test:contract` (see [`tests/contract/README.md`](tests/contract/README.md)); `npm run test:contract:update` re-records the snapshots when a change is intended.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(web): …`, `fix(downloader): …`).
5. Add a line under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md) for anything users or operators would notice.
6. Open a PR against `main`. The template asks for a short description + how you verified the change. CI (lint, the contract suite, the big-data guard `npm run check:oom`, tests on Linux + Windows, Docker build, CodeQL) must be green before merge.

### Ground rules for changes

- **Updating must never hurt an existing install.** No manual steps, no data loss, config keys / env vars / routes keep working, and migrations must be safe on a 1M-row database (never block the event loop for seconds — the Docker healthcheck restarts the container).
- **Sidecars ship first.** When the app starts depending on a new `faces-`, `nsfw-` or `seekbar-` sidecar version, tag and release the sidecar before the app release that uses it, and keep the app working with the previous sidecar version where possible.

## Code style

- ES Modules everywhere (`"type": "module"`).
- Telegram IDs are strings; large ints overflow `Number.MAX_SAFE_INTEGER`.
- Reuse existing utilities — `sanitizeName`, `loadConfig`, `safeResolveDownload`, `web-auth`, `SecureSession`. Don't reinvent.
- The Lefthook pre-commit hook runs `biome check --write` on every staged file, so lint + format fixups happen automatically. Run `npm run check` manually if you want to apply them across the whole repo.

Security issues → [`SECURITY.md`](SECURITY.md), not the public tracker.

Be respectful and keep the discussion technical — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
