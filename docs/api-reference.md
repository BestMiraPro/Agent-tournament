# API Reference

The dashboard API is a Fastify server on `http://127.0.0.1:4300` (WebSocket on `/ws`). All endpoints return JSON; errors are `{ error: string }` with the status code below.

## Runs

### `POST /api/runs` — create a run

Body (the full run spec; all fields except `name`+`goal`+`roster` are optional with defaults):
```json
{
  "name": "my-tournament",
  "goal": "Produce the best possible answer.",
  "sandbox": "mock",                       // mock | local | docker
  "roster": [{ "modelId": "mock/model", "count": 4, "temperature": 0.7 }],
  "judge": { "modelId": "judge/model", "mode": "auto" },        // optional
  "reflect": { "modelId": "reflect/model" },                     // optional
  "budget": { "maxRunTokens": 1000000, "maxRoundTokens": 200000, "maxAgentTokens": 50000 },
  "selection": { "crossoverPct": 0.2, "eliteCount": 2, "topPct": 0.3, "bottomPct": 0.2, "diversityFloor": true },
  "concurrency": 8,
  "pricing": { "model/id": { "inPerM": 1, "outPerM": 2, "cacheReadPerM": 0.1, "cacheWritePerM": 0.2 } },
  "connectors": [{ "id": "github", "writeTools": [] }]  // local/docker only; see Connectors
}
```
- `201` `{ runId: string, warnings?: string[] }` — roster counts must sum to `populationSize` (derived from roster).
- `400` — validation error (zod message).
- `409` — capacity/competition error (docker sandbox, port in use).

### `GET /api/runs` — list runs

- `200` `{ runs: [{ id, name, createdAt, rounds, bestScore, costUsd }] }` — `rounds` = count, `bestScore` = max across rounds (null if 0 rounds), `costUsd` = sum of round costs.

### `GET /api/runs/:id` — run snapshot

- `200` `{ runId, name, lastRoundIdx, goalMd, agents: [...], scores: [...], sandbox, roster, capacity, warnings, busy, lastError }` — the live picture the dashboard renders.
- `404` — no such run.

### `PATCH /api/runs/:id/config` — reconfigure between rounds

Body: a partial of `{ roster, budget, judge, selection, concurrency, pricing }` — same shapes as the create spec, all optional. Takes effect from the NEXT round (the busy guard ensures no round is in flight).
- `200` `{ ok: true }`
- `400` — validation or roster-count mismatch.
- `404` / `409` (stopped / busy).

### `DELETE /api/runs/:id` — stop a run

- `202` `{ stopped: true }` — cooperative: queued agents stop, in-flight sessions finish.
- `404` / `409` (already stopped).

## Connectors

Connectors and their credentials live in the dashboard's connector store (`--connectors-dir`). No response ever contains a credential value: views list which secrets are set (`secretsSet`), never what they are.

### `GET /api/connectors` — list

- `200` `{ store: boolean, connectors: ConnectorView[], builtins: [{ id, title, description, builtin: true, readOnly: true }] }`.
- `ConnectorView`: `{ id, title, kind: github|slack|gmail|custom, origin, transport (command/args/env names or URL/header names), auth, secretsSet, connected, locked, readAllowlist, policy: { disabledTools, writeTools }, tools: [{ name, description, readOnlyHint, classification: read|write|locked }] | null, toolsCheckedAt }`.

### `POST /api/connectors` — add from a preset

