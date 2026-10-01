# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   - "gocore" compiles tgdl-core (core-service/, the Go companion process)
#     on the build host for the target platform — CGO off, so no QEMU and
#     no C toolchain; works the same for linux/amd64 and linux/arm64.
#   - "deps" installs prod dependencies only (npm ci --omit=dev) so the runtime
#     image stays small.
#   - "runtime" copies node_modules from "deps" + the source, runs as the
#     non-root `node` user, exposes 3000, and ships a healthcheck that hits
#     the dashboard's /api/auth_check endpoint.
#
# Pin a specific patch version. Floating tags drift; this image is reproducible.

FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS gocore
ARG TARGETOS=linux
ARG TARGETARCH
ARG TARGETVARIANT
WORKDIR /src
COPY core-service/ ./
# linux/arm/v7 → GOARM=7 (ignored for every other GOARCH).
RUN --mount=type=cache,target=/root/.cache/go-build \
    GOARM_V="${TARGETVARIANT#v}"; \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOARM=${GOARM_V:-7} \
    go build -trimpath -ldflags "-s -w" -o /out/tgdl-core ./cmd/tgdl-core

# Just the binary, for `docker buildx build --target gocore-bin -o …` (CI
# checks the arm64 build this way). Not part of the default build.
FROM scratch AS gocore-bin
COPY --from=gocore /out/tgdl-core /tgdl-core

FROM node:24.18.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# tgdl-core comes from the gocore stage above, never from the npm
# postinstall download.
RUN TGDL_CORE_SKIP_INSTALL=1 npm ci --omit=dev --no-audit --no-fund

FROM node:24.18.0-bookworm-slim AS runtime

# Build identity — passed in by CI (`docker build --build-arg GIT_SHA=…
# --build-arg BUILT_AT=…`) and surfaced via `/api/version` so the
# status-bar chip always reflects what's actually deployed.
ARG GIT_SHA=dev
ARG BUILT_AT=
# MALLOC_ARENA_MAX: glibc gives every thread that allocates its own malloc
# arena, and freed native memory (sharp/libvips, onnxruntime, SQLite)
# fragments across them, so RSS keeps creeping up in a long-running
# process. Two arenas keep it compact at a negligible speed cost.
# UV_THREADPOOL_SIZE — libuv's worker pool (default 4) is shared by every
# fs call, sendFile stream, crypto hash, dns lookup AND each sharp
# thumbnail job. libuv reads it once at process start, so it has to be
# set here rather than from inside the app.
ENV NODE_ENV=production \
    PORT=3000 \
    MALLOC_ARENA_MAX=2 \
    UV_THREADPOOL_SIZE=16 \
    GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT}

# tini    — proper PID 1 (signal handling + zombie reaping). Debian ships
#           the binary at /usr/bin/tini.
# gosu    — drop from root → node after the entrypoint fixes /app/data perms
#           (su-exec equivalent on Debian; same `gosu user "$@"` syntax).
# ffmpeg  — used by src/core/thumbs.js for video first-frame thumbnails
#           and audio cover-art extraction. ~30 MB — tiny next to libvips
#           and node_modules.
# intel-media-va-driver / i965-va-driver — VA-API userland drivers needed
#           for `-hwaccel vaapi` (Intel iGPU + AMD via the same libva ABI).
#           Without these the ffmpeg path in thumbs.js falls back to CPU
#           decode even when the host exposes /dev/dri. iHD is Gen8+ and
#           the Quick Sync runtime; i965 covers Gen4-Gen7 hardware.
# vainfo  — `vainfo` from libva-utils. Not used by the app itself, but
#           lets operators `docker exec <ctr> vainfo` to confirm the
#           driver actually loaded inside the container without having
#           to bake their own debug image.
#
# Base is bookworm-slim (glibc) rather than alpine (musl) because
# `onnxruntime-node` (pulled in by @huggingface/transformers for the NSFW
# classifier) ships glibc-only prebuilt .so files; loading them on musl
# crashes the whole process at boot with "ld-linux-x86-64.so.2: No such
# file or directory". libstdc++ is part of the base image, no install needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini gosu ffmpeg procps \
        intel-media-va-driver i965-va-driver vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY runner.js config.example.json package.json LICENSE README.md SECURITY.md CHANGELOG.md ./
# tgdl-core — found at this path by src/core/gocore/spawn.js, so Docker
# installs never download it. The app runs fine without it (Node fallback).
COPY --from=gocore --chmod=0755 /out/tgdl-core /app/bin/tgdl-core

# Persistent state (sessions, config, downloads) — mount this as a volume.
# `chmod a+rX` guarantees files end up readable + dirs traversable even when
# BuildKit lays down mode 0 (seen on Windows hosts and some gha-cache hits),
# which previously surfaced as `Cannot find module '/app/src/web/server.js'`.
RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions /app/data/backups /app/data/models \
    && chmod -R a+rX /app \
    && chmod +x /app/scripts/docker-entrypoint.sh \
    && chown -R node:node /app

# The NSFW model is NOT baked into the image: it would land in /app/data,
# which the ./data bind-mount hides at runtime, and it would add ~85 MB for
# an opt-in feature. It downloads lazily on the first scan; to seed it ahead
# of time (e.g. before going offline) run inside the container:
#   docker compose exec -u node telegram-downloader npm run pre-download-models

# We deliberately run the entrypoint as root so it can chown the bind-mounted
# /app/data volume on first boot — gosu drops to `node` before exec'ing
# CMD, so the actual app process is still non-root.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "src/web/server.js"]
