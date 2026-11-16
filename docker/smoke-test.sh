#!/bin/sh
# Checks a built agent image the way agents use it: from a folder under /work, in /bin/sh (the
# shell OpenCode picks there, since the image has no zsh). The build already checks every Python
# package against its lock and imports it (toolchain-manifest.py); this covers what agents rely
# on beyond that. Run by .github/workflows/agent-image.yml; by hand:
#   docker run --rm -v "$PWD/docker/smoke-test.sh:/smoke-test.sh:ro" --entrypoint /bin/sh <image> /smoke-test.sh
set -eu

mkdir -p /work/smoke/agent
cd /work/smoke/agent

# The research venv is the python3 agents get.
test "$(command -v python3)" = /opt/arena/venv/bin/python3
python3 -c 'import numpy, pandas, requests, bs4'

# Every toolbox Node package imports from a workspace folder, without an install.
for pkg in $(node -p "Object.keys(require('/opt/arena/node/package.json').dependencies).join(' ')"); do
  node --input-type=module -e "await import('$pkg')"
done

# The commands agents are told about, and the ones the runtime needs.
printf 'const n: number = 1\nconsole.log(n)\n' > check.ts
test "$(tsx check.ts)" = 1
for cmd in tsc vitest opencode claude rg git; do
  "$cmd" --version > /dev/null
done

echo "agent image ok"
