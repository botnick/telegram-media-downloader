# syntax=docker/dockerfile:1.7
# Pure-Go production image. The browser bundle is embedded in tgdl-server;
# no Node runtime, npm install, proxy process or runtime fallback is shipped.
FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm AS build
ARG TARGETOS=linux
ARG TARGETARCH
ARG TARGETVARIANT
# Optional limits for building on a small host (a 1-2 GiB Raspberry Pi can
# run out of memory compiling github.com/gotd/td/tg). Empty keeps Go's
# defaults; see docs/LOW-MEMORY-BUILDS.md.
#   docker build --build-arg GO_BUILD_JOBS=1 --build-arg GO_BUILD_MAXPROCS=2 \
#     --build-arg GO_BUILD_MEMLIMIT=1536MiB .
ARG GO_BUILD_JOBS=
ARG GO_BUILD_MAXPROCS=
ARG GO_BUILD_MEMLIMIT=
WORKDIR /src
# Modules download in their own layer, so a source-only change does not fetch
# the dependency graph again. The caches are BuildKit's, never in the image.
COPY core-service/go.mod core-service/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    go mod download
COPY core-service/ ./
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
    GOARM_V="${TARGETVARIANT#v}"; \
    if [ -n "$GO_BUILD_MAXPROCS" ]; then export GOMAXPROCS="$GO_BUILD_MAXPROCS"; fi; \
    if [ -n "$GO_BUILD_MEMLIMIT" ]; then export GOMEMLIMIT="$GO_BUILD_MEMLIMIT"; fi; \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOARM=${GOARM_V:-7} \
    go build ${GO_BUILD_JOBS:+-p "$GO_BUILD_JOBS"} -trimpath -ldflags "-s -w" -o /out/tgdl-server ./cmd/tgdl-server

FROM scratch AS binaries
COPY --from=build /out/tgdl-server /tgdl-server

FROM debian:bookworm-slim AS runtime
ARG GIT_SHA=dev
ARG BUILT_AT=
ENV PORT=3000 \
    TGDL_DATA_DIR=/app/data \
    GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT}
# gosu drops from the root entrypoint to the app user, as in 2.x. The app user
# keeps the 2.x name and uid (node, 1000) so existing ./data ownership,
# `docker compose exec -u node` and GPU group alignment carry over.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini gosu ffmpeg ca-certificates wget \
    # VA-API userland so FFMPEG_HWACCEL=vaapi works with /dev/dri, as in 2.x
    # (#32): iHD for Intel Broadwell and newer, i965 for older Intel iGPUs
    # (x86 only). vainfo lets operators check the driver with
    # `docker exec <container> vainfo`. Harmless without a GPU.
    && apt-get install -y --no-install-recommends vainfo \
    && if [ "$(dpkg --print-architecture)" = amd64 ]; then \
         apt-get install -y --no-install-recommends intel-media-va-driver i965-va-driver; \
       fi \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid 1000 --home-dir /app --create-home --shell /usr/sbin/nologin node
WORKDIR /app
COPY --from=build /out/tgdl-server /usr/local/bin/tgdl-server
# 2.x compose files call `node scripts/healthcheck.js` and Synology's
# `node src/web/server.js`; the shim maps both to the Go server.
COPY --chmod=0755 docker/node-compat.sh /usr/local/bin/node
COPY --chmod=0755 docker/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions /app/data/backups \
    && chown -R node:node /app
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD /usr/bin/wget -qO- http://127.0.0.1:3000/health || exit 1
# The entrypoint runs as root to fix bind-mount ownership and GPU groups, then
# execs the server as `node`.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["/usr/local/bin/tgdl-server"]
