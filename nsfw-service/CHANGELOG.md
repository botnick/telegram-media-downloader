# nsfw-service changelog

Released as `nsfw-v<version>` tags: a GitHub Release plus container images
`ghcr.io/botnick/tgdl-nsfw:<version>` / `:latest` (CPU, linux/amd64 + linux/arm64)
and `:gpu-<version>` / `:gpu-latest` (CUDA, linux/amd64).

## [1.2.0]

Makes the sidecar safe and fast to run on another machine (GPU box, Cloudflare Tunnel, reverse proxy).

### Added
- Optional shared token: set `TGDL_NSFW_API_TOKEN` and every route except `/health` requires an `X-API-Token: <token>` (or `Authorization: Bearer <token>`) header; wrong or missing tokens get 401. Enter the same token in the app under Maintenance → NSFW → External. Unset keeps the old open behaviour, and a startup warning points it out when the port listens beyond localhost.
- `POST /classify/upload` takes the raw image bytes as the request body — no base64 or JSON overhead. The app uses it when the sidecar can't read its files. Capped by `TGDL_NSFW_MAX_UPLOAD_MB` (default 50 → 413 above it).
- `/health` reports `features`, `auth_required`, `path_mode` and `max_upload_bytes`, so the app picks the cheapest transfer mode and shows it in the Test result.

### Changed
- Decoding and inference run in a worker thread (one inference at a time), so `/health` keeps answering during a scan instead of timing out behind a busy event loop.

## [1.1.0]

First published release.

### Security
- Path mode is default-deny: files are only read by path when they resolve under `TGDL_NSFW_ALLOW_ROOTS`; otherwise `/classify` answers 403 and the app automatically falls back to sending the image as base64. Set `TGDL_NSFW_ALLOW_ROOTS` to the downloads directory the sidecar shares with the app to keep the faster path mode (a startup warning says so when it's unset).
- Decoder and internal error messages are logged instead of returned to the caller.

### Changed
- The CPU image installs CPU-only PyTorch wheels instead of the CUDA build, so it is several GB smaller.
- Both images declare a Docker `HEALTHCHECK` against `/health` (5-minute start period for the first model download).
