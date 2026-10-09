# Contributing

The application backend is `core-service/` (Go 1.26.8). Browser assets live in
`core-service/internal/webassets/public/` and are embedded into the server.
There is no Node build step for the native application.

```sh
make build
make test
./runner.sh
```

Before committing, run `make check`; it checks formatting, vet and race tests.
For a focused correction, first run the affected package/tests and only broaden
verification where a change justifies it. Do not add optional feature ports
solely for historical parity. See [current scope and evidence](docs/GO-MIGRATION-STATUS.md).

Native CI builds the actual server, checks its launcher and cross-compiles each
release target. Docker CI checks a fresh non-root container with no Node binary,
health, embedded setup page and clean shutdown before publishing. App tags use
`scripts/build-server-release.sh` to produce native archives and SHA-256 checksums.
Local verification does not publish or deploy anything.

The old `src/`, Node test harness and package metadata remain temporary migration
references. They are not the build/start/test path for this Go application and
still need removal once essential coverage is preserved. Sidecar projects are
separate; do not rewrite them as part of core runtime cleanup.

Use existing Go packages for Telegram account/session ownership, queue work,
path confinement and configuration. Keep Telegram IDs lossless. Changes must
preserve existing data, reject unauthorized requests and have meaningful tests
for affected behavior. Do not edit global Git settings or add co-author trailers.

Security issues → [SECURITY.md](SECURITY.md). Describe behavior, verification and
remaining limitations clearly when submitting a change.
