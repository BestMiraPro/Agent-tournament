#!/bin/sh
# Entry point of the dashboard image (Dockerfile at the repository root).
set -eu

# compose.yaml mounts the host's OpenCode auth.json read-only here, or an empty placeholder
# when none is configured. Linking it into OpenCode's data folder serves both readers: the
# dashboard's default credentials lookup, and OpenCode itself in local runs.
mounted=/run/secrets/opencode-auth.json
link="$HOME/.local/share/opencode/auth.json"

if [ -s "$mounted" ] && [ -r "$mounted" ]; then
  ln -sfn "$mounted" "$link"
else
  # Only a link this script made is removed, never a file someone put there by hand.
  if [ -L "$link" ]; then rm -f "$link"; fi
  if [ -s "$mounted" ]; then
    echo "Agent Tournament: $mounted exists but uid $(id -u) cannot read it; continuing without credentials." >&2
  fi
fi

# 0.0.0.0 inside the container's own network; compose publishes the port on host loopback only.
# Docker runs are refused up front: agent containers are orchestrated from the host.
exec node --import tsx src/server/index.ts --host 0.0.0.0 --no-open --no-docker-sandbox "$@"
