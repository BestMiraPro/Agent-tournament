# Operator Guide

How to run an Agent Tournament: a population of LLM agents competing in rounds, with cloning/mutation between rounds and an LLM judge.

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

- **No credentials inside.** The container has no `auth.json`, API key or connector credential. Its OpenCode points each provider at a small gateway, which forwards to a relay inside the app; connector tools go through the same gateway to the app's tool bridge (see Connectors). The relay holds the real keys, accepts only model calls for models in the run's roster, allows 2,000 requests per agent, and stops working for the run the moment it is stopped.
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

## Connectors

Connectors give agents tools from GitHub, Slack, Gmail and other MCP servers. Open **Connectors** from the run browser or the setup form, add or import a connector, test it, then tick it under **Connectors** when you create a local or docker run.

### How they work

- **The dashboard holds every credential.** Tokens, OAuth clients and refresh tokens live in `runs/connectors/secrets.json` (owner-only, mode `0600`), beside the workspaces and never under them. Connector settings without credentials live in `runs/connectors/connectors.json`. Neither is in the database, an export, a log, an event, a worker's config, mount, environment or command line. Change the folder with `--connectors-dir`. A run whose workspace root, context folder or seed folder overlaps it is refused.
- **Agents reach a connector only through the tool bridge**, a small MCP endpoint inside the dashboard at `/mcp/<connector>`. Each agent gets its own token for the run, written to `.opencode/opencode.json` in its workspace; the bridge holds the real credentials and the connection to the real server. Local agents reach it on `127.0.0.1`, shared Docker containers through `host.docker.internal`, and protected containers through their gateway's third fixed route (`http://gateway:8788`). Under `--docker-reach bridge` the dashboard's own bridge address replaces the first two.
- **Read-only by default.** Slack and Gmail are read-only and locked: search, read and list tools only, from a list fixed in code. Sending, posting, replying, reacting, scheduling, drafting, labelling and deleting are never offered, and no setting enables them. Every other connector exposes the tools its server marks read-only. A write tool (GitHub's `create_issue`, say) must be permitted on the Connectors page **and** ticked for each run that may use it.
- **Bounded and recorded.** Each agent may make 500 connector calls per run; each call has 60 seconds and a 256 KiB result. Every call — allowed, refused, failed or cut off — is saved with the round's evidence (connector, tool, agent, outcome, sizes, time, argument names; never argument values or results) and shows on the agent's card. When a run stops, its tokens stop working at once.
- **TOOLS.md** in docker runs lists each connector and the tools agents can call, named as they see them (`github_search_code`).

Shared containers: agents sharing one container can read each other's workspaces, so they can read each other's bridge token. Calls are still attributed by token. Local runs have no isolation at all: a local agent runs as you.

The OpenCode activity stream reports connector calls too, like any tool call, with its usual bounded and redacted output. What a connector returns to an agent can therefore appear in that agent's activity, as a shell command's output can.

### GitHub

Uses GitHub's official MCP server. Agents get its read-only tools; the dashboard also asks GitHub for read-only mode until you permit a write tool.

1. Create a **fine-grained personal access token**: github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Choose the resource owner and **Only select repositories** (the ones agents may read). Repository permissions, all **Read-only**: Contents, Issues, Pull requests, Metadata (added automatically); add Actions or Discussions read access if a task needs them. Grant write permissions only if you will permit write tools.
2. Connectors → Add a connector → GitHub → paste the token → Add connector → Test connection.

Alternatively choose **Read `gh auth token` each time a run starts** to use the GitHub CLI's login (`gh auth login` first). That token carries every scope `gh` was granted, so a fine-grained token is the narrower choice. Server: **GitHub's remote server** (`https://api.githubcopilot.com/mcp/`) needs nothing installed. If your account cannot use it, choose **Local github-mcp-server binary** and put `github-mcp-server` (from github.com/github/github-mcp-server/releases) on the dashboard's PATH.

### Slack

An in-house read-only server inside the dashboard: `search_messages`, `list_channels`, `read_channel`, `read_thread`, `get_user`, `list_users`. It can only call Slack's `search.messages`, `conversations.list/history/replies` and `users.info/list`.

1. api.slack.com/apps → Create New App → From scratch → name it, pick the workspace.
2. OAuth & Permissions → **User Token Scopes**: `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`. Add no write scope.
3. Install to Workspace (an admin may need to approve), then copy the **User OAuth Token** (`xoxp-…`).
4. Connectors → Add a connector → Slack → paste it → Add connector → Test connection.

Agents see what your account sees. A bot token (`xoxb-…`) with the same scopes as bot scopes also works, except for search, which Slack allows only with a user token.

### Gmail

An in-house read-only server inside the dashboard: `search_messages`, `get_message`, `get_thread`, `list_labels`, GET requests only. It signs in with your own Google OAuth client, scope `https://www.googleapis.com/auth/gmail.readonly` only; a sign-in that grants anything more is refused and nothing is stored.

1. console.cloud.google.com → create or pick a project → APIs & Services → Library → enable the **Gmail API**.
2. OAuth consent screen: user type External (or Internal for a Workspace domain), add yourself as a test user, add the scope `.../auth/gmail.readonly`.
3. Credentials → Create credentials → OAuth client ID → application type **Desktop app**. Copy the client ID and client secret.
4. Connectors → Add a connector → Gmail → paste both → Add connector → **Connect (sign in)**. Google's page opens in a new tab; approve read-only access. The tab says the connector is connected; the dashboard refreshes the access token itself from then on.

Start the sign-in from the dashboard at `http://127.0.0.1:<port>` or `http://localhost:<port>`: the callback comes back to the dashboard's own address, and any other host is refused. While the consent screen is in **Testing**, Google expires refresh tokens after 7 days: connect again when **Test connection** reports `invalid_grant`.

### Other MCP servers

- **Remote (URL)**: give the server URL and, if it uses one, a bearer token. Leave the token blank for a server that signs in with MCP OAuth, then choose **Connect (sign in)**: the dashboard registers itself with the server, opens its sign-in page, and keeps the tokens.
- **Local (command)**: the dashboard starts the command on this machine with a minimal environment (PATH, HOME and the variables you set), never its own.
- **Import from Claude Code**: **Find Claude Code servers** lists what `~/.claude.json` (user and per-project servers), `~/.claude/settings.json`, project `.mcp.json` files and plugin `.mcp.json` files configure, with credentials masked. Import copies one; values that look like credentials go to the secrets file. These files are only read. Connectors hosted by claude.ai (its Gmail, Slack, GitHub, Google Drive, Todoist …) are not in them and cannot be imported: their sign-ins belong to claude.ai. Use the presets above.

Imported and custom servers expose only the tools they mark read-only until you permit others.

### Built-in connectors

Connectors the app provides itself (such as web search, when it is installed) are listed under **Built in**. They are read-only and need no credentials; enable them per run like any other.

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
| `--docker-reach` | `loopback`: the app runs on the Docker host and reaches containers through ports published on `127.0.0.1`. The container image uses `bridge`: it reaches them at their addresses on Docker's default bridge, and its provider relay and tool bridge listen there for the gateways |
| `--connectors-dir` | `runs/connectors` — connectors and their credentials (owner-only files); see Connectors |

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
2. **Create a run** — "Create run" takes you to the setup form: name, goal, sandbox mode, roster (model + count + temperature per row), judge/reflect model pickers, connectors, selection knobs, concurrency, pricing, budget.
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

**A round failed without scores** — abort pre-judge leaves a round row with no scores. The round-detail panel shows "Scoring in progress" for in-flight or "entries appear after judging" for a failed round. The run continues; start the next round.

**Model not found** — the `/api/models` endpoint spawns an opencode server to discover models. If it 502s, the opencode server failed to start; check `auth.json` and that no stale server holds the port.
