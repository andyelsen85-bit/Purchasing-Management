# syntax=docker/dockerfile:1.7

# ---- Builder ----------------------------------------------------------------
# We use Debian-based images (node:20-slim) instead of alpine because the
# repo's pnpm-workspace.yaml `overrides` block excludes every
# `*-linux-x64-musl` native binary (rollup, esbuild, lightningcss,
# @tailwindcss/oxide). On alpine that means vite/rollup cannot load their
# native bindings at build time and the frontend build fails. glibc-based
# slim has the linux-x64-gnu binaries available.
FROM node:20-slim AS builder

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# Copy lockfile + workspace metadata first for better caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./

# Copy package.json files for selective install
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/purchasing-management/package.json artifacts/purchasing-management/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/db/package.json lib/db/

RUN pnpm install --frozen-lockfile --prod=false

# Copy the rest of the sources
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/
COPY artifacts/purchasing-management/ artifacts/purchasing-management/

# Build libs (composite) then API + frontend.
# Vite reads PORT and BASE_PATH at build time (validated in vite.config.ts).
# In production the SPA is mounted at root so BASE_PATH=/, and PORT is only
# needed by the dev server but the config still requires it to parse, so
# we pass a placeholder.
RUN pnpm run typecheck:libs \
 && pnpm --filter @workspace/api-server run build \
 && PORT=80 BASE_PATH=/ pnpm --filter @workspace/purchasing-management run build

# Produce a self-contained runtime tree for the api-server with only its
# production dependencies (nodemailer, pg, drizzle-orm, etc. are externalized
# by the esbuild bundle and need to resolve at runtime).
RUN pnpm --filter @workspace/api-server deploy --prod /deploy/api

# ---- Runtime ----------------------------------------------------------------
# Same base family as the builder (glibc) so native deps that were resolved
# at install time (pg, sharp, ldapjs's bundled deps, etc.) load correctly.
FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# CA certs are needed for outbound TLS (LDAPS, SMTP STARTTLS, etc.).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Mount points for operator-managed state (uploads + TLS material).
# These are exposed as Docker volumes in docker-compose.yml.
RUN mkdir -p /app/state/uploads /app/state/certs

# Self-contained API tree: bundle output + node_modules + manifests.
COPY --from=builder /deploy/api ./api
COPY --from=builder /app/artifacts/api-server/dist ./api/dist
# Vite emits to dist/public — copy that subdirectory so /app/web/dist
# directly contains index.html and the assets/ folder.
COPY --from=builder /app/artifacts/purchasing-management/dist/public ./web/dist

# The API server also serves the SPA when WEB_DIST is set.
ENV PORT=80
ENV HTTPS_PORT=443
ENV WEB_DIST=/app/web/dist
ENV UPLOADS_DIR=/app/state/uploads
ENV CERTS_DIR=/app/state/certs

EXPOSE 80 443

# Entrypoint auto-generates SESSION_SECRET into the state volume if the
# operator didn't provide one via the environment.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "/app/api/dist/index.mjs"]
