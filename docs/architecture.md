# Architecture

Agent Tournament runs a population of LLM agents through repeated rounds with evolutionary selection, a blind LLM judge, and a live dashboard. This doc describes how the pieces fit.

## System diagram

```
                          ┌─────────────┐
                          │   CLI       │  npm run tournament
                          │  src/cli.ts │──► runTournamentCli()
                          └──────┬──────┘
                                 │
            ┌────────────────────┴────────────────────┐
            │                                         │
       ┌────▼────┐                              ┌─────▼─────┐
       │ Engine  │                              │  Server   │  npm run dashboard
       │ driver   │◄────events──► EventBridge ──►│  api.ts   │
       │ budget   │                              │  index.ts │
       │ pool     │                              └─────┬─────┘
       └────┬─────┘                                   │
            │                                    ┌────▼────┐
            │                                    │   Web   │  served by npm start
            │                                    │ App.tsx │◄── WebSocket /ws
            │                                    └─────────┘
            │
       ┌────▼────────────────────────────┐
       │ Runtime (sandbox abstraction)    │
       │  mock / local / docker / opencode │
       └────┬────────────────────────────┘
            │
       ┌────▼────┐
       │  Judge  │  scores submissions on the goal + criteria
       │ Reflector│ rewrites survivor strategies (mutation)
       └─────────┘
            │
       ┌────▼────┐
       │   DB    │  node:sqlite — runs, rounds, agents, genomes, scores, submissions
       └─────────┘
```

## Two entry points, one engine

- **CLI** (`src/cli.ts`): `npm run tournament` — runs N rounds to completion, prints the winner. Headless.
- **Dashboard** (`src/server/index.ts` + `web/`): `npm start` — one process serves the API, the WebSocket and the built UI on :4300 (`src/server/static-ui.ts`). The operator starts rounds manually, watches live, and reconfigures between rounds. For UI development, `npm run dashboard` + `npm run web:dev` keeps hot reload, with Vite proxying back to the API.

Both share the same engine (`src/engine/driver.ts`), judge (`src/judge/`), reflector (`src/evolution/`), and DB (`src/db/`). The dashboard adds a server (Fastify + WS) and a React UI; the engine is the same.

## The round lifecycle

One round, end to end:

1. **Start** — `POST /api/runs/:id/rounds` (or the CLI loop) calls `engine.runRound(runId, { goalMd, criteriaMd })`.
2. **Prepare** — the engine creates a round row, resolves each agent's genome (seed/elite/clone/mutation/crossover), and writes `GOAL.md` + `STRATEGY.md` into each agent's workspace.
3. **Run** — the pool (`src/runtime/pool.ts`) runs agents in parallel (bounded by `concurrency`). Each agent is a sandboxed opencode session that reads its strategy and writes a `SUBMISSION.md`. The budget tracker (`src/engine/budget.ts`) tallies tokens/cost per agent/round/run and fails over-budget agents.
4. **Capture** — `src/engine/capture.ts` reads each `SUBMISSION.md` + file manifest the moment its agent stops, then re-verifies it once no agent in the round is still running; a change in between is recorded as tampering and the captured copy is what gets judged. Stores a `submissions` row.
5. **Judge** — the evidence audit (`src/engine/audit.ts`) is frozen and sealed with a digest first, so the grader sees a fixed evidence set. Then `src/judge/judge.ts` scores the submissions against the goal + criteria (auto-generates criteria if none given). Mode: `single_call` (one prompt, all submissions) or `batched_finals` (pairwise finals). Submissions are anonymised and shuffled per round. Stores `scores` rows (rank, score, band, rationale) and a grading audit per score (`src/judge/audit.ts`).
6. **Select** — `src/core/selection.ts` ranks agents; the top band clones, the bottom band is culled, elites are kept verbatim, crossover (4d) breeds children. The `diversityFloor` (4f) rescues the most distinct culled agent.
7. **Reflect** — `src/evolution/reflect.ts` rewrites each survivor's strategy for the next round (the mutation operator). LLM-recombine (4f) merges two parent strategies with a split-merge fallback.
8. **Complete** — the round row is marked ended; the engine emits `round.complete`; the dashboard's grid clears for the next round.

