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
  "workflow": "collaboration",             // collaboration (default) | tournament; fixed for the run
  "roster": [{ "modelId": "mock/model", "count": 4, "temperature": 0.7 }],
  "judge": { "modelId": "judge/model", "mode": "auto" },        // optional
  "reflect": { "modelId": "reflect/model" },                     // optional
  "budget": { "maxRunTokens": 1000000, "maxRoundTokens": 200000, "maxAgentTokens": 50000 },
  "selection": { "crossoverPct": 0.2, "eliteCount": 2, "topPct": 0.3, "bottomPct": 0.2, "diversityFloor": true },
  "concurrency": 8,
  "pricing": { "model/id": { "inPerM": 1, "outPerM": 2, "cacheReadPerM": 0.1, "cacheWritePerM": 0.2 } }
}
```
- `201` `{ runId: string, warnings?: string[] }` — roster counts must sum to `populationSize` (derived from roster).
- Collaboration: `selection` is accepted and ignored, the one-container-per-agent rule does not apply (a team shares one protected container sized per agent), and docker with `isolation: "shared"` is refused. `PATCH /config` cannot change the workflow.
- `400` — validation error (zod message).
- `409` — capacity/competition error (docker sandbox, port in use).

### `GET /api/runs` — list runs

- `200` `{ runs: [{ id, name, createdAt, rounds, bestScore, costUsd }] }` — `rounds` = count, `bestScore` = max across rounds (null if 0 rounds), `costUsd` = sum of round costs.

### `GET /api/runs/:id` — run snapshot

- `200` `{ runId, name, workflow, lastRoundIdx, goalMd, agents: [...], scores: [...], sandbox, roster, capacity, warnings, busy, lastError }` — the live picture the dashboard renders. In a collaboration run every member's score is the team's.
- `404` — no such run.

### `PATCH /api/runs/:id/config` — reconfigure between rounds

Body: a partial of `{ roster, budget, judge, selection, concurrency, pricing }` — same shapes as the create spec, all optional. Takes effect from the NEXT round (the busy guard ensures no round is in flight).
- `200` `{ ok: true }`
- `400` — validation or roster-count mismatch.
- `404` / `409` (stopped / busy).

### `DELETE /api/runs/:id` — stop a run

- `202` `{ stopped: true }` — cooperative: queued agents stop, in-flight sessions finish.
- `404` / `409` (already stopped).

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

- `200` `[{ idx, meanScore, maxScore, minScore, costUsd, agentCount, modelShare: {...}, team }]` — per-round summary, completed rounds only (in-flight excluded). `team` is `{ score, status }` for a collaboration round and null for a tournament round.
- `404` — no such run.

### `GET /api/runs/:runId/rounds/:idx` — round detail

- `200` `{ idx, goalMd, criteriaMd, criteriaSource, metaDigest, costUsd, status, judgeMode, entries: [...], team }` — `entries` rank-ordered: `{ agentId, label, modelId, score, rank, band, rationaleMd, submission: {...}|null }`. Shows `judgeMode` only, never the judge model (PATCH can change it mid-run). `team` is `{ score, rationaleMd, status }` for a collaboration round (every entry mirrors it, rank 1, no band) and null otherwise.

### `GET /api/runs/:runId/rounds/:idx/output` — a collaboration round's sealed output

- `200` `{ roundId, runId, status, errorText, digest, sealed, hashesComplete, fileCount, totalBytes, files: [{ path, bytes, sha256, binary, stored }], contributions: { [agentId]: { label, files, posts, toolCalls } }, capturedAt }` — captured once after every member stopped. `status` is `ok`, `no_submission` (empty `output/`) or `error` (over the team quota). `contributions` lists what each member's own activity showed it writing, and its channel posts.
- `404` — no such run / round, or the round has no team output (a tournament round, or not captured yet).

### `GET /api/runs/:runId/rounds/:idx/output/file?path=output/README.md` — one sealed file

- `200` `{ path, bytes, sha256, binary, stored, content }` — the text exactly as captured; `content` is null for binary files and for files too large to store (256 KiB per file, 8 MiB per round).
- `400` — no `path`. `404` — the path is not in the round's sealed output.

### `GET /api/runs/:runId/rounds/:idx/channel` — a collaboration round's channel

- `200` `{ messages: [{ roundId, seq, author, agentId, target, postedAt, body, deliveredTo, observedAt }] }` — the `CHANNEL.md` entries first seen in this round, in file order; `deliveredTo` lists the agents each was forwarded to. Entries from earlier rounds belong to those rounds.
- `404` — no such run / no such round.

### `POST /api/runs/:runId/rounds/:idx/criteria` — override criteria for a round

Body: `{ criteriaMd: string }`.
- `200` `{ ok: true }`
- `409` — round already scored (criteria can't change after judging).

### `POST /api/runs/:runId/rounds/:idx/abort` — abort the in-flight round

- `202` `{ aborted: true }` — cooperative: queued agents stop, in-flight finish their current call.
- `404` / `409` (not in flight).

### `POST /api/runs/:runId/rounds/:idx/rejudge` — re-score with a different judge (non-destructive)

Body: `{ judgeModelId: string }`. Re-runs the judge on the round's existing submissions with the requested model. Returns the old-vs-new comparison. **No DB write** — the stored scores are unchanged. A collaboration round regrades its sealed output folder (never the live one) and returns one entry per member, each with the new team score at rank 1.
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

- `json` → `application/json` — full dump: `{ run, config, rounds: [{...round, entries: [...], audit, judging, team}], agents, genomes }`. `team` is null for tournament rounds; for collaboration rounds it is `{ score, output, channel }`: the team score, the sealed output manifest with its seal and contributions (as `/output` returns it), and the round's channel entries.
- `csv` → `text/csv` — flat table, one row per (round × agent): `round,agentLabel,modelId,score,rank,band,tokensIn,tokensOut,costUsd,submissionStatus`. `\r\n` line endings.
- `Content-Disposition: attachment; filename="run-{id}.{ext}"`.
- `400` — unknown format.
- `404` — no such run.

## WebSocket `/ws`

Live events pushed to the dashboard (one JSON message per event):
- `round.status` `{ runId, roundIdx, status }` — `preparing`/`running`/`judging`/`scoring`/`complete`.
- `agent.status` `{ runId, agentId, status }` — `pending`/`running`/`done`/`failed`.
- `agent.activity` `{ runId, agentId, detail }` — current activity text.
- `agent.usage` `{ runId, agentId, tokensIn, tokensOut, costUsd }` — incremental usage.
- `round.scored` `{ runId, roundIdx, scores: [...], team? }` — rank-ordered scores; collaboration rounds add `team: { score, status }`.
- `channel.message` `{ runId, roundIdx, seq, author, agentId, target, postedAt, body }` — a new team-channel entry the moment the engine reads it (body cut at 4,000 characters; the channel endpoint has it whole).
- `round.complete` `{ runId, roundIdx, budgetBreach }` — round finished.

The client reconnects with exponential backoff (1s → 2s → 4s → ... → 30s cap) on disconnect.
