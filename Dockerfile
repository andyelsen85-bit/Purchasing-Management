# syntax=docker/dockerfile:1.7

# ---- Builder ----------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

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

# Build libs (composite) then API + frontend
RUN pnpm run typecheck:libs \
 && pnpm --filter @workspace/api-server run build \
 && pnpm --filter @workspace/purchasing-management run build

# ---- Runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Copy server bundle + frontend dist
COPY --from=builder /app/artifacts/api-server/dist ./api/dist
COPY --from=builder /app/artifacts/api-server/package.json ./api/package.json
COPY --from=builder /app/artifacts/purchasing-management/dist ./web/dist

# Tiny static-server for serving the SPA — bundled into the API or via node:http.
# The API server in this project also serves the SPA when WEB_DIST is set.
ENV PORT=8080
ENV WEB_DIST=/app/web/dist

EXPOSE 8080

CMD ["node", "--enable-source-maps", "/app/api/dist/index.mjs"]
