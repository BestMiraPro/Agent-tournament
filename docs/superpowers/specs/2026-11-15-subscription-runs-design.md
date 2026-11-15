# Subscription runs: Claude Pro/Max and ChatGPT Plus/Pro

Verified end to end without a real model or token (2026-11-15): `ClaudeCodeAgentRunner` → `docker exec` into the agent image (uid 1000, read-only root) → Claude Code 2.1.325 → this repo's provider relay → a scripted fake Anthropic upstream. The upstream saw only `/v1/messages?beta=true` with the swapped-in setup token, the agent wrote `SUBMISSION.md`, and quiesce confirmed the process group gone.

Date: 2026-11-15. Branch: `phase8-subscription-runs`.

Agents, the judge and the reflector can run on the owner's Claude and ChatGPT subscriptions instead of
API keys. Claude runs through the official Claude Code CLI; ChatGPT runs through OpenCode's own
ChatGPT Plus/Pro login, on the same harness as every other OpenCode model.

## Verified facts (this machine, 2026-11-15)

Every flag below was checked against the installed CLI (`claude --version` → 2.1.325) and, where it
matters, exercised against a local fake Anthropic upstream with a placeholder OAuth token, an
isolated `HOME`/`CLAUDE_CONFIG_DIR`, and every other host routed to a refusing proxy. Two tiny real
calls were made on the owner's host login (`haiku`, "reply OK") to record a genuine stream.

Claude Code CLI 2.1.325:

- `-p --input-format stream-json --output-format stream-json --verbose` reads JSON user messages from
  stdin. A message written while a turn is running is delivered **inside that turn**, at the next tool
  boundary ("The user sent a new message while you were working: …"); there is still one `result`.
  The process does **not** exit after `result` while stdin is open; it exits ~40 ms after stdin
  closes. So the runner closes stdin on `result` and waits for the exit.
- `--append-system-prompt=<text>` adds to Claude Code's own system prompt (which teaches it its
  tools). The `=` form keeps a strategy that starts with `--` a value: `--append-system-prompt=--dangerously-skip-permissions …`
  arrived as text. All value flags are passed in `=` form; repeated `--add-dir=` and
  `--disallowedTools=` accumulate.
- `--tools=Bash,Read,…` sets the offered built-ins; unknown names are ignored silently. With
  `default` this version offers Agent, ListAgents, ReportFindings, ScheduleWakeup, ToolSearch,
  Workflow and deferred tools (WebFetch/WebSearch among them), so the list is explicit. WebFetch is
  then "disabled for this session, in subagents as well as here".
- `--permission-mode=acceptEdits --permission-prompts=none`: edits inside the working directories
  (cwd and `--add-dir`) are accepted; anything that would prompt is denied automatically with a
  `system/permission_denied` event and an error tool result. Observed: Write in the workspace ok,
  Write outside denied, Read outside the working dirs denied, Bash allowed only via
  `--allowedTools=Bash`. `--permission-mode=dontAsk --allowedTools=Write` instead allowed a Write
  **outside** the workspace, so it is not used.
- Deny rules win: `Edit(//abs/dir/**)`, `Write(//abs/dir/**)` refused edits in an `--add-dir` folder
  ("File is in a directory that is denied by your permission settings"); `Read(**/.env)` refused the
  workspace `.env`.
- `--safe-mode` (no CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents) works with all the
  above; `--setting-sources=` (empty), `--strict-mcp-config`, `--no-session-persistence`,
  `--disable-slash-commands`, `--session-id=<uuid>` accepted. `CLAUDE_CODE_DISABLE_CLAUDE_MDS`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_MAX_RETRIES`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` are names the binary reads.
- `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3` with the token written to fd 3 authenticates
  (`Authorization: Bearer <token>` upstream) with no token in the environment. The Bash tool's
  environment does not contain `CLAUDE_CODE_OAUTH_TOKEN` even when it is set.
