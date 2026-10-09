# Contributing

Thanks for helping. The whole application is the Go module in
[`core-service/`](core-service/) (Go 1.26). The browser dashboard lives in
`core-service/internal/webassets/public/` and is embedded into the server at
build time; there is no Node.js or npm build step.

## Build, run, test

```sh
make build      # core-service/tgdl-server
make run        # build, then start it with ./runner.sh (data in ./data)
make test       # go test ./...
make check      # gofmt, go vet and race tests: run before every commit
```

For a focused change, run the affected package first
(`go -C core-service test ./internal/<package>/...`) and widen the checks as
the change requires.

## Where things live

| Path | What |
|---|---|
| `core-service/cmd/tgdl-server` | Server entry point and CLI commands |
| `core-service/internal/app` | HTTP/WebSocket routes, authorization, settings |
| `core-service/internal/telegram`, `accounts`, `session` | gotd accounts, login, sessions, updates |
| `core-service/internal/engine`, `download`, `filepublish` | Durable queue, dedup, publication |
| `core-service/internal/store`, `dbread` | SQLite schema, migrations, read queries |
| `core-service/internal/backup`, `cluster`, `rescue` | Backups, cluster peers, rescue mode |
| `core-service/internal/webassets/public` | Dashboard (ES modules, prebuilt CSS, locales `en`/`th`) |
| `docs/` | User docs and the GitHub Pages site (Jekyll, just-the-docs) |

See [Architecture](docs/ARCHITECTURE.md) and the
[developer notes](docs/DEVELOPER-NOTES.md) for design details.

## Guidelines

- Browser scripts are native ES modules: edit them directly and rebuild. Add
  plain CSS for new styles; no bundler or CSS compiler is used.
- Reuse the existing packages for account/session ownership, queue work, path
  confinement and configuration. Keep Telegram IDs lossless.
- Changes must preserve existing data folders, reject unauthorized requests and
  come with tests for the behaviour they touch. New tests go in the Go packages.
- `tests/contract/` holds historical HTTP/WebSocket snapshots of the 2.x
  release for reference; it is not an executable suite. The removed Node
  backend is in Git at commit `aa83eed`.
- `faces-service/`, `nsfw-service/` and `seekbar-service/` are separate
  projects with their own release workflows.
- User-visible changes need a `CHANGELOG.md` entry; keep
  `core-service/internal/webassets/public/CHANGELOG.md` identical to it.

## CI and releases

CI checks formatting, vet and race tests, builds the server and cross-compiles
every release target. The Docker workflow tests a fresh non-root container
(health, embedded setup page, clean shutdown) before publishing
`ghcr.io/botnick/telegram-media-downloader` for amd64 and arm64. Version tags
run `scripts/build-server-release.sh`, which builds the release archives and
`SHA256SUMS`.

## Pull requests

Describe what changed, how you verified it and any remaining limitations. Fill
in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md). Security
issues go through [SECURITY.md](SECURITY.md), not public PRs.
