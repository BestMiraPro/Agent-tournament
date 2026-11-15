# Connectors — design

**Date:** 2026-11-15 · **Status:** draft for review · **Branch:** `phase8-connectors`

## Why

Tournament agents can only use their workspace, their shell and the model access the relay grants. Research tasks need
read access to the owner's own sources: GitHub, Slack, Gmail and the MCP servers already configured for Claude Code.
Handing an agent those credentials would defeat the protected runtime, and an agent selected on outcome will use any write
capability it is given. Connectors give agents those sources as MCP tools through one host-side bridge that holds the
credentials, enforces a tool allowlist, bounds every call and records it as evidence.

## Decided requirements

- **Slack and Gmail are read-only, hard-locked.** Only search/read/list tools are ever exposed. Send, post, reply, react,
  schedule, draft, label-change and delete tools are never reachable, and no setting enables them. Enforced host-side in
  the bridge by a code-defined allowlist, never by prompt.
- **Everything else defaults to read-only:** tools annotated `readOnlyHint: true`. Write tools on GitHub and imported
  servers can be permitted per connector by the operator (off by default) and must then also be opted into per run.
- **Credentials never reach a worker**: not in configs, mounts, environment, argv, events, logs, exports, SQLite or the
  browser. They live in one `0600` secrets file outside every workspace.

## Verified facts this relies on (OpenCode 1.18.21 source, tag `v1.18.21`)

- `mcp` config entries: `{ type: "remote", url, enabled?, headers?: Record<string,string>, oauth?: false | {...},
  timeout?: positive int }` (`packages/core/src/v1/config/mcp.ts`). Remote servers are tried with Streamable HTTP first,
  then SSE, with `headers` passed as `requestInit.headers` (`packages/opencode/src/mcp/index.ts`).
- MCP tools are named `sanitize(server) + "_" + sanitize(tool)`, where `sanitize` replaces `[^a-zA-Z0-9_-]` with `_`
  (`packages/opencode/src/mcp/catalog.ts`). No annotation filtering happens in OpenCode.
- Before an MCP tool runs, OpenCode asks permission `{ permission: <tool key>, patterns: ["*"] }`
  (`packages/opencode/src/session/tools.ts`), so an agent profile rule `"github_*": allow` answers it.
- Instance config is loaded per session directory and includes `.opencode/opencode.json` from `.opencode` directories
  between the directory and the worktree root, after `OPENCODE_CONFIG` (`packages/opencode/src/config/config.ts`). A
  per-agent file therefore merges over a protected shard's relay config without replacing it.

## Design

### 1. Connector registry (`src/connectors/`)

A connector is `{ id, title, kind, transport, auth, policy }`:

- `id`: `^[a-z][a-z0-9-]{0,31}$`, which is also its OpenCode MCP server key, so its tools are `<id>_<tool>`. Ids whose
  `<id>_` prefixes an OpenCode built-in permission or tool (`external`, `doom`, `apply`) are refused, so a connector's
  permission rule can never widen `external_directory`, `doom_loop` or `apply_patch`.
- `kind`: `github` | `slack` | `gmail` | `custom` (custom covers imported servers).
- `transport`: `stdio` (command, args, env, secret env names), `http` (URL, headers, secret header names), or the
  in-house `slack` / `gmail` servers.
