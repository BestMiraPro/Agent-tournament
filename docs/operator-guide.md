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

**Local agents run as you.** Their shell commands can read and change anything your account can, your home folder included, and what they read is sent to their model provider. Profile rules keep their file tools inside the workspace, but a shell command is not confined. Use the docker sandbox for anything you would not hand to a stranger; the setup form says so when you pick local.

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

- **No credentials inside.** The container has no `auth.json`, API key or connector credential. Its OpenCode points each provider at a small gateway, which forwards to a relay inside the app; connector and web tools go through the same gateway to the app's tool bridge (see Connectors). The relay holds the real keys, accepts only model calls for models in the run's roster, allows 2,000 requests per agent, and stops working for the run the moment it is stopped. The one exception is a Claude subscription agent, whose own `claude` process holds your setup token (see below).
- **No other network.** No internet, no DNS, no access to the host's services or to other agents' containers. Scripts cannot download anything and `pip install` fails. In runs with Claude subscription agents the gateway also offers a CONNECT proxy that reaches `api.anthropic.com:443` and nothing else.
- **Read-only system.** Agents run as an unprivileged user; only their workspace `/work` is writable. The reference folder is at `/context` and the tool inventory at `/run/arena/TOOLS.md`, both read-only.
- **One agent per container.** A run with more agents than **Containers** is refused before anything starts, with the numbers to change.

Every roster provider needs an API key in the credentials file; a provider signed in with OAuth cannot be relayed and the run is refused. One OAuth login is the exception: OpenCode's ChatGPT Plus/Pro login for `openai`. Claude subscription agents do not use the relay at all (see [Subscriptions](#subscriptions-claude-promax-and-chatgpt-pluspro) below). OpenCode Zen free models work without a key.

**Shared** is the earlier behaviour: several agents may share a container, the credentials file is mounted read-only, and containers have ordinary network access. Choose it when a run needs something the relay cannot carry.

### Shared toolbox

Agents start with packages already installed, so they don't spend time or disk installing common ones:

- **Python 3.11** with NumPy, pandas, SciPy, matplotlib, PyArrow, DuckDB, pytest, requests and Beautiful Soup (exact versions and hashes in `docker/research-requirements.lock`).
- **Node packages** typescript, tsx, zod, fastify, express and vitest (exact versions and integrity hashes in `docker/toolbox-node/package-lock.json`). `import 'zod'` works from any folder, and `tsx`, `tsc` and `vitest` are on PATH.

