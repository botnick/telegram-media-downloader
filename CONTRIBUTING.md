# Contributing

```bash
git clone https://github.com/botnick/telegram-media-downloader.git
cd telegram-media-downloader
npm ci
npm run doctor       # verify Node/ABI/SQLite/port/ffmpeg before you go further
npm run lint
npm test
npm start            # dashboard at http://localhost:3000
```

Requires **Node.js 22+** (24 LTS recommended). If `npm run doctor` reports `NODE_MODULE_VERSION` mismatch on `better-sqlite3` after a Node upgrade, run `npm rebuild better-sqlite3`.

## Submitting a change

1. Branch off `main` (`feat/...`, `fix/...`).
2. Run `npm run lint && npm test && npm run doctor` before pushing.
3. Add tests for non-trivial changes (vitest, see `tests/`).
4. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(web): …`, `fix(downloader): …`).
5. Open a PR against `main`. The template asks for a short description + how you verified the change.

## Code style

- ES Modules everywhere (`"type": "module"`).
- Telegram IDs are strings; large ints overflow `Number.MAX_SAFE_INTEGER`.
- Reuse existing utilities — `sanitizeName`, `loadConfig`, `safeResolveDownload`, `web-auth`, `SecureSession`. Don't reinvent.
- Run `npm run format` (Prettier) before committing.

Security issues → [`SECURITY.md`](SECURITY.md), not the public tracker.

Be respectful and keep the discussion technical. We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