Body, one of:
```json
{ "preset": "github", "id": "github", "mode": "remote", "tokenSource": "manual", "token": "github_pat_…" }   // mode: remote|local; tokenSource: manual|gh-cli
{ "preset": "slack", "token": "xoxp-…" }
{ "preset": "gmail", "clientId": "….apps.googleusercontent.com", "clientSecret": "…" }
{ "preset": "remote", "id": "my-server", "url": "https://…/mcp", "headers": {}, "bearerToken": "…" }   // no token: MCP OAuth
{ "preset": "local", "id": "my-tool", "command": "npx", "args": ["-y", "some-mcp-server"], "env": {} }
```
- `201` `{ connector: ConnectorView }` · `400` invalid, duplicate or reserved id (a built-in's id, `external`, `doom`, `apply`) · `409` no store.

### `PATCH /api/connectors/:id` — change

Body: `{ title?, policy?: { disabledTools?, writeTools? }, token?, clientId?, clientSecret? }`. `writeTools` on Slack or Gmail is refused (`400`): they are read-only.

### `DELETE /api/connectors/:id` — remove it and its credentials

### `POST /api/connectors/:id/test` — connect and list tools

Opens the server with its credentials, lists its tools, stores the list (names, descriptions, read-only hints) and returns `{ connector }` (built-ins: `{ tools }`). `409` when it needs a sign-in, `502` when it cannot connect (redacted message).

### `GET /api/connectors/import` · `POST /api/connectors/import`

`GET` lists the MCP servers configured for Claude Code on this machine, read-only, credentials masked: `{ servers: [{ key, name, source, from, transport, suggestedId, imported }] }`. `POST { key, id? }` imports one (`201 { connector }`).

### `POST /api/connectors/:id/oauth/start` — begin a sign-in

Gmail (Google, PKCE, `gmail.readonly`) or a remote server using MCP OAuth (discovery, dynamic client registration, PKCE). Returns `{ authorizationUrl }` to open in the browser, or `{ connected: true }`. The request's `Host` must be a loopback name (`400` otherwise).

### `GET /api/connectors/oauth/callback` — where the provider sends the browser back

Completes the sign-in for a pending `state` (single use, 10 minutes) and answers with a short HTML page.

## Models

### `GET /api/models` — discover available models

Spawns an opencode server (60s success-only cache) to discover models.
- `200` `{ models: string[] }`
- `502` — opencode server failed to start.

## Rounds

### `POST /api/runs/:id/rounds` — start the next round

Body: `{ goalMd: string, criteriaMd?: string | null }` — `goalMd` is required; `criteriaMd` overrides the auto-generated criteria (null = auto-generate).
- `202` `{ started: true }`
- `400` — missing `goalMd`.
- `404` / `409` (stopped / busy).

### `GET /api/runs/:runId/rounds` — round stats

- `200` `[{ idx, meanScore, maxScore, minScore, costUsd, agentCount, modelShare: {...} }]` — per-round summary, completed rounds only (in-flight excluded).
- `404` — no such run.

### `GET /api/runs/:runId/rounds/:idx` — round detail

- `200` `{ idx, goalMd, criteriaMd, criteriaSource, metaDigest, costUsd, status, judgeMode, entries: [...] }` — `entries` rank-ordered: `{ agentId, label, modelId, score, rank, band, rationaleMd, submission: {...}|null }`. Shows `judgeMode` only, never the judge model (PATCH can change it mid-run).
- `404` — no such run / no such round.

### `POST /api/runs/:runId/rounds/:idx/criteria` — override criteria for a round

Body: `{ criteriaMd: string }`.
- `200` `{ ok: true }`
- `409` — round already scored (criteria can't change after judging).

### `POST /api/runs/:runId/rounds/:idx/abort` — abort the in-flight round

- `202` `{ aborted: true }` — cooperative: queued agents stop, in-flight finish their current call.
- `404` / `409` (not in flight).

### `POST /api/runs/:runId/rounds/:idx/rejudge` — re-score with a different judge (non-destructive)

Body: `{ judgeModelId: string }`. Re-runs the judge on the round's existing submissions with the requested model. Returns the old-vs-new comparison. **No DB write** — the stored scores are unchanged.
- `200` `{ entries: [{ agentId, label, oldScore, oldRank, newScore, newRank, newRationaleMd, rankChanged }], metaDigest, mode }`
- `404` / `409` (not complete / busy / no live provider).

## Agents

### `GET /api/runs/:runId/agents/:agentId` — agent detail

- `200` `{ agent, lineage: [...], genomes: [...], history: [{ roundIdx, score, rank, band, rationaleMd, submission: {...}|null }] }`
- `404` — no such run / agent.

### `POST /api/runs/:runId/agents` — add an agent

Body: `{ modelId, temperature, strategy: { mode: "blank" | "pasted" | "clone", ... } }`. Clone takes `agentId` of the source; pasted takes `strategyMd`.
- `200` `{ agentId: string }`
- `400` — clone source has no genome / pricing missing for a USD-capped run.
- `404` / `409` (stopped / busy / no such clone source).

### `DELETE /api/runs/:runId/agents/:agentId` — retire an agent

Retires (does not delete — lineage is preserved). Fails if it would empty the population.
- `200` `{ ok: true }`
- `409` — would leave zero active agents.

## Export

### `GET /api/runs/:runId/export?format=json|csv|md` — export a run

- `md` → `text/markdown` — report: goal, leaderboard by round, the last scored round's winner with its strategy lineage, strategy, judge's rationale and submission.

- `json` → `application/json` — full dump: `{ run, config, rounds: [{...round, entries: [...]}], agents, genomes }`.
- `csv` → `text/csv` — flat table, one row per (round × agent): `round,agentLabel,modelId,score,rank,band,tokensIn,tokensOut,costUsd,submissionStatus`. `\r\n` line endings.
- `Content-Disposition: attachment; filename="run-{id}.{ext}"`.
- `400` — unknown format.
- `404` — no such run.

## WebSocket `/ws`

Live events pushed to the dashboard (one JSON message per event):
- `round.status` `{ runId, roundIdx, status }` — `preparing`/`running`/`judging`/`scoring`/`complete`.
- `agent.status` `{ runId, agentId, status }` — `pending`/`running`/`done`/`failed`.
- `agent.activity` `{ runId, agentId, detail }` — current activity text. Connector calls arrive here too, as tool items with ids `connector:<callId>`.
- `agent.usage` `{ runId, agentId, tokensIn, tokensOut, costUsd }` — incremental usage.
- `round.scored` `{ runId, roundIdx, scores: [...] }` — rank-ordered scores.
- `round.complete` `{ runId, roundIdx, budgetBreach }` — round finished.

The client reconnects with exponential backoff (1s → 2s → 4s → ... → 30s cap) on disconnect.