Docker containers have them in the image, plus Node, Git and ripgrep. Local runs get the same packages in `.arena-toolbox` under the workspace root, built the first time a local run starts there (it downloads the pinned packages, so the first run takes a little longer) and again whenever the package files change. The Python part needs [uv](https://docs.astral.sh/uv/); without it, local agents get only the Node packages and the run says so. The toolbox is read-only: an agent that needs another package installs it into its own folder, and the prompt tells it how. Set `ARENA_TOOLBOX=off` to start local runs without it.

Adding a package is a change to the package files: for Python, edit `docker/research-requirements.in` and regenerate the lock with hashes (the command is at the top of the lock); for Node, run `npm install --package-lock-only --save-exact <name>@<version>` in `docker/toolbox-node`. The next Docker run builds a new image and the next local run rebuilds the toolbox.

In local runs agents' commands run in `/bin/sh`, as in Docker, not in your login shell, so your shell's startup files (and anything they export) don't reach them.

### Workspace disk limit

Each agent's workspace may use up to 1 GiB of disk, and a collaboration team gets 1 GiB per member. Every file counts as at least 4 KiB, which is how a filesystem allocates space, so a flood of empty files hits the limit too; there is no separate limit on the number of files. A workspace over the limit scores 0 for the round, and the prompt tells agents the limit. Installed packages (`node_modules`, `.venv`, `__pycache__` and similar) count toward it but are not hashed, stored or judged.

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

## Web search and page fetch for agents

With **Web access** on in the setup form (the default), agents in **local and docker** runs get two tools served by the app itself, through the same tool bridge as connectors: `arena_web_search` (titles, URLs and snippets) and `arena_web_fetch` (one public page as text). OpenCode's own `webfetch` and `websearch` stay off for them, so their tool searches are the counted, recorded ones. Local CLI runs (`--mode real --sandbox local`) get the same tools unless started with `--no-web-access`, and their calls go into the run's audit. Docker workers reach them through their gateway's tool route and still have no open network. A collaboration team shares one bridge identity, limited by the run-wide counts below. In local mode an agent can still run `curl` from its shell: local runs have no isolation, so the toggle decides which tools are offered, not what the network allows.

**Which search provider answers.** LangSearch, when its key is configured. Without a key, and whenever LangSearch fails (bad key, rate limit, used-up daily allowance, server error, timeout), the call goes to Exa's public search endpoint instead, without a key or with yours if `EXA_API_KEY` is set. The setup form's status line shows which applies; each result says which provider answered.

**Getting a LangSearch key** (free plan, no card, as of November 15, 2026): sign up at [langsearch.com](https://langsearch.com), open the dashboard, and create an API key. The free plan has a daily token allowance, shown in the dashboard and reset at 00:00 UTC, and 5 requests per second; bursts beyond either fall back to Exa automatically.

**Where to put it.** In a `.env` file in the repository folder (git ignores it):

```
LANGSEARCH_API_KEY=your-key
EXA_API_KEY=optional-exa-key
```

With `npm start` the app reads the file on every search, so no restart is needed. `docker compose` passes both through from the same file; run `docker compose up -d` again after adding them. An environment variable of the same name takes precedence over the file. The keys stay in the app: they are not written into agent workspaces or passed to the OpenCode server the app starts, whose environment local agents' shell commands inherit, and never appear in the database, exports or events.

**What is enforced:**

- Per agent, per run: 200 searches and 500 page fetches. Per run in total: 2,000 searches and 5,000 fetches. A refused call is still recorded.
- Pages: http and https only, at public addresses. Loopback, private networks, link-local and cloud metadata (`169.254.169.254` and others), CGNAT, multicast and reserved ranges are refused, in IPv4 and IPv6 spellings. The name is resolved once per hop and the connection goes to the checked address, so a DNS answer cannot change in between. At most 5 redirects, each checked again; 20 seconds per fetch; reading stops after 2 MiB; at most 64,000 characters returned. HTML becomes readable text; text, JSON and XML are returned as they are; PDFs, images and other binaries are refused.
- When the run stops, its tokens stop working immediately.

**Evidence.** Every call is a `network` record in the activity audit, from the source `tool_bridge` (attributed to the team in a collaboration round): the query, or the page's host and path (never its query string), the provider and why LangSearch did not answer if it did not, the status, bytes and duration. It is sealed with the round's evidence the grader sees; the agent's card shows the tool call from OpenCode's own event stream.

**Your own Claude Code files stay out.** The OpenCode server the app starts for local runs runs with your home folder, and by default OpenCode would add `~/.claude/CLAUDE.md` to every agent's instructions and list the skills under `~/.claude` and `~/.agents`. The app starts it with `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, so neither reaches the agents or their model provider. A server you attach with `--server-url` keeps its own environment. Local agents can still run shell commands, so local runs are not a boundary for anything else in your home folder; use Docker for that.

**OpenCode version.** Local agents reach the tools through `.opencode/opencode.json` in their workspace, in the format of OpenCode 1.18.21 (the version the agent image pins and this was checked against). Later OpenCode releases document a different MCP configuration format; if `arena_web_search` does not appear in a local agent's tool calls, check `opencode --version` on the host.

## Subscriptions: Claude Pro/Max and ChatGPT Plus/Pro

Agents, the judge and the reflector can run on your subscriptions instead of API keys. Pick them like any other model; the setup form labels them **subscription**.

| | Claude Pro/Max | ChatGPT Plus/Pro |
|---|---|---|
| Model ids | `claude-subscription/<model>`, e.g. `claude-subscription/claude-opus-5-5`; aliases `opus`, `sonnet`, `haiku`, `fable` | OpenCode's own `openai/<model>`, e.g. `openai/gpt-5.5` |
| Harness | The Claude Code CLI (`claude -p`), the only client Anthropic allows to use a subscription | OpenCode, like every other model |
| Sign in | `claude setup-token`, then paste the token under **Subscriptions** in the setup form. Without a token, local runs use this machine's own `claude auth login` | `opencode auth login` → OpenAI → ChatGPT Plus/Pro |
| Where it is kept | `runs/secrets/claude-subscription.json`, mode 0600. Never in the database, exports, logs, events or a command line. A local CLI gets it on a file descriptor; a containerised CLI through a 0600 env file removed as soon as the CLI starts | OpenCode's `auth.json`, as always |
| local | Token or host login | Works as in OpenCode |
| docker, shared | Setup token only (it is in the CLI process's environment inside the container, as `auth.json` is in that mode) | `auth.json` is mounted read-only: if the access token expires mid-round, OpenCode inside cannot save the refresh and its calls fail (the run warns) |
| docker, protected | Setup token only. The unmodified `claude` process in the container holds your token itself and reaches only `api.anthropic.com:443`, through the gateway's CONNECT route; the relay never sees it | The relay refreshes the login on the host and forwards to the ChatGPT Codex backend; no credential enters the container |

How a Claude agent runs: one `claude -p` per attempt in the agent's workspace (locally) or through `docker exec` in its shard, with streamed input so the steering message (and later messages) reach it at its next step. Its strategy is appended to Claude Code's system prompt. It may use Bash, Read, Edit, Write, Glob, Grep, TodoWrite and NotebookEdit; it has no web access, no subagents and no MCP servers; edits are confined to its workspace, the context folder and tool inventory are readable but not editable, and `.env` files (including `.env.example`) are unreadable. Locally, Bash can still reach anything your user can, exactly as for OpenCode agents. Temperature does not apply (the CLI has no such setting). The CLI runs with your settings files, CLAUDE.md, hooks, plugins and auto-memory turned off (`--safe-mode`, `--setting-sources=`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`), and every inherited `ANTHROPIC_*`/`CLAUDE*` variable is removed first, so an API key in your shell can never silently switch it to API billing. In host mode it still records the agent workspaces as projects in your `~/.claude.json`.

Judging and reflecting on a Claude model run the CLI on this machine with JSON output; a schema-constrained call uses `--json-schema`. Judge calls may read the context folder; the Claude judge cannot search the web (the OpenCode grader can).

**Usage limits.** Subscription calls cost $0 and report $0; their tokens still count against the token budgets. A USD cap still needs a price line for every roster model, so add `claude-subscription/<model> 0 0 0 0` for subscription models if you set one. When Claude reports the subscription's limit, the agent fails with `SUBSCRIPTION_LIMIT` ("This is the subscription's limit, not the agent's failure", with the reset time) and later Claude attempts fail at once until the reset instead of starting the CLI again; the setup form shows the last reading. A ChatGPT 429 closes the relay's ChatGPT upstream until the reset (`Retry-After`, else a minute). Selection still treats such an attempt as a failed attempt.

**Errors you may see.** `CLAUDE_AUTH_EXPIRED`: paste a fresh `claude setup-token` value, or `claude auth login`. `CLAUDE_CLI_MISSING`: install Claude Code or set `CLAUDE_CLI_PATH`. A relayed ChatGPT call refused with "ChatGPT sign-in expired": run `opencode auth login` → OpenAI → ChatGPT Plus/Pro again. "the credentials file is read-only here": the relay will not refresh a login it cannot save back, because refreshing rotates the refresh token and would strand your host OpenCode; run any OpenCode command on the host to refresh it (this is the case in the Docker-hosted dashboard, which mounts `auth.json` read-only).

**ChatGPT token refresh in protected runs.** Every relayed request re-reads `auth.json`, so a token your host OpenCode refreshed is used as is. The relay refreshes only within two minutes of expiry, under a lock file beside `auth.json`, after re-reading it, and writes the rotated pair back atomically before using it. OpenCode itself does not take that lock, so a refresh by both at the same instant can still race; if OpenAI refuses the relay's refresh, the relay re-reads the file first in case OpenCode won.

**Protected Claude agents: the token is in the container.** The worker's own `claude` process holds your setup token (`CLAUDE_CODE_OAUTH_TOKEN`) and nothing else in the container does. The worker still has no network; the CLI goes out with `HTTPS_PROXY=http://gateway:8789`, a CONNECT proxy on the shard gateway that tunnels to exactly `api.anthropic.com:443` and refuses every other host, port, IP literal and method. The route exists only in runs with Claude subscription agents. Claude Code 2.1.325 with an OAuth token in `CLAUDE_CODE_OAUTH_TOKEN` (a placeholder in testing: no real setup token was used) and nonessential traffic off contacted no other host. The trade-off: an agent runs as the same user as its CLI, so it could read the token from the CLI's environment and use it to reach `api.anthropic.com`, which is the access the run grants it anyway. If that is not acceptable for a task, do not put Claude subscription agents in it. The tool bridge refuses any connector or web call whose arguments carry your setup token, as is, percent-encoded or in base64, so it cannot leave through `arena_web_fetch` or a connector.

**Terms.** Anthropic's legal and compliance page (code.claude.com/docs/en/legal-and-compliance) says developers "may not collect, store, or intermediate Claude.ai credentials or session tokens", and explicitly allows "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". That is how this app uses your Claude subscription: it never calls the API with your token itself, the provider relay never holds, matches or injects it, and each agent is the unmodified Claude Code binary signed in with your own token. Use subscriptions for your own work, within each provider's terms.

**Not covered here.** The Docker-hosted dashboard image does not include the Claude Code CLI, so from it Claude models work only as Docker agents with a setup token, not as local agents, judge or reflector.

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
| `--no-web-access` | off | Local real runs: do not give agents the web tools (see Web search and page fetch) |

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
| `--host` | `127.0.0.1` — the dashboard has no authentication, so it answers only requests whose Host is loopback or this address and whose Origin (if any) is too; the container image binds `0.0.0.0` inside its own network and is published on host loopback only |
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
2. **Create a run** — "Create run" takes you to the setup form: name, workflow (collaboration preselected), goal, sandbox mode, roster (model + count + temperature per row), judge/reflect model pickers, connectors, selection knobs and concurrency (tournament only), pricing, budget.
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
