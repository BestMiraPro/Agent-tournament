# Architecture

Agent Tournament runs LLM agents through repeated rounds with an LLM judge and a live dashboard, in one of two workflows fixed per run (`RunConfig.workflow`):

- **collaboration** (default): the round's agents are one team in one shared workspace that carries over between rounds. They talk through `CHANNEL.md` and co-write `output/`, which is captured once, sealed and judged as one artifact. No selection or breeding; each agent's strategy is reflected from the team's result.
- **tournament**: agents compete individually with evolutionary selection and a blind judge.

This doc describes how the pieces fit.

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

`runRound` shares its preflight (budget tracker, active population, prior execution reconciled, placement and capacity, abort check), the round row, criteria and failure handling between the workflows, then branches after genomes are resolved. The tournament round, end to end:

1. **Start** — `POST /api/runs/:id/rounds` (or the CLI loop) calls `engine.runRound(runId, { goalMd, criteriaMd })`.
2. **Prepare** — the engine creates a round row, resolves each agent's genome (seed/elite/clone/mutation/crossover), and writes `GOAL.md` + `STRATEGY.md` into each agent's workspace.
3. **Run** — the pool (`src/runtime/pool.ts`) runs agents in parallel (bounded by `concurrency`). Each agent is a sandboxed opencode session that reads its strategy and writes a `SUBMISSION.md`. The budget tracker (`src/engine/budget.ts`) tallies tokens/cost per agent/round/run and fails over-budget agents.
4. **Capture** — `src/engine/capture.ts` reads each `SUBMISSION.md` + file manifest the moment its agent stops, then re-verifies it once no agent in the round is still running; a change in between is recorded as tampering and the captured copy is what gets judged. Stores a `submissions` row.
5. **Judge** — the evidence audit (`src/engine/audit.ts`) is frozen and sealed with a digest first, so the grader sees a fixed evidence set. Then `src/judge/judge.ts` scores the submissions against the goal + criteria (auto-generates criteria if none given). Mode: `single_call` (one prompt, all submissions) or `batched_finals` (pairwise finals). Submissions are anonymised and shuffled per round. Stores `scores` rows (rank, score, band, rationale) and a grading audit per score (`src/judge/audit.ts`).
6. **Select** — `src/core/selection.ts` ranks agents; the top band clones, the bottom band is culled, elites are kept verbatim, crossover (4d) breeds children. The `diversityFloor` (4f) rescues the most distinct culled agent.
7. **Reflect** — `src/evolution/reflect.ts` rewrites each survivor's strategy for the next round (the mutation operator). LLM-recombine (4f) merges two parent strategies with a split-merge fallback.
8. **Complete** — the round row is marked ended; the engine emits `round.complete`; the dashboard's grid clears for the next round.

### A collaboration round

`src/engine/collaboration.ts`, after the shared preflight (a sandbox without `provisionTeam` is refused there, before the round row exists):

