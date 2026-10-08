# syntax=docker/dockerfile:1.7
# Pure-Go production image. The browser bundle is embedded in tgdl-server;
# no Node runtime, npm install, proxy process or runtime fallback is shipped.
FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS build
ARG TARGETOS=linux
ARG TARGETARCH
ARG TARGETVARIANT
WORKDIR /src
COPY core-service/ ./
RUN GOARM_V="${TARGETVARIANT#v}"; \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOARM=${GOARM_V:-7} \
    go build -trimpath -ldflags "-s -w" -o /out/tgdl-server ./cmd/tgdl-server

FROM debian:bookworm-slim AS runtime
ARG GIT_SHA=dev
ARG BUILT_AT=
ENV PORT=3000 \
    TGDL_DATA_DIR=/app/data \
    GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT}
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ffmpeg ca-certificates wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home-dir /app --create-home --shell /usr/sbin/nologin tgdl
WORKDIR /app
COPY --from=build /out/tgdl-server /usr/local/bin/tgdl-server
RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions /app/data/backups \
    && chown -R tgdl:tgdl /app
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD /usr/bin/wget -qO- http://127.0.0.1:3000/health || exit 1
USER tgdl
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/tgdl-server"]
