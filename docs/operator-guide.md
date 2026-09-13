# Operator Guide

How to run an Agent Tournament — the 100-agent parallel LLM competition with rounds, cloning/mutation, and an LLM judge.

## Quick start (mock mode, no LLM tokens)

```powershell
npm install
npm run tournament -- --goal "Write a single clear sentence defining what a tournament is." --rounds 2 --population 4 --mode mock
```

Mock mode uses a deterministic fake provider — it scores on keyword overlap, no real LLM calls. Use it to verify the wiring before spending tokens.

## Real mode (local — agents as host processes)

```powershell
npm run tournament -- `
  --goal "Produce the best possible answer." `
  --rounds 5 --population 20 --seed 42 `
  --db arena.db `
  --mode real --sandbox local `
  --workspace "C:\Users\you\arena-runs" `
  --judge-model "wandb/zai-org/GLM-5.2" `
  --reflect-model "wandb/deepseek-ai/DeepSeek-V4-Flash" `
  --worker-models "wandb/deepseek-ai/DeepSeek-V4-Flash"
```

Requires opencode `auth.json` at `~/.local/share/opencode/auth.json`. The CLI starts an opencode server, spawns agents as host processes against it, and runs rounds sequentially.

## Real mode (docker — agents in containers)

```powershell
npm run tournament -- `
  --goal "Produce the best possible answer." `
  --rounds 3 --population 10 `
  --mode real --sandbox docker `
  --workspace "C:\Users\you\arena-runs" `
  --auth-file "$env:USERPROFILE\.local\share\opencode\auth.json" `
  --judge-model "wandb/zai-org/GLM-5.2" `
  --worker-models "wandb/deepseek-ai/DeepSeek-V4-Flash"
```

Docker mode runs each agent in a resource-capped container, bind-mounting the auth file read-only. Requires Docker installed + the `agent-arena:latest` image built.

## CLI flags

| Flag | Default | Notes |
|------|---------|-------|
| `--goal` | "Produce the best possible answer." | The task every agent attempts |
| `--rounds` | 5 | Number of rounds |
| `--population` | 20 | Agents per round |
| `--seed` | 42 | RNG seed (deterministic runs) |
| `--db` | `:memory:` | SQLite path (use a file to persist across runs) |
| `--mode` | mock | `mock` (no LLM) or `real` (LLM via opencode) |
| `--sandbox` | local | `local` (host processes) or `docker` (containers) — real mode only |
| `--workspace` | (none) | Absolute path; agents' working dirs live under it |
| `--auth-file` | (none) | opencode `auth.json` — docker mode only |
| `--judge-model` | (none) | Model id for the judge |
| `--reflect-model` | (none) | Model id for the reflector (mutation) |
| `--worker-models` | (none) | Comma-separated model ids for the agents |

## Dashboard (live operator view)

Start it with one command, or double-click `Start Agent Tournament.cmd` in the project folder:

```powershell
npm start
```

It builds the interface, starts one server at `http://127.0.0.1:4300`, and opens it in your browser. The console prints where data, workspaces and credentials are coming from. Press Ctrl+C, or close the window, to stop. Starting it again while it is already running just opens the running one.

Nothing needs configuring first. The defaults, each overridable with a flag after `--` (for example `npm start -- --port 4400`):

| Flag | Default |
|------|---------|
| `--port` | `4300` |
| `--db` | `runs/dashboard.db` — runs survive restarts; `:memory:` for a throwaway session |
| `--workspace-root` | `runs/workspaces` |
| `--auth-file` | `~/.local/share/opencode/auth.json` if it exists — docker runs are refused without credentials |
| `--server-url` | none — start a fresh opencode server per run |
| `--population` | `8` — size of the default mock run |
| `--no-open` | the browser opens by default |

For UI development with hot reload, run `npm run dashboard -- --no-open` and `npm run web:dev` in two terminals, then open `http://localhost:4301`.

### The dashboard workflow

1. **Browse runs** — the landing page lists all runs with summary stats (rounds, best score, cost). Click a row to open it.
2. **Create a run** — "Create run" takes you to the setup form: name, goal, sandbox mode, roster (model + count + temperature per row), judge/reflect model pickers, selection knobs, concurrency, pricing, budget.
3. **Run a round** — in the run view, the between-rounds controls let you start the next round, override criteria, add/retire agents, abort, or reconfigure (PATCH) the config for the next round.
4. **Review** — the agent grid shows live status; click an agent for its drawer (lineage, genomes, submission, diffs). The analytics panel has the fitness chart, model share, lineage tree. The round-detail panel shows the ranked entries with judge rationales.
5. **Export** — the Export dropdown (JSON or CSV) downloads the full run dump.
6. **Compare** — in the run browser, select two runs (checkboxes) and hit "Compare selected" to see a side-by-side config + score diff.
7. **Rejudge** — in round detail, pick a different judge model and "Rejudge" to see how a different judge would rank the same submissions (non-destructive — original scores are preserved).

### What you see live

The WebSocket pushes per-agent status/activity/usage and round status/scored/complete events. The grid updates in real time. If the connection drops, the dashboard reconnects with exponential backoff (a "Reconnecting…" banner shows the state).

## Troubleshooting

**`no opencode auth.json`** — the docker e2e + real mode need `~/.local/share/opencode/auth.json`. Set `ARENA_DOCKER_AUTH_FILE` to override.

**401 from the opencode server** — the desktop app leaks `OPENCODE_SERVER_USERNAME/PASSWORD` into the shell; the dashboard launcher scrubs them (`$env:OPENCODE_SERVER_USERNAME=""`). If you start the server another way, scrub them yourself.

**Port 4300/4301 in use** — kill the stale node process: `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4300,4301 }` then `Stop-Process -Id <pid> -Force`.

**`workspaceRoot must be absolute`** — docker bind-mounts and local workspace mkdir both need an absolute path. Relative paths 400.

**A round failed without scores** — abort pre-judge leaves a round row with no scores. The round-detail panel shows "Scoring in progress" for in-flight or "entries appear after judging" for a failed round. The run continues; start the next round.

**Model not found** — the `/api/models` endpoint spawns an opencode server to discover models. If it 502s, the opencode server failed to start; check `auth.json` and that no stale server holds the port.