## Data model

```
runs       id, name, goal, status, config (JSON), createdAt
  │
  ├── rounds       id, runId, idx, goalMd, criteriaMd, criteriaSource,
  │                metaDigest, costUsd, status, judgeMode
  │     │
  │     ├── scores        id, roundId, agentId, score, rank, band, rationaleMd
  │     └── submissions   id, roundId, agentId, status, submissionMd,
  │                        fileManifestJson, tokensIn/Out/CacheRead/CacheWrite,
  │                        costUsd, durationMs
  │
  ├── agents       id, runId, label, parentAgentId, bornRound, status
  │     │
  │     └── genomes  id, agentId, roundIdx, modelId, temperature,
  │                  strategyMd, notesMd, origin, parentId
  │
  └── (config stored on the run row as JSON)
```

- **Agents are never deleted** — retire sets `status='retired'`; lineage is preserved for the drawer's lineage tree.
- **Genomes are append-only** — one per (agent, round); the latest is the agent's current strategy. `origin` tracks seed/elite/mutation/clone/crossover/manual.
- **Scores are per (round, agent)** — rank-ordered; `band` is top/middle/bottom.

## The sandbox abstraction

`src/runtime/sandbox.ts` defines the interface; three implementations:

- **MockSandbox** — in-memory, no real processes. Used by tests + mock mode.
- **Local** — agents are host opencode processes against one shared server (`src/runtime/opencode/`). Workspaces are subdirs under `workspaceRoot`.
- **Docker** — agents run in resource-capped containers (`src/runtime/docker/`), each running its own OpenCode server. Two isolation policies:
  - **protected** (dashboard default) — one agent per container, read-only root, unprivileged user, no credentials inside, and an internal-only network whose one exit is a gateway container. Model calls go through the host-side provider relay (`src/runtime/provider-relay.ts`), which swaps a per-run token for the real key and only allows roster models within a request limit.
  - **shared** — several agents may share a container, `auth.json` is bind-mounted read-only, and containers have ordinary network access.

  See the operator guide's isolation section for the full list of what each policy enforces.

The engine doesn't know which sandbox it's using — it calls `sandbox.run(handle, ...)` and `sandbox.readFile(handle, ...)`.

## Agent runners and subscriptions

An `AgentRunner` (`src/runtime/agent-runner.ts`) runs one agent attempt on a sandbox handle. Real runs compose a `DispatchingAgentRunner` (`src/runtime/dispatch.ts`) that routes each agent by its model: `claude-subscription/*` to `ClaudeCodeAgentRunner` (`src/runtime/claude-code/`), everything else to `OpenCodeAgentRunner`. Mixed rosters run side by side; round admission, abort and quiesce consult both.

- **ClaudeCodeAgentRunner** runs `claude -p` headless with streamed JSON in and out: in the agent's workspace as a host process (local), or through `docker exec` in the agent's shard as a recorded process group (docker). The GOAL is the first streamed message; the steering message and the optional `send(handle, text)` (the seam for live messages) follow at the agent's next step. `stream.ts` translates the CLI's stream into the same `agent.activity` items the OpenCode bridge emits, plus usage (cost always 0) and failures (`CLAUDE_AUTH_EXPIRED`, `SUBSCRIPTION_LIMIT`, `CLAUDE_CLI_MISSING`). Because its activity comes from stdout rather than an OpenCode server, a run exposes `ComposedRun.attachActivity`, which the API points at the same audit-and-cache sink as the OpenCode bridges.
- **Credentials**: a `claude setup-token` value in a 0600 file (`ClaudeTokenStore`), handed to the CLI on descriptor 3 locally or as a `docker exec` environment variable; or the host's own Claude login (local only). The CLI's environment is stripped of every `ANTHROPIC_*`/`CLAUDE*` variable first. `src/server/subscriptions.ts` holds these services and the status the dashboard shows.
- **Protected Claude agents** point `ANTHROPIC_BASE_URL` at the shard gateway and hold the run token as their OAuth token; the relay accepts only Claude Code's `/v1/messages` calls for roster models and swaps in the setup token.
- **ChatGPT Plus/Pro** stays on OpenCode: local and shared runs use OpenCode's own login in `auth.json`. In protected runs the relay carries that one OAuth login: `ChatGptLogin` (`src/runtime/chatgpt-oauth.ts`) re-reads `auth.json` per request, refreshes under a lock and writes the rotated pair back atomically, and the relay forwards to the Codex backend with the account headers, moving the system prompt into `instructions` as OpenCode does under OAuth.

