# Agent Tournament dashboard: the API, WebSocket and built UI on one port, as `npm start` serves
# them. Run it with `docker compose up -d --build` (compose.yaml); see README "Run in Docker".
#
# Mock, local and docker runs all work from this container. For docker runs it drives the host's
# Docker through the mounted socket: agent containers start beside it on Docker's default bridge,
# where it reaches them and their gateways reach its provider relay (--docker-reach bridge).
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


FROM docker:29-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c AS docker-cli


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

# The Docker CLI and its BuildKit client, both static binaries: docker runs start agent
# containers, and build their image, on the host's Docker through the mounted socket.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /app
COPY package.json package-lock.json ./
# tsx is a runtime dependency: the server runs from TypeScript source, as with `npm start`.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY src ./src
# The agent image's build files: docker runs build it from docker/, named by a hash of them.
COPY docker ./docker
COPY --from=ui /app/dist ./dist
COPY --chmod=755 docker/dashboard-entrypoint.sh /usr/local/bin/dashboard-entrypoint

# runs/ holds the database; compose mounts a volume over it.
RUN mkdir -p /app/runs

# OpenCode's own data in here, apart from $HOME: compose mounts the host's OpenCode data folder
# read-only at its host path, which for a root user on Linux is this container's $HOME too.
ENV XDG_DATA_HOME=/var/lib/agent-tournament

# Root, deliberately: with Docker's socket mounted this container controls the host's Docker,
# which is root-equivalent there whichever user holds it, so a non-root user would protect
# nothing. It would also need the socket's group, which differs between Docker Desktop and Linux.

EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4300/api/runs').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["tini", "--", "dashboard-entrypoint"]