- With `ANTHROPIC_BASE_URL` and an OAuth token the CLI sends `POST <base>/v1/messages?beta=true`,
  `Authorization: Bearer <token>`, `anthropic-beta: …oauth-2025-04-20…`, `user-agent: claude-cli/2.1.325 (external, sdk-cli)`,
  `x-app`, `x-claude-code-session-id`, `anthropic-version`, `anthropic-dangerous-direct-browser-access`.
  With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` nothing else was contacted: the refusing proxy
  saw no connection at all, and the upstream saw only `/v1/messages`.
- `--json-schema=<schema>` adds a `StructuredOutput` tool; the `--output-format json` result has
  `structured_output` (the object) and `result` (its JSON text).
- Stream shapes: `system/init` (`session_id`, `tools`, `model`, `permissionMode`, `apiKeySource`),
  `assistant` (one content block per line, `message.id` shared, per-request `usage`),
  `user` (tool results, `tool_use_result`, `tool_result_meta[].permission_decision`),
  `rate_limit_event` (`rate_limit_info.status` `allowed` | `rejected`, `resetsAt`, `rateLimitType`,
  `unifiedWindows.*.utilization`), `system/api_retry` (`attempt`, `error_status`), and `result`
  (`subtype`, `is_error`, `api_error_status`, `terminal_reason`, `usage` with
  `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`,
  `total_cost_usd`, `permission_denials`, `num_turns`).
- A subscription limit (upstream 429 with `anthropic-ratelimit-unified-status: rejected`) is not
  retried: `rate_limit_event` `rejected`, then `result` `is_error: true`, `api_error_status: 429`,
  "You've hit your 5-hour limit · resets …". An expired token (401) is retried twice (~2 s), then
  `result` `is_error: true`, `api_error_status: 401`. The CLI exits 1 in both cases.
- On a subscription, `total_cost_usd` is still reported (list-price equivalent), so it is not money.
- `claude auth status --json`: `loggedIn`, `authMethod` (`claude.ai` for a subscription, `none`),
  `apiProvider`, `subscriptionType`, `loginExpiresAt`, plus account fields that are never read
  out. Exit 1 when not logged in.
- npm `@anthropic-ai/claude-code@2.1.325` is a wrapper whose per-platform optional packages carry
  the native binary (~365 MB each for Linux); integrities are recorded in
  `docker/claude-code/package-lock.json`.

OpenCode 1.18.21 (read from the binary in the agent image):

- The `openai` provider has auth methods "ChatGPT Pro/Plus (browser)", "ChatGPT Pro/Plus
  (headless)" and "Manually enter API Key". A ChatGPT login is stored in `auth.json` as
  `{"openai": {"type": "oauth", "refresh", "access", "expires" (ms epoch), "accountId"?}}`.
- Client id `app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`; refresh is
  `POST /oauth/token` form `grant_type=refresh_token&refresh_token=…&client_id=…`, response
  `access_token`, `refresh_token`, `expires_in`, `id_token`. OpenCode refreshes when
  `!access || expires < Date.now()` and writes the rotated pair back through `auth.set`.
- Requests go to `https://chatgpt.com/backend-api/codex/responses` (the endpoint is a constant,
  not configurable) with `authorization: Bearer <access>`, `ChatGPT-Account-Id` (from the
  `chatgpt_account_id` claim of the id or access token), `x-openai-internal-codex-residency` (the
  `chatgpt_compute_residency` claim unless `no_constraint`), and, for every `openai` request,
  `originator: opencode`, `User-Agent: opencode/…`, `session-id`.
- Under OAuth the request prep puts the system prompt in `instructions` instead of input messages,
  and the catalogue keeps gpt-5.5, gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini and newer gpt-X.Y
  (not gpt-5.6, not pro variants) with cost zeroed.
- In API-key mode (a protected worker: relay config, no `auth.json`) the same request arrives at
  `POST /openai/responses` with `input[0] = {"role": "developer", "content": <system>}` and no
  `instructions`; headers `originator`, `session-id`, `x-session-affinity`, `x-session-id`,
  `user-agent: opencode/1.18.21 …`. Captured against a fake server from the agent image.

## Design

### Model ids and routing

- `claude-subscription/<model>`: `<model>` must match `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$`
  (so nothing that starts with `-` reaches argv). Full ids (`claude-opus-5-5`) and the CLI aliases
  `opus`, `sonnet`, `haiku`, `fable` are accepted.
- ChatGPT models keep their OpenCode ids under `openai/` (`openai/gpt-5.5`); whether a run bills
  the subscription follows from the credentials file, exactly as in OpenCode.
- `DispatchingAgentRunner` routes each agent by its genome's model: `claude-subscription/*` to
  `ClaudeCodeAgentRunner`, everything else to `OpenCodeAgentRunner`. Mixed rosters work; every
  AgentRunner method fans out or routes to the runner that holds the agent.
- `RoutingProvider` does the same for judge, reflect, criteria and review calls.

### ClaudeCodeAgentRunner