Design and verified CLI facts: `docs/superpowers/specs/2026-11-15-subscription-runs-design.md`.

## The provider abstraction

`src/runtime/provider.ts` — `complete(prompt, opts)` returns the LLM response. Implementations:

- **MockProvider** — deterministic keyword-scoring, no LLM. Used by tests + mock mode.
- **OpenCodeProvider** — calls the opencode server's `/complete` endpoint (which proxies to the configured model).
- **ClaudeCodeProvider** (`src/runtime/claude-code/provider.ts`) — one `claude -p --output-format=json` per call on the Claude subscription, `--json-schema` when the caller has a schema.
- **RoutingProvider** (`src/runtime/dispatch.ts`) — what real runs use: `claude-subscription/*` calls to Claude Code, the rest to OpenCode. `describe(modelId)` names the runtime that graded, for the grading audit.

The Judge and Reflector take a `Provider` in their constructor; they don't know which one.

## The event bridge

The engine emits `EngineEvent`s (round.status, agent.status, agent.usage, round.scored, round.complete). The dashboard's `EventBroadcaster` (`src/server/event-bridge.ts`) forwards these to all WebSocket subscribers. The web client's `useLiveRun` hook dispatches them to a pure reducer (`liveReducer`) that updates the live state. The reducer is pure so it's unit-tested without a browser or socket.

## Config + reconfiguration

`RunConfig` (in `src/core/types.ts`) holds: roster, budget, judge, reflect, selection, concurrency, pricing, sandbox, container caps. `PATCH /api/runs/:id/config` merges a partial into the config and calls `engine.reconfigure()` between rounds — the next round reads the new config fresh. The budget tracker is updated in place (keeps accumulated spend). The busy guard ensures no round is in flight during a PATCH.

## SDD phase history

The codebase was built via subagent-driven development (SDD) in phases:

- **Phase 1** — core engine (driver, budget, selection, genomes).
- **Phase 2** — opencode integration (provider, client, server).
- **Phase 3** — docker sandbox.
- **Phase 4a** — dashboard run-spec + validator.
- **Phase 4b** — real modes, run setup, bridge lifecycle, PATCH reconfigure.
- **Phase 4c** — analytics views (agent drawer, analytics panel, stop-run).
- **Phase 4d** — between-rounds controls (criteria, population edits, cooperative abort, crossover, markdown, server kill).
- **Phase 4e** — startup recovery, model discovery, setup-time knobs, 4-key pricing.
- **Phase 4f** — smoke hardening (runner timer, env scrub, workspace mkdir, diversityFloor, session abort, LLM-recombine).
- **Phase 4g** — grader feedback (round-detail endpoint, roster builder, setup clarity, model pickers).
- **Phase 4h** — production hardening (responsive layout, pagination, ARIA, WS reconnect).
- **Phase 4i** — real-mode smoke (skipped — 4g+4h touched zero real-mode code; 4f green smoke stands).
- **Phase 4j** — new features (export JSON/CSV, run browser, run comparison, rejudge).
- **Phase 4k** — documentation (this file + operator guide + API reference + AGENTS.md).
- **Phase 8** — subscription runs: Claude Pro/Max through the Claude Code CLI, ChatGPT Plus/Pro through OpenCode's login, both relayed in protected mode.

Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`. The local SDD ledger (`.superpowers/sdd/<phase>/progress.md`) is gitignored.