1. **Prepare** — `sandbox.provisionTeam(runId, agentIds)` returns one handle per agent onto the run's single shared workspace (`team-<runId>`; `/work` in its one Docker container), created and seeded on first use and kept across rounds. The engine writes `GOAL.md`, the channel helper (`.opencode/arena/post.mjs`), each member's OpenCode profile (`.opencode/agents/member-<label>.md`) and notes (`agents/<label>/NOTES.md`), and a `## Round N` line in `CHANNEL.md`. Strategies still travel in each prompt's `system` field.
2. **Run** — every agent is dispatched at once with `AgentRunContext.team` (label, teammates, post command); the runner builds the team prompt (`src/runtime/team-prompt.ts`). `ChannelTail` (`src/engine/channel.ts`) reads `CHANNEL.md` every 2 s, records each new entry (`channel_messages`, `channel.message` event) and queues it into the other live agents' sessions through the optional `AgentRunner.send` (OpenCode: `prompt_async`, the steering path), with per-entry, per-message, per-gap and per-round caps. Budget gate, timeout and quiesce are the tournament's (`runAgentAttempt` is shared).
3. **Barrier and capture** — after the pool drains and every agent is quiesced, a last channel read records what is left and `captureTeamOutput` (`src/engine/team-capture.ts`) captures `output/` and `CHANNEL.md` once: hashes within the team budget (one agent's workspace caps per member), stored text (bounded), binary files listed, one digest. `sealed` = every dispatched agent confirmed stopped. Stored in `round_outputs` / `round_output_files`.
4. **Freeze** — each member gets a `submission.captured` event carrying the team seal, the audit is frozen, and per-member contributions (files from write/edit/patch activity, tool calls, channel posts) are stored with the snapshot. Workers are released.
5. **Judge** — `Judge.scoreTeam` grades the one artifact (no shuffle: nothing to compare). Local and Docker compositions copy the sealed text under the grader's own folder (`.arena-grader/sealed/<roundId>/output`, via `ComposedRun.sealedArtifacts`) so its read-only tools can open it; mock inlines it. Members' activity is shown as `M1`, `M2`, … and cited evidence is checked against it. One envelope as usual, each member's entry holding the team assessment and the safety findings that cite it. An empty or over-quota output is not judged and scores 0, with members' behaviour still reviewed.
6. **Score** — one row in `team_scores`, mirrored into each member's `scores` row (rank 1, no band).
7. **Reflect** — no selection, breeding or retirement. Unless the budget was breached, `Reflector.reflectTeam` rewrites each strategy from the team score, the judge's rationale and digest, and the member's own posts and contributions; next-round genomes are `mutation` (rewritten) or `clone` (carried forward).

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
  │     ├── round_outputs       roundId, status, digest, sealed, hashesComplete, manifest,
  │     │                       channelMd, contributions          (collaboration: sealed output/)
  │     ├── round_output_files  roundId, path, content            (its stored text)
  │     ├── team_scores         roundId, score, rationaleMd, status (one team score)
  │     └── channel_messages    roundId, seq, author, agentId, target, postedAt, body, delivered
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
- **Scores are per (round, agent)** — rank-ordered; `band` is top/middle/bottom. In a collaboration round every member's row repeats the team score (rank 1, no band); `team_scores` is the record.
- **New tables are created on open** — `CREATE TABLE IF NOT EXISTS` adds the collaboration tables to an older database, and a stored config without `workflow` decodes as `tournament`.

## The sandbox abstraction

`src/runtime/sandbox.ts` defines the interface; three implementations:

- **MockSandbox** — in-memory, no real processes. Used by tests + mock mode.
- **Local** — agents are host opencode processes against one shared server (`src/runtime/opencode/`). Workspaces are subdirs under `workspaceRoot`.
- **Docker** — agents run in resource-capped containers (`src/runtime/docker/`), each running its own OpenCode server. Two isolation policies:
  - **protected** (dashboard default) — one agent per container, read-only root, unprivileged user, no credentials inside, and an internal-only network whose one exit is a gateway container with three fixed routes. Model calls go through the host-side provider relay (`src/runtime/provider-relay.ts`), which swaps a per-run token for the real key and only allows roster models within a request limit. Connector tool calls go through the host tool bridge (below).
  - **shared** — several agents may share a container, `auth.json` is bind-mounted read-only, and containers have ordinary network access.

  See the operator guide's isolation section for the full list of what each policy enforces.

Collaboration adds one optional method, `provisionTeam(teamId, agentIds, opts)`: one shared workspace per run, seeded once and kept across rounds. MockSandbox keeps it in memory for the life of the sandbox, LocalSandbox uses `<root>/team-<runId>`, and DockerSandbox (composed with `team: true`) places the whole team on one container with the folder at `/work`, always with the protected runtime and with memory, CPUs, PIDs and open files scaled per member (`teamContainerLimits`); the capacity preflight admits it as one container of that size plus its gateway.

The engine doesn't know which sandbox it's using — it calls `sandbox.run(handle, ...)` and `sandbox.readFile(handle, ...)`.

## Connectors and the tool bridge

`src/connectors/` gives agents MCP tools from GitHub, Slack, Gmail, imported Claude Code servers and built-in servers, without giving them credentials.

- **Registry** (`store.ts`, `types.ts`): connectors in `connectors.json`, credentials in an owner-only `secrets.json`, both in `--connectors-dir`. Never in SQLite.
- **Policy** (`policy.ts`, `presets.ts`): which tools an agent may list and call. Slack and Gmail are locked to a code-defined read allowlist; others expose tools annotated read-only, plus write tools the connector permits and the run opts into.
- **Upstreams** (`upstream.ts`, `resolve.ts`): the MCP SDK client over stdio, Streamable HTTP/SSE or an in-memory transport (the in-house Slack and Gmail servers in `slack/` and `gmail/`, and built-ins registered with `registerBuiltinConnector`, `builtins.ts`).
- **Bridge** (`bridge.ts`, `bridge-server.ts`, `bridge-process.ts`): one Streamable HTTP MCP endpoint per process at `/mcp/<connector>`, started on first use like the relay. A run's grant (`run-plan.ts`, made in `compose-run.ts`) opens its upstreams, lists their tools and mints one token per agent. Every `tools/call` is checked against the policy, the per-agent call limit, a timeout and a result cap, and emits an `agent.connector` event: the audit collector stores it as `tool_bridge` evidence, the activity cache shows it as a tool item. Revoked first when the run stops.
- **Reaching it**: `grant.endpointsFor(agentId, baseUrl)` returns `{ id, title, url, headers }` per connector, runner-agnostic. The OpenCode runner writes it to `.opencode/opencode.json` in the agent's workspace (`runtime/opencode/mcp-config.ts`) right before the session; the competitor profile allows `"<id>_*"`; TOOLS.md lists the tools. Protected workers use the gateway's tools route (`GATEWAY_TOOLS_PORT`, 8788).
- **API and UI**: `src/server/connectors-api.ts` (presets, Claude Code import from `claude-import.ts`, connection tests, Google and MCP OAuth with the callback on the dashboard's own origin) and `web/src/components/Connectors.tsx`.

Design: `docs/superpowers/specs/2026-11-15-connectors-design.md`.

## The provider abstraction

`src/runtime/provider.ts` — `complete(prompt, opts)` returns the LLM response. Two implementations:

- **MockProvider** — deterministic keyword-scoring, no LLM. Used by tests + mock mode.
- **OpenCodeProvider** — calls the opencode server's `/complete` endpoint (which proxies to the configured model).

The Judge and Reflector take a `Provider` in their constructor; they don't know which one.

## The event bridge

The engine emits `EngineEvent`s (round.status, agent.status, agent.usage, round.scored, round.complete, and for collaboration channel.message and the team score on round.scored). The dashboard's `EventBroadcaster` (`src/server/event-bridge.ts`) forwards these to all WebSocket subscribers. The web client's `useLiveRun` hook dispatches them to a pure reducer (`liveReducer`) that updates the live state. The reducer is pure so it's unit-tested without a browser or socket.

## Config + reconfiguration

`RunConfig` (in `src/core/types.ts`) holds: roster, budget, judge, reflect, selection, concurrency, pricing, sandbox, container caps, and the run's connectors (ids and write opt-ins only; fixed at creation). `PATCH /api/runs/:id/config` merges a partial into the config and calls `engine.reconfigure()` between rounds — the next round reads the new config fresh. The budget tracker is updated in place (keeps accumulated spend). The busy guard ensures no round is in flight during a PATCH.

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
- **Phase 8** — collaboration workflow (shared team workspace, channel, sealed team output, team judging), now the default; see `docs/superpowers/specs/2026-11-15-collaboration-mode-design.md`.

Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`. The local SDD ledger (`.superpowers/sdd/<phase>/progress.md`) is gitignored.
