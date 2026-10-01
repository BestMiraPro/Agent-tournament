#!/bin/sh
# Entry point of the dashboard image (Dockerfile at the repository root).
set -eu

# 0.0.0.0 inside the container's own network; compose publishes the port on host loopback only.
set -- --host 0.0.0.0 --no-open "$@"

# Docker runs drive the host's Docker through its socket: agent containers start beside this one
# on Docker's default bridge, which is how they are reached. Without the socket they are refused
# up front instead of failing after model validation.
if [ -S /var/run/docker.sock ]; then
  set -- --docker-reach bridge "$@"
else
  set -- --no-docker-sandbox "$@"
fi

# Docker resolves the paths this app hands it on the host, so compose.yaml mounts each host
# folder at its own path in here and names it.
if [ -n "${ARENA_WORKSPACE_ROOT:-}" ]; then
  set -- --workspace-root "$ARENA_WORKSPACE_ROOT" "$@"
fi

# Credentials: auth.json in the host's OpenCode data folder, mounted read-only at its own path.
# Its host path is what docker runs mount into agent containers; OpenCode in here reads it through
# a link in its own data folder.
auth="${ARENA_OPENCODE_DATA:-/nonexistent}/auth.json"
link="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
mkdir -p "$(dirname "$link")"
if [ -s "$auth" ] && [ -r "$auth" ]; then
  ln -sfn "$auth" "$link"
  set -- --auth-file "$auth" "$@"
elif [ -L "$link" ]; then
  # Only a link this script made is removed, never a file someone put there by hand.
  rm -f "$link"
fi

# The model catalogue docker runs pin in agent containers: OpenCode's models.json, its copy of
# models.dev. OpenCode in here writes it on first use; fetching it now lets the first docker run
# find it. A failure only means that run asks for it.
catalogue="${XDG_CACHE_HOME:-$HOME/.cache}/opencode/models.json"
if [ ! -s "$catalogue" ]; then
  mkdir -p "$(dirname "$catalogue")"
  node -e '
    const fs = require("fs"), file = process.argv[1]
    fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
      .then((text) => { JSON.parse(text); fs.writeFileSync(file + ".tmp", text); fs.renameSync(file + ".tmp", file) })
      .catch((e) => console.error("Agent Tournament: could not fetch the model catalogue (" + e.message + ")"))
  ' "$catalogue" &
fi

# Protected agent containers run as uid:gid 1000:1000 and write the workspaces this app creates.
# On a Linux host the bind mount keeps real ownership, so this app (root in here, for the socket)
# creates them in group 1000 and group-writable. Docker Desktop's file sharing grants containers
# access whatever the owner, so on macOS this changes nothing.
umask 0002
exec setpriv --regid=1000 --clear-groups node --import tsx src/server/index.ts "$@"
