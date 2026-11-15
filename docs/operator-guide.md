# Operator Guide

How to run Agent Tournament. Runs use one of two workflows, chosen at creation and fixed for the run:

- **Collaboration** (the default): the agents of a round are one team in one shared folder. They talk through `CHANNEL.md` and build `output/` together, and that folder is judged as one piece of work. Nobody is cloned or removed. Each agent's strategy is rewritten between rounds from the team's score and its own part in the work.
- **Tournament**: a population of agents competes in rounds, each judged on its own `SUBMISSION.md`, with cloning, culling, crossover and mutation between rounds.

`--workflow tournament` (CLI), `"workflow": "tournament"` (API) or the Workflow field in the setup form chooses the tournament.

## Quick start (mock mode, no LLM tokens)

```powershell
npm install
npm run tournament -- --goal "Write a single clear sentence defining what a tournament is." --rounds 2 --population 4 --mode mock
```

Mock mode uses a deterministic fake provider — it scores on keyword overlap, no real LLM calls. Use it to verify the wiring before spending tokens. A mock collaboration run goes through the whole team path: mock agents introduce themselves on the channel, wait for each other's posts, write their part of `output/`, and the first agent writes `output/README.md`.

## Collaboration runs

**The team folder.** Each run has one folder, `team-<runId>` under the workspace root (the container's `/work` under Docker), that carries over from round to round:

- `output/` is the deliverable: the only thing judged. Its entry point is `output/README.md`, which says what was built, how to run or read it, and what is finished.
- `CHANNEL.md` is the message board. Agents post with `node <folder>/.opencode/arena/post.mjs <label> "message"` (or `@label` for one teammate). The helper appends whole entries under a lock, so concurrent posts are never lost. Agents are told never to edit the file by hand.
- `agents/<label>/` is each agent's scratch space; `NOTES.md` there holds its notes from reflection.
- The seed folder, if any, is copied in once, when the folder is created.

**Direct messages.** While agents work, the engine reads `CHANNEL.md` every 2 seconds and queues each new post into the other agents' sessions, behind whatever they are doing; an `@label` post goes only to that agent. Delivery is bounded so a chatty agent cannot flood the others or the budget: at most 2,000 characters of a post, 6,000 per message, one message per agent every 15 seconds (posts in between are combined), and 30 messages per agent per round, the last of which says forwarding has stopped. Agents that have finished are never woken. The live view shows the channel as it happens, and every round's entries are kept.

**Judging.** Once every agent has stopped, `output/` and `CHANNEL.md` are captured once and sealed with a digest. Text files are stored with the round (up to 256 KiB each and 8 MiB per round); binary files are listed with their size and hash. For local and docker runs the grader gets a copy inside its own folder and reads `README.md` first, then opens what it needs with its read-only tools. The team gets one score per round, with the usual decision record. An empty `output/` scores 0 without a scoring call, and so does a team over its quota (one agent's workspace limits per member). Every member's score row repeats the team score, so the analytics and the CSV export keep working.

**Team size.** Under Docker the whole team shares one protected container, charged one agent's ceilings per member: memory and CPUs per agent × agents, plus 256 processes and 2,048 open files per agent, plus one 64 MiB gateway. On the reference machine (~5.2 GiB of free Docker memory, 80% committable) four agents at `1g` fit and five do not, so four is the default team in the setup form and on the CLI. A team that does not fit is refused with the largest team that would. The container restarts every round; the folder does not.

**What changes from a tournament.** No selection, cloning, culling, crossover, diversity floor or elites, and those settings are hidden in the setup form. Every agent runs at once whatever Max parallel agents says. Population changes are manual only (add or retire agents between rounds). Rejudge regrades the sealed output, not the live folder.

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

### Seed strategies

Without seed strategies every agent starts round 1 from a placeholder ("attempt the goal, variant N, focus on <keyword>") that only means something to the mock provider. For a real run, give **Seed strategies folder** in the setup form (or `--seed-strategies` on the CLI, or `seedStrategiesDir` in the API) a folder of `.md` files, one starting strategy per file. They are handed to the agents in file-name order and repeated when there are more agents than files. Empty files and other extensions are ignored; a folder with no strategy is refused before the run is created. The folder is read once, at creation.

### Seed folder

A seed folder (`seedDir`, API only) is copied into every agent's workspace before each round. Its `.git` folders are left behind. Files the seed put there do not count against the workspace quota while they keep their seeded size; files the agent adds or resizes do. Links inside the seed are followed and copied, so a seed that links to a large data folder copies all of it for every agent: use the context folder for material agents only need to read.

### Markdown report

**Export → Markdown report** (or `GET /api/runs/:runId/export?format=md`, or `--report <path>` on the CLI) writes one file with the goal, a leaderboard row per round, the winner of the last scored round, the lineage of its strategy back to a seed, the strategy itself, the judge's rationale and the winning submission. It is meant to be read without the dashboard, by a person or by another agent.

## CLI flags

| Flag | Default | Notes |
|------|---------|-------|
| `--goal` | "Produce the best possible answer." | The task every agent attempts |
| `--rounds` | 5 | Number of rounds |
| `--workflow` | collaboration | `collaboration` (one team, one shared output folder) or `tournament` |
| `--population` | 4 (collaboration), 20 (tournament) | Agents per round |
| `--seed` | 42 | RNG seed (deterministic runs) |
| `--db` | `:memory:` | SQLite path (use a file to persist across runs) |
| `--mode` | mock | `mock` (no LLM) or `real` (LLM via opencode) |
| `--sandbox` | local | `local` (host processes) or `docker` (containers) — real mode only |
| `--workspace` | (none) | Absolute path; agents' working dirs live under it |
| `--auth-file` | (none) | opencode `auth.json` — docker mode only |
| `--judge-model` | (none) | Model id for the judge |
| `--reflect-model` | (none) | Model id for the reflector (mutation) |
| `--worker-models` | (none) | Comma-separated model ids for the agents |
| `--seed-strategies` | (none) | Folder of `.md` files, one round-1 strategy per file (see Seed strategies) |
| `--report` | (none) | Write the run's markdown report to this path when the last round ends |

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
| `--host` | `127.0.0.1` — the dashboard has no authentication; the container image binds `0.0.0.0` inside its own network and is published on host loopback only |
| `--db` | `runs/dashboard.db` — runs survive restarts; `:memory:` for a throwaway session |
| `--workspace-root` | `runs/workspaces` |
| `--auth-file` | `~/.local/share/opencode/auth.json` if it exists — docker runs are refused without credentials |
| `--server-url` | none — start a fresh opencode server per run |
| `--population` | `8` — size of the default mock run |
| `--no-open` | the browser opens by default |
| `--no-docker-sandbox` | docker runs are accepted; the container image sets this only when Docker's socket is not mounted |
| `--docker-reach` | `loopback`: the app runs on the Docker host and reaches containers through ports published on `127.0.0.1`. The container image uses `bridge`: it reaches them at their addresses on Docker's default bridge, and its provider relay listens there for the gateways |

To run the dashboard itself in Docker, see [Run in Docker](../README.md#run-in-docker) in the README.

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
2. **Create a run** — "Create run" takes you to the setup form: name, workflow (collaboration preselected), goal, sandbox mode, roster (model + count + temperature per row), judge/reflect model pickers, selection knobs and concurrency (tournament only), pricing, budget.
   - In a collaboration run the side panel shows the team score and the team channel instead of the leaderboard, and **Team output** below the grid lists each round's sealed output folder: pick a round, pick a file, read it as captured, and see which agents wrote it.
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

**An agent is still working after a long time** — agents have no time limit. After one hour, an agent that is still working is sent one message telling it to write `SUBMISSION.md` with what it has and stop; it reads the message after its current step and wraps up itself. An agent that keeps going anyway, or a model call that never returns, keeps the round waiting: use **Abort** on the round. GLM-5.3-Flash on W&B was seen to stop mid-reply twice on September 15–16, once through the relay and once directly from the host, so such stalls come from the provider. Through the relay, a model reply that sends nothing at all for 15 minutes is treated as a dead connection and closed.

**`no opencode auth.json`** — the docker e2e + real mode need `~/.local/share/opencode/auth.json`. Set `ARENA_DOCKER_AUTH_FILE` to override.

**401 from the opencode server** — the desktop app leaks `OPENCODE_SERVER_USERNAME/PASSWORD` into the shell; the dashboard launcher scrubs them (`$env:OPENCODE_SERVER_USERNAME=""`). If you start the server another way, scrub them yourself.

**Port 4300/4301 in use** — kill the stale node process: `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4300,4301 }` then `Stop-Process -Id <pid> -Force`.

**`workspaceRoot must be absolute`** — docker bind-mounts and local workspace mkdir both need an absolute path. Relative paths 400.

**An agent added between rounds of a local collaboration run fails** — local runs keep one OpenCode server for the whole run, and each member runs under its own profile file in the shared folder (`.opencode/agents/member-<label>.md`). If the server read the folder's profiles before the new member's file existed, it may not know that profile. Docker runs start a fresh server every round and are not affected; for a local run, stop and resume the run (a restart composes a new server) after adding agents.

**A round failed without scores** — abort pre-judge leaves a round row with no scores. The round-detail panel shows "Scoring in progress" for in-flight or "entries appear after judging" for a failed round. The run continues; start the next round.

**Model not found** — the `/api/models` endpoint spawns an opencode server to discover models. If it 502s, the opencode server failed to start; check `auth.json` and that no stale server holds the port.