- One `claude -p` process per agent attempt, in the agent's workspace (`cwd` locally; `docker exec -i -w /work/<agent>`
  in a Docker shard). Argv: the flags above plus `--model=<m>`, `--append-system-prompt=<strategy>`,
  `--tools=Bash,Read,Edit,Write,Glob,Grep,TodoWrite,NotebookEdit`, `--add-dir=` for each read-only
  folder (context, `/run/arena`) with `Edit/Write/NotebookEdit(//dir/**)` deny rules, and
  `Read(**/.env)`, `Read(**/.env.*)`, `Read(**/*.env)` deny rules. That is the competitor policy of
  `src/core/genome.ts` with one difference: Claude Code cannot re-allow `.env.example` under a deny
  rule, so it is refused too.
- The GOAL message is `buildAgentPrompt`, the first stdin message. The steering prompt and
  `send(handle, text)` (new optional `AgentRunner` method, also the seam for collaboration mode)
  write further user messages; they reach the agent at its next tool boundary. A send to an agent
  that is not running rejects.
- Temperature has no CLI flag and is ignored for these agents.
- No MCP servers (`--strict-mcp-config` without `--mcp-config`). The connectors seam is the argv
  builder's `mcpConfig` option, unused here.
- Stream translation (`stream.ts`, pure) produces the same `agent.activity` items the OpenCode bridge
  emits (text, tool running/completed/error with redacted, capped output, failures). Permission
  refusals are tool errors; the audit's refusal detection recognises Claude Code's wording, as it
  does OpenCode's. The `system/init` session id goes through the same `onSessionCreated` hook, so the
  live cache and the audit key by session as before. Events reach the dashboard through
  `ComposedRun.attachActivity(runId, emit)`, called where the OpenCode bridges start.
