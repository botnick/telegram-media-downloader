# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the pnpm monorepo:
#   - "deps"     installs every workspace's dependencies, including dev,
#                so the build stage can compile TypeScript.
#   - "build"    runs `tsc -b` for each compiled workspace.
#   - "runtime"  installs prod-only deps + copies the built artefacts.
#
# Pin a specific patch version. Floating tags drift; this image is
# reproducible.

# ---------------------------------------------------------------------------
# deps — full install (dev + prod) for the build stage
# ---------------------------------------------------------------------------
FROM node:24.15.0-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.4 --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile TypeScript
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm -F @tgdl/shared build
RUN pnpm -F @tgdl/server build

# ---------------------------------------------------------------------------
# prod-deps — slim install with prod-only deps
# ---------------------------------------------------------------------------
FROM node:24.15.0-bookworm-slim AS prod-deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.0.4 --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------
# runtime — minimal image
# ---------------------------------------------------------------------------
FROM node:24.15.0-bookworm-slim AS runtime

ARG GIT_SHA=dev
ARG BUILT_AT=
ENV NODE_ENV=production \
    PORT=3000 \
    GIT_SHA=${GIT_SHA} \
    BUILT_AT=${BUILT_AT}

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini gosu ffmpeg procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prod-only node_modules (workspace symlinks intact).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/apps/cli/node_modules ./apps/cli/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules

# Built TypeScript output. shared's package.json + src/ also need to
# land in the runtime image because:
#   - exports map points at ./dist/index.js (built artefact)
#   - prod-deps stage doesn't run the build script, so the symlinked
#     @tgdl/shared from apps/server/node_modules has no dist/ until
#     we copy one in from the build stage.
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/src ./packages/shared/src

# Source for workspaces that don't compile (CLI + core stay .js for now).
COPY apps/cli ./apps/cli
COPY packages/core ./packages/core

# Static frontend assets (HTML + vanilla JS modules + CSS + icons).
COPY apps/web ./apps/web

# Workspace + lockfile so pnpm at runtime can resolve workspace links.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Manifests + scripts that the running app expects.
COPY scripts ./scripts
COPY runner.js config.example.json LICENSE README.md SECURITY.md ./

RUN mkdir -p /app/data /app/data/downloads /app/data/logs /app/data/sessions \
    && chmod -R a+rX /app \
    && chmod +x /app/scripts/docker-entrypoint.sh \
    && chown -R node:node /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