- `auth`: `none`, `token` (manual, or `gh auth token` for GitHub, read at connect time and never stored), `oauth-google`
  (Gmail) or `oauth-mcp` (the SDK's MCP OAuth for remote servers).
- `policy`: `disabledTools` (read tools the operator switched off) and `writeTools` (write tools the operator permits;
  always empty and refused for locked connectors).

Storage, host-side only, in `--connectors-dir` (default `runs/connectors`, beside — never under — `runs/workspaces`):

- `connectors.json`: the records above plus the last tool snapshot from **Test connection**. No credential values.
- `secrets.json`: tokens, secret env/header values, secret URLs, OAuth client secrets, refresh/access tokens and MCP
  OAuth state. Written atomically with mode `0600` (owner only; ignored on Windows).

Every composition with a connector store refuses a run whose workspace root, context folder or seed folder contains the
store or lies inside it: the context folder is mounted into workers and the seed folder is copied into workspaces.

### 2. Tool policy (pure, `src/connectors/policy.ts`)

`exposedTools(connector, upstreamTools, runWriteOptIns)` decides what an agent may list and call:

- **Locked (Slack, Gmail):** upstream tools whose exact name is in the preset's code-defined read allowlist, minus
  `disabledTools`. Nothing else, whatever the stored policy, the run spec or the upstream's annotations say. A test checks
  that no allowlist entry contains a write verb.
- **Others:** tools annotated `readOnlyHint: true`, minus `disabledTools`, plus tools that are in `writeTools` **and** in
  the run's opt-ins. Unannotated tools count as write tools.

The bridge applies this set to `tools/list` and again to every `tools/call`; a refused call never reaches the upstream.

### 3. Presets

- **GitHub** — the official GitHub MCP server. Remote (default, `https://api.githubcopilot.com/mcp/`, `Authorization:
  Bearer <token>`, plus `X-MCP-Readonly: true` while no write tool is permitted) or local stdio (`github-mcp-server stdio`,
  `GITHUB_PERSONAL_ACCESS_TOKEN`, plus `GITHUB_READ_ONLY=1` while no write tool is permitted). Token: a fine-grained PAT,
  or `gh auth token` when the operator chooses it.
- **Slack** — an in-house read-only server (`src/connectors/slack/`) over the Web API with a user token. It implements
  only `search_messages`, `list_channels`, `read_channel`, `read_thread`, `get_user`, `list_users`, and its HTTP client
  refuses any method outside `search.messages`, `conversations.list|history|replies`, `users.info|list`. Chosen over a
  third-party server because the lock is then provable from this repository alone: no write code exists, the client
  cannot call one, and the bridge allowlist sits on top.
- **Gmail** — an in-house read-only server (`src/connectors/gmail/`) over the Gmail REST API: `search_messages`,
  `get_message`, `get_thread`, `list_labels`, GET only, `users/me/...` only. OAuth: the operator's own Google
  desktop-app client, authorization code + PKCE (S256), scope `https://www.googleapis.com/auth/gmail.readonly` only. A
  token response granting any other scope is refused and nothing is stored. Access tokens are refreshed host-side.
- **Remote MCP servers with MCP OAuth** — the SDK's `auth()` with an `OAuthClientProvider` backed by the secrets file
  (PKCE, dynamic client registration). The browser step starts from the dashboard.

OAuth callbacks land on the dashboard's own origin (`/api/connectors/oauth/callback`), which works from `npm start` and
from the container image alike; the start request's `Host` must be a loopback name. Pending flows expire after 10
minutes and are matched by an unguessable `state`.

### 4. Import from Claude Code (read only)

`discoverClaudeCodeServers` reads `~/.claude.json` (`mcpServers` and `projects[*].mcpServers`),
`~/.claude/settings.json` (`mcpServers` when present), each known project's `.mcp.json`, and plugin `.mcp.json` files
under `~/.claude/plugins` (bounded walk). It never writes those files. The dashboard lists what it found with secret
values masked; importing one creates a `custom` connector, moving secret-looking env values, headers and credential-
bearing URLs into the secrets file. `${CLAUDE_PLUGIN_ROOT}` is expanded at import; other `${VAR}` references are kept
and expanded from the host environment when the server starts. claude.ai-hosted connectors are not in those files and
cannot be imported (their OAuth tokens belong to claude.ai); the presets above replace them.

### 5. Host tool bridge (`src/connectors/bridge*.ts`)

One Streamable HTTP MCP endpoint per process, started on first use like the provider relay, never keeping the process
alive by itself. Loopback by default; the app's bridge address under `--docker-reach bridge`. Path `/mcp/<connectorId>`,
POST only (stateless; GET/DELETE answer 405), JSON responses.

- **Grants:** a run gets a grant at composition. Each agent gets its own bearer token, minted on first use, so every
  call is attributed to an agent by the host, not by anything the worker says. Revoked first when the run stops; a
  revoked or unknown token gets 401 and the run's upstreams are closed.
- **Upstreams:** external servers (stdio or HTTP) are opened once per run with their credentials and shared by the run's
  agents. In-process servers (Slack, Gmail, built-ins) are connected with the SDK's in-memory transport; built-ins get a
  server per agent.
- **Limits:** request body ≤ 256 KiB, 500 tool calls per agent per run, 60 s per call, result ≤ 256 KiB (a larger
  result becomes a tool error telling the agent to narrow its request).
- **Evidence:** every `tools/call` — allowed, refused, failed, timed out or too large — emits an `agent.connector`
  event: connector, tool, agent, outcome, status, request/response bytes, duration, argument *names* only, and a fixed
  error text (never upstream error text, which can echo inputs). The audit collector stores it as `source:
  "tool_bridge"`, `kind: "tool"`, so it is frozen and sealed with the round like any other evidence; the live activity
  cache shows it as a tool item. Argument values and results are not recorded by the bridge.

Only tools are bridged: resources and prompts from upstreams are not exposed.

### 6. Reaching the bridge from every mode

The same policy and evidence path in every mode; connector servers never run inside worker containers.

| Mode | Endpoint the worker uses |
|---|---|
| local | `http://127.0.0.1:<bridge port>/mcp/<id>` (the app's bridge address under `--docker-reach bridge`) |
| docker, shared | `http://host.docker.internal:<bridge port>/mcp/<id>` (the app's bridge address under `bridge`) |
| docker, protected | `http://gateway:8788/mcp/<id>`: a **third fixed gateway route**, `GATEWAY_TOOLS_PORT`, forwarding to the bridge exactly like the relay route |

The gateway always carries exactly three routes (worker API, relay, tools); with no grant the tools route only ever
answers 401.

The runner-agnostic description is `grant.endpointsFor(agentId, baseUrl) → { id, title, url, headers }[]`. OpenCode
gets it as `.opencode/opencode.json` in the agent's workspace (remote MCP servers, `oauth: false`, bearer header,
`timeout` above the bridge's call timeout), written by the runner right before the session starts. A later Claude Code
runner can render the same list as `claude --mcp-config`. The competitor profile allows `"<id>_*"` for each enabled
connector. TOOLS.md lists each enabled connector and its exposed tools.

Shared-container caveat (stated in the docs): co-tenants can read each other's workspaces, so they can read each other's
bridge token; the bridge still attributes calls by token.

### 7. Built-in connectors hook

```ts
registerBuiltinConnector({
  id: 'web', title: 'Web search', readOnly: true,
  createServer: (ctx: { runId: string; agentId: string; connectorId: string;
                        evidence: (note: { summary: string; detail?: string; kind?: 'tool' | 'network' }) => void })
    => McpServer | Server,
})
```

Built-ins appear in the dashboard and the run picker, are enabled per run like any connector, get one server per agent,
and pass through the same limits and evidence. `ctx.evidence` adds extra records (for example a fetched URL) under the
same agent. `readOnly: true` means every tool is treated as read and no write opt-in exists. `src/connectors/web/` is
reserved for the web search server; the integration step registers it at startup.

### 8. Run config and API

- `RunSpec.connectors` / `RunConfig.connectors`: `{ id, writeTools: string[] }[]` (≤ 16, unique ids). Refused for mock
  runs. Stored with the run (ids and tool names only) and carried through PATCH and resume.
- Composition resolves every id, refuses unknown ids, write opt-ins on a locked connector, and opt-ins the connector
  does not permit; connects each upstream, lists tools, and refuses the run naming any connector that cannot connect.
- API: `GET/POST /api/connectors`, `PATCH/DELETE /api/connectors/:id`, `POST /api/connectors/:id/test`,
  `GET/POST /api/connectors/import`, `POST /api/connectors/:id/oauth/start`, `GET /api/connectors/oauth/callback`.
  Responses say which secrets are set, never their values.

### 9. Dashboard

A **Connectors** page: list, add preset (GitHub, Slack, Gmail, remote URL, local command), import from Claude Code,
connect/OAuth, test connection (lists tools), tool table with read tools toggleable, write tools permittable, and
Slack/Gmail write tools shown locked. RunSetup gets a connector picker with per-run write opt-ins where permitted.

## Tests that carry the claims

- Slack/Gmail write tools cannot be listed or called through the bridge under any stored policy, run opt-in or
  upstream annotation, and their upstream never sees such a call.
- Secrets do not appear in worker configs, container args, mounts, env, events, API responses or exports.
- The bridge refuses after the run is revoked and past the per-agent call limit.
- Gateway args carry exactly three routes.

## Known gaps

- Connector results reach the agent, and from there OpenCode's own tool events (bounded, redacted) like any tool output.
- Shared Docker mode reaches the bridge through `host.docker.internal`, which Docker Desktop provides; on a Linux host
  without it, use `--docker-reach bridge` or protected isolation (whose gateway has the same requirement as the relay).
- Local mode has no isolation: a local agent runs as the host user and can read anything that user can.