- Usage: summed per unique `message.id` while running, replaced by the `result` totals. `costUsd` is
  always 0 (the CLI's `total_cost_usd` is a list-price figure). A run that ends without `result`
  reports what it observed, and `usageKnown: false` only when it observed nothing.
- Failures (`AgentFailure.code`):
  - `CLAUDE_CLI_MISSING`: the binary could not be started.
  - `CLAUDE_AUTH_EXPIRED`: 401/403 or the CLI's sign-in wording; says to run `claude setup-token` or `claude auth login`.
  - `SUBSCRIPTION_LIMIT`: `rate_limit_event` `rejected` or 429; carries the reset time and says
    it is the subscription's limit, not the agent's failure. A per-process gate then fails later
    Claude attempts immediately until the reset, instead of starting CLIs into the same wall.
  - `CLAUDE_ERROR`: anything else, with the API status when known.
- Abort, quiesce, timeouts: the same guarantees as the OpenCode runner. A live attempt is retained
  until both local return and confirmed termination. Locally the CLI is its own process group
  (POSIX) and is killed with the group (`taskkill /T /F` on Windows); the `exit` event is the
  confirmation, after which the group is swept once more for leftover tool processes. In Docker the
  CLI runs as a session leader under `setsid`, writes its pid to a tmp file, and is killed with
  `kill -KILL -- -<pgid>` through `docker exec`; the exec client's exit, or `kill -0` failing, or
  the container being gone, confirms it. `quiesce` waits at most `QUIESCE_GRACE_MS`.

### Credentials

- `token` mode: the value printed by `claude setup-token`, pasted in the dashboard, normalised
  (whitespace removed) and validated (`^[A-Za-z0-9._~+/=-]{20,4096}$`), stored in
  `runs/secrets/claude-subscription.json` with mode 0600 (directory 0700). It is never written to
  SQLite, exports, logs, events or argv: locally it goes to the CLI on fd 3; in a shared Docker
  container through `docker exec -e CLAUDE_CODE_OAUTH_TOKEN` (the value comes from the docker
  client's environment, not its argv). Locally, token mode uses a private `CLAUDE_CONFIG_DIR` per run in the OS temp folder (outside the workspace root, so no runtime-folder sweep can remove it mid-run); in a container the CLI uses the container's own home, recycled every round.
- `host` mode: the machine's own Claude Code login (`claude auth login`), used when no token is
  stored and `claude auth status` reports `loggedIn` with `authMethod: claude.ai`. Local runs only:
  a container has no access to the host's keychain.
- Environment: every `ANTHROPIC_*` and `CLAUDE*` variable is removed (API keys and base URLs that
  would switch billing, Bedrock/Vertex/Foundry switches, and the session variables of whatever
  Claude Code launched this app), then the runner sets only what it needs:
  `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, and per mode the token
  descriptor, `CLAUDE_CONFIG_DIR`, or the relay's `ANTHROPIC_BASE_URL`.

### ClaudeCodeProvider

`claude -p --output-format=json --tools= …` with the prompt on stdin, `--json-schema` when the
caller passes a schema (`structured_output` is returned as JSON text, otherwise the text result goes
through the callers' existing zod parsing). Judge, criteria and review calls with a context folder
get `--tools=Read,Glob,Grep --add-dir=<context>`; reflect gets no tools. No web search (the OpenCode
grader can search; this one cannot). Usage is accumulated with cost 0; failures throw with the same
classification.

### Docker

- The agent image installs `@anthropic-ai/claude-code` from `docker/claude-code/package-lock.json`
  with `npm ci` (sha512-verified, only the platform's native package), links `claude` on PATH, and
  the inventory records its version. Both files are toolchain files, so the image tag changes.
- Shared isolation: token mode only; the token is in the CLI process's environment inside the
  container, as `auth.json` already is in that mode.
- Protected isolation: verified that the CLI honours `ANTHROPIC_BASE_URL` with an OAuth token and
  talks to nothing else. The worker gets `ANTHROPIC_BASE_URL=http://gateway:8787/claude-subscription`
  and `CLAUDE_CODE_OAUTH_TOKEN=<per-run relay token>`; the relay accepts only
  `POST /claude-subscription/v1/messages[?beta=true]` (and `…/count_tokens`), checks the body's model
  against the roster, forwards a fixed header allowlist and swaps the run token for the real
  subscription token on the way to `https://api.anthropic.com`. The client is still Claude Code;
  the relay only forwards. Requires token mode, and full model ids (the CLI resolves an alias before
  the request, so the relay could not match it to the roster); the small/fast model variables are set
  to the agent's own model so no auxiliary call names a model outside the roster.

### ChatGPT through OpenCode

- Local and shared Docker: unchanged mechanics. OpenCode reads the login from `auth.json` (shared
  mode mounts it read-only). A shared-mode warning says a refresh inside the container cannot be
  saved if the access token expires mid-round.
- Protected: the relay carries this one OAuth login. `relayUpstreamsFromAuth` turns an `openai`
  `oauth` entry into a ChatGPT upstream; every other OAuth login is still refused. Per request the
  relay asks a `ChatGptLogin` for a fresh access token: it re-reads `auth.json` (adopting a token the
  host OpenCode refreshed), and only when the token is within 2 minutes of expiry takes an
  in-process lock plus a lock file beside `auth.json`, re-reads again, refreshes with the issuer and
  client id above, and writes the rotated pair back atomically (temp file + rename, mode 0600,
  other providers preserved) before using it. A `refresh_token_reused`/`invalid_grant` answer first
  re-reads the file in case OpenCode rotated it concurrently. The request is forwarded to
  `https://chatgpt.com/backend-api/codex/responses` with the token, `ChatGPT-Account-Id`, residency,
  and the worker's `originator`/`session-id`/`user-agent`; leading `developer`/`system` input
  messages move into `instructions`, which is what OpenCode does itself under OAuth. The worker's
  catalogue copy has the `openai` costs zeroed, as OpenCode's plugin does under OAuth.
- Errors are distinct: a refresh refused by the issuer is `401` "ChatGPT sign-in expired: run
  `opencode auth login` → OpenAI → ChatGPT Plus/Pro"; an upstream 429 is "ChatGPT subscription usage
  limit reached" and closes the upstream until the reset (`Retry-After`, else 60 s), so a worker
  retry loop cannot hammer it.

### Budget

Subscription calls report `costUsd: 0`. Tokens count against token budgets as for any model. The
tracker is unchanged: subscription models are unpriced like any other, so a USD cap still refuses a
roster without prices for them (an explicit `0 0 0 0` price line is a real price and passes).

### Dashboard and API

- `GET /api/subscriptions`: Claude (`cli`: found + version or missing; `token`: set or not, never the
  value; `host`: login detected or not; effective mode; last rate-limit reading) and ChatGPT
  (`signedIn`, `expired`, `expiresAt` from `auth.json`; never a token), plus the subscription model
  lists.
- `PUT /api/subscriptions/claude` `{ "token": "…" }` stores the token; `DELETE` removes it.
- Run setup gets a Subscriptions panel (status, paste box, instructions: `claude setup-token`;
  `opencode auth login` → OpenAI → ChatGPT Plus/Pro) and subscription models in the roster and
  judge/reflect pickers labelled "subscription".

## Not in scope

Connectors (`--mcp-config` seam only), web search for Claude agents, collaboration mode (only the
`send` seam), real-model end-to-end suites. Selection still treats a `SUBSCRIPTION_LIMIT` attempt as
a failed attempt; the failure says why.
