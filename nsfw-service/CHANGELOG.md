# nsfw-service changelog

Released as `nsfw-v<version>` tags: a GitHub Release plus container images
`ghcr.io/botnick/tgdl-nsfw:<version>` / `:latest` (CPU, linux/amd64 + linux/arm64)
and `:gpu-<version>` / `:gpu-latest` (CUDA, linux/amd64).

## [1.1.0]

First published release.

### Security
- Path mode is default-deny: files are only read by path when they resolve under `TGDL_NSFW_ALLOW_ROOTS`; otherwise `/classify` answers 403 and the app automatically falls back to sending the image as base64. Set `TGDL_NSFW_ALLOW_ROOTS` to the downloads directory the sidecar shares with the app to keep the faster path mode (a startup warning says so when it's unset).
- Decoder and internal error messages are logged instead of returned to the caller.

### Changed
- The CPU image installs CPU-only PyTorch wheels instead of the CUDA build, so it is several GB smaller.
- Both images declare a Docker `HEALTHCHECK` against `/health` (5-minute start period for the first model download).
