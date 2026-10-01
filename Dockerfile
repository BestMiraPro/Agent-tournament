# Agent Tournament dashboard: the API, WebSocket and built UI on one port, as `npm start` serves
# them. Run it with `docker compose up -d --build` (compose.yaml); see README "Run in Docker".
#
# Mock and local runs work in this container, and local-run agents are confined to it rather
# than to the host. Docker-sandbox runs do not: the app orchestrates agent containers from the
# host (loopback ports, host bind mounts, the provider relay), so they need `npm start` there;
# the entrypoint turns them off so they are refused up front rather than failing midway.
#
# Same pinned base as the agent image (docker/Dockerfile.agent).
FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS ui

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# The UI imports shared types from src/, so both are needed to build it.
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npx vite build --logLevel warn


FROM node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# What local-run agents get, as in the agent image: git because OpenCode initialises a repo in
# each workspace, ripgrep because its grep tool runs rg, python3 for agents that reach for it.
# tini is PID 1 so the OpenCode servers local runs start are reaped and SIGTERM reaches node.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep python3 tini \
    && rm -rf /var/lib/apt/lists/*

# Same OpenCode as the agent image, for local runs.
RUN npm install -g opencode-ai@1.18.21 \
    && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
# tsx is a runtime dependency: the server runs from TypeScript source, as with `npm start`.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY src ./src
COPY --from=ui /app/dist ./dist
COPY --chmod=755 docker/dashboard-entrypoint.sh /usr/local/bin/dashboard-entrypoint

# runs/ holds the database and workspaces; compose mounts a volume over it, which a new
# volume initialises with this ownership.
RUN mkdir -p /app/runs /home/node/.local/share/opencode \
    && chown -R node:node /app/runs /home/node/.local
USER node

EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4300/api/runs').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["tini", "--", "dashboard-entrypoint"]
