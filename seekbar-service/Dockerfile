# syntax=docker/dockerfile:1.6
#
# seekbar-service — Go HTTP service + CLI for video timeline / seekbar
# WebP sprite generation. Multi-arch (amd64 + arm64) via BuildKit's
# automatic TARGETPLATFORM split.
#
# Build:
#   docker buildx build --platform linux/amd64,linux/arm64 -t tgdl-seekbar:latest .
#
# Run (HTTP server, mount the videos read-only + sprite output rw):
#   docker run --rm -p 8089:8089 \
#       -v /path/to/videos:/videos:ro \
#       -v /path/to/sprites:/out \
#       -e SEEKBAR_OUTPUT_DIR=/out \
#       tgdl-seekbar:latest

# ---- Stage 1: build the binaries -----------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS build
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
        go build -trimpath -ldflags '-s -w' -o /out/seekbar-server ./cmd/server && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
        go build -trimpath -ldflags '-s -w' -o /out/seekbar-cli ./cmd/cli

# ---- Stage 2: minimal runtime --------------------------------------------
#
# Debian slim gets the operator a recent ffmpeg with libwebp, VAAPI, QSV,
# CUDA stubs, and Raspberry-Pi v4l2m2m support out of the box on linux/arm64.
# Alpine ffmpeg is smaller but ships without libwebp on some channels.
FROM debian:bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        tini \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Non-root user — matches the telegram-media-downloader convention.
RUN useradd --system --create-home --uid 1000 --user-group seekbar

COPY --from=build /out/seekbar-server /usr/local/bin/seekbar-server
COPY --from=build /out/seekbar-cli    /usr/local/bin/seekbar-cli

ENV SEEKBAR_VERSION=0.2.0 \
    SEEKBAR_OUTPUT_DIR=/data/output \
    SEEKBAR_TEMP_DIR=/data/tmp \
    SEEKBAR_HTTP_LISTEN=:8089 \
    SEEKBAR_HWACCEL=auto \
    SEEKBAR_CONCURRENCY=2 \
    SEEKBAR_LOG_LEVEL=info \
    SEEKBAR_LOG_FORMAT=text

RUN mkdir -p /data/output /data/tmp && chown -R seekbar:seekbar /data

USER seekbar
WORKDIR /home/seekbar
EXPOSE 8089

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/bin/sh","-c","wget -qO- --tries=1 --timeout=3 http://127.0.0.1:8089/health | grep -q '\"ok\":true'"]

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/seekbar-server"]
