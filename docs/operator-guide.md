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

Docker mode runs agents in resource-capped containers built from the research toolchain image (`agent-arena:tc-<id>`, built automatically the first time and reused after). Requires Docker installed.

### Isolation: protected (default) or shared

**Protected** gives every agent its own container and changes what that container can do:

- **No credentials inside.** The container has no `auth.json` and no API key. Its OpenCode points each provider at a small gateway, which forwards to a relay inside the app. The relay holds the real keys, accepts only model calls for models in the run's roster, allows 2,000 requests per agent, and stops working for the run the moment it is stopped.
- **No other network.** No internet, no DNS, no access to the host's services or to other agents' containers. Scripts cannot download anything and `pip install` fails.
- **Read-only system.** Agents run as an unprivileged user; only their workspace `/work` is writable. The reference folder is at `/context` and the tool inventory at `/run/arena/TOOLS.md`, both read-only.
- **One agent per container.** A run with more agents than **Containers** is refused before anything starts, with the numbers to change.

Every roster provider needs an API key in the credentials file; a provider signed in with OAuth cannot be relayed and the run is refused. OpenCode Zen free models work without a key.

**Shared** is the earlier behaviour: several agents may share a container, the credentials file is mounted read-only, and containers have ordinary network access. Choose it when a run needs something the relay cannot carry.

### Research toolchain

Every container has Python 3.11 with NumPy, pandas, SciPy, matplotlib, PyArrow, DuckDB and pytest (exact versions and hashes in `docker/research-requirements.lock`), plus Node, Git and ripgrep. Nothing is installed at run time. Adding a package is a build-time change: edit `docker/research-requirements.in`, regenerate the lock with hashes, and the next run builds a new image automatically.

### Context folder

**Context folder** in the setup form is read-only reference material. Agents see it at `/context`; the grader reads it on the host and may also search the web to check claims. Do not put secrets there: the grader's web access means a hostile submission could try to steer it into quoting the folder.

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

### When a docker run is refused for memory

Before starting any container, a docker run checks that containers × memory per container fits in 80% of the memory Docker currently has free. Other projects' containers count against that. If the run is refused, the message says how much fits. Any of these gets it through:

- **Fewer containers.** Set **Containers** under the Docker options in the setup form, or run fewer agents. Fewer containers than agents means agents share one and can reach each other's files, so their results can no longer be certified untouched.
- **Less memory per container.** `768m` instead of the default `1g` was measured on September 16, 2026: a research workload (OpenCode plus a 2-million-row pandas/DuckDB backtest and pytest) peaked at 592 MiB, singly and with seven containers at once. `512m` ran out of memory every time, because OpenCode alone uses about 250 MiB. Long agent conversations were not measured, which is why the default stays `1g`. Details: `docs/superpowers/specs/2026-09-16-container-sizing-benchmark.md`; rerun with `npx tsx scripts/benchmark-toolchain.ts`.
- **Protected runs also reserve a gateway per container** (64 MiB and 0.25 CPU each), and the setup form's estimate includes it.
- **Free up Docker memory** by stopping containers you are not using (`docker ps` lists them).
- **Give Docker more memory** in Docker Desktop, under Settings → Resources.

**CPUs per container** is checked the same way against this machine's CPU count.

For UI development with hot reload, run `npm run dashboard -- --no-open` and `npm run web:dev` in two terminals, then open `http://localhost:4301`.

### The dashboard workflow

1. **Browse runs** — the landing page lists all runs with summary stats (rounds, best score, cost). Click a row to open it.
2. **Create a run** — "Create run" takes you to the setup form: name, goal, sandbox mode, roster (model + count + temperature per row), judge/reflect model pickers, selection knobs, concurrency, pricing, budget.
3. **Run a round** — in the run view, the between-rounds controls let you start the next round, override criteria, add/retire agents, abort, or reconfigure (PATCH) the config for the next round.
4. **Review** — the agent grid shows live status; click an agent for its drawer (lineage, genomes, submission, diffs). The analytics panel has the fitness chart, model share, lineage tree. The round-detail panel shows the ranked entries with judge rationales.
5. **Export** — the Export dropdown (JSON or CSV) downloads the full run dump.
6. **Compare** — in the run browser, select two runs (checkboxes) and hit "Compare selected" to see a side-by-side config + score diff.
7. **Rejudge** — in round detail, pick a different judge model and "Rejudge" to see how a different judge would rank the same submissions (non-destructive — original scores are preserved). It uses the same sealed activity evidence as the original grading.
8. **Why this score** — under each ranked entry: whether the grader awarded the number or it was derived from placings (with the arithmetic), the assessment per criterion with the activity it cited, a behavioural review that never changes the score, what the evidence could not show, and the exact grader input and reply.

### Activity audit and behavioural review

Every tool call, refused call, permission answer and failure an agent makes is saved to the database as it happens, with secrets stripped and at most 1,000 records / 1 MiB per agent per round. Before judging, the round's records are sealed with a checksum; anything later is kept as late evidence and does not change what the score was based on. The grader sees each submission's activity and returns a behavioural review: *no issue observed*, *flagged* with cited evidence, or *insufficient evidence*. It is a review, not enforcement — the container limits above are what prevent actions — and it never raises or lowers a score. Attempts that produced nothing are reviewed too. Rounds from before the audit existed say "not recorded". The JSON export includes both the audit and the grading record.

### What you see live

The WebSocket pushes per-agent status/activity/usage and round status/scored/complete events. The grid updates in real time. If the connection drops, the dashboard reconnects with exponential backoff (a "Reconnecting…" banner shows the state).

## Troubleshooting

**Verifying the protected runtime on this machine** — `$env:ARENA_DOCKER_E2E="1"; npx vitest run test/e2e/container-policy.test.ts` starts two protected containers with fake credentials and a fake model provider and checks every boundary above from inside them. It calls no real model and takes about 30 seconds once the image exists.

**A W&B model call hangs** — GLM-5.3-Flash on W&B was seen to stop mid-reply twice on September 15–16, once through the relay and once directly from the host, so the stall is upstream. The 10-minute agent timeout ends it; the agent is recorded as timed out.

**`no opencode auth.json`** — the docker e2e + real mode need `~/.local/share/opencode/auth.json`. Set `ARENA_DOCKER_AUTH_FILE` to override.

**401 from the opencode server** — the desktop app leaks `OPENCODE_SERVER_USERNAME/PASSWORD` into the shell; the dashboard launcher scrubs them (`$env:OPENCODE_SERVER_USERNAME=""`). If you start the server another way, scrub them yourself.

**Port 4300/4301 in use** — kill the stale node process: `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4300,4301 }` then `Stop-Process -Id <pid> -Force`.

**`workspaceRoot must be absolute`** — docker bind-mounts and local workspace mkdir both need an absolute path. Relative paths 400.

**A round failed without scores** — abort pre-judge leaves a round row with no scores. The round-detail panel shows "Scoring in progress" for in-flight or "entries appear after judging" for a failed round. The run continues; start the next round.

**Model not found** — the `/api/models` endpoint spawns an opencode server to discover models. If it 502s, the opencode server failed to start; check `auth.json` and that no stale server holds the port.
