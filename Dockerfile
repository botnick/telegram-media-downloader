# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   - "deps" installs prod dependencies only (npm ci --omit=dev) so the runtime
#     image stays small.
#   - "runtime" copies node_modules from "deps" + the source, runs as the
#     non-root `node` user, exposes 3000, and ships a healthcheck that hits
#     the dashboard's /api/auth_check endpoint.
#
# Pin a specific patch version. Floating tags drift; this image is reproducible.

FROM node:20.20.2-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20.20.2-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    TGDL_RUN=monitor

# Add libstdc++ for the prebuilt better-sqlite3 binary.
RUN apk add --no-cache tini libstdc++

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY runner.js watchdog.ps1 config.example.json package.json LICENSE README.md SECURITY.md ./

# Persistent state (sessions, config, downloads) — mount this as a volume.
RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions \
    && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/web/server.js"]
