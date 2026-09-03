# Phase 4c — Analytics views (agent drawer + run analytics)

Status: approved for planning
Supersedes nothing. Completes design spec §14 "Agent detail drawer" + "Analytics", and
ships the run-stop endpoint deferred from the Phase 4b final review.

## 1. Goal and non-goals

Give the dashboard the read-side it is missing: per-agent history/lineage/submission
detail, and run-level analytics (fitness trend, model share, strategy diversity,
lineage tree). Plus a way to stop a run from the dashboard.

In scope:
- 2 new read-only API endpoints (agent detail, round stats)
- 1 new write endpoint: `DELETE /api/runs/:id` (stop a run — deferred from 4b review #8)
- 2 new pure functions (`strategyDiversity`, `lineDiff`) with unit tests
- Web: agent detail drawer, analytics panel, stop button
- Tests + gate

Out of scope (stay out):
- Any engine / runtime / CLI / schema change. All required data is already persisted.
- Markdown rendering (plain `<pre>` for strategy/notes/submission/rationale text).
- Design §13 `POST/DELETE /api/runs/:id/agents` (add/retire agent), criteria-override
  and round-abort endpoints, meta_digest display — separate follow-up.
- `startServer` orphan-on-timeout kill (pre-existing follow-up ticket from 4b review #13).
- Crossover and other design §20 polish items — later phase.

## 2. Verified facts (state of the world, 2026-09-03)

- All data the views need is persisted (schema.ts):
  - `agents`: parent_agent_id, born_round, died_round, status (`active|retired|culled`)
  - `genomes` per (agent_id, round_idx): strategy_md, notes_md, model_id, temperature, origin
  - `submissions` per (round_id, agent_id): submission_md, file_manifest_json, status
    (`ok|timeout|error|no_submission`), error_text, tokens_in/out/cache_read/cache_write,
    cost_usd, duration_ms
  - `scores` per (round_id, agent_id): rank, score, rationale_md, band
  - `rounds`: idx, goal_md, criteria_md, meta_digest, cost_usd, status
    (`pending|preparing|running|collecting|judging|evolving|reflecting|complete|failed`)
- The snapshot (state.ts) already carries every active agent with `parentAgentId` — the
  lineage tree is derivable client-side from the snapshot; no endpoint needed for it.
  (Dead agents are NOT in the snapshot — `listActive` only — so the drawer's lineage walk
  needs the full agent list from the agent-detail endpoint, which serves all agents.)
- Web is a root-package vite React app; no chart or diff libraries exist (root
  package.json). Ladder ruling: hand-roll the two small pure functions; **no new
  dependencies**.
- Test layout: flat root vitest suite (56 files) + e2e; 4b's web roster parser was
  unit-tested from the root suite — web pure helpers live in plain `.ts` files and are
  imported the same way.
- `buildApi` has a legacy 3-arg path and a 5-arg path (registry, broadcaster, ...);
  new routes hang off the same `app` and are therefore available on both.

## 3. API

### 3.1 `GET /api/runs/:runId/agents/:agentId`

404 `{ error }` when the run or agent is missing (mirror the existing
`GET /api/runs/:id` 404 shape).

```
{
  agent:   { agentId, label, bornRound, diedRound: number|null, status, parentAgentId: string|null },
  lineage: [ { agentId, label, bornRound } ],          // self → parent → … → seed
  genomes: [ { roundIdx, strategyMd, notesMd, modelId, temperature, origin } ],  // asc
  history: [ {                                          // one entry per scored round, asc
    roundIdx, score, rank, band, rationaleMd,
    submission: { status, errorText: string|null, submissionMd: string|null,
                  fileManifest: unknown|null, costUsd, durationMs: number|null,
                  tokens: { in, out, cacheRead, cacheWrite } } | null
  } ]
}
```

Rules:
- `lineage` walks `parent_agent_id` to the root. Max depth = number of agents in the
  run (cycle guard; data is written once, the guard is cheap insurance).
- `genomes` = every genome row for the agent, ascending `round_idx` (repo getter, new).
- `history` = rounds that have a score row for this agent, ascending; the submission
  entry is null when the agent has no submission row for that round.
- Repo additions (minimal, existing style): `agents.listAll(runId)`,
  `agents.get(agentId)`, `genomes.forAgent(agentId)`, `scores.forAgent(roundIds[], agentId)`
  (or per-round loop using the existing `scores.forRound` — implementer's call, keep it
  one query where natural), `submissions.forAgent(roundId, agentId)`.

### 3.2 `GET /api/runs/:runId/rounds`

404 as above. One entry per round that has score rows, ascending `idx`:

```
{ idx, goalMd, costUsd,
  fitness:  { mean, min, max },
  modelShare: [ { modelId, count } ],   // genome active in that round per agent that had one
  diversity: number }                   // strategyDiversity over those strategies
```

Rules:
- Rounds without scores (in-flight, failed before judging) are excluded — the chart is
  "completed rounds" only.
- `fitness` over that round's score rows (mean/min/max; one entry when one agent).
- `modelShare` counts `model_id` of the genome at `round_idx = idx` for each agent that
  has one (agents born later simply don't appear until their first genome round; agents
  culled after the round do appear — the genome row is the record of that round).
- `diversity` = `strategyDiversity(strategies)` — see §4.
- `goalMd` is included per round so the client can segment the chart at goal changes
  (design: "the fitness chart segments at goal changes rather than drawing a continuous
  line"). No server-computed flag — the client compares consecutive goalMd values.

### 3.3 `DELETE /api/runs/:id` (stop a run — 4b deferred #8)

- 404 `{ error }` when the db row does not exist.
- 409 `{ error }` when the run is not in the registry (legacy/3-arg server run):
  "run is not stoppable (created outside the dashboard)". The global manager is shared
  by all legacy runs — disposing it would kill them all, so legacy runs keep their
  old lifecycle.
- Otherwise: call the existing `disposeRunRecord` (bridges → manager.disposeAll →
  cleanup, order pinned in 4b), set `runs.status = 'stopped'` (db-backed stop marker —
  the field is a loose string, no type/migration change; grep confirms no other
  consumer of `runs.status`), then remove the registry entry. Never throws out of the
  handler. 200 `{ stopped: true }`.
- Consequence, pinned: `POST /api/runs/:id/rounds` and `PATCH /api/runs/:id/config`
  early-return 409 `'run is stopped'` when `run.status === 'stopped'` (checked right
  after the existing 404 row check — works for registry and legacy alike).
- After a stop, `GET /api/runs/:id` keeps working (snapshot is db-backed; the run row
  remains). `GET /api/runs/:id/rounds` and the agent-detail endpoint keep working too
  (pure db reads).
- Web: "Stop run" button (danger style) on the arena header, `window.confirm` (it
  kills in-flight work), always rendered — the server answer is the truth: 200 →
  "run stopped" note; 404/409 → show the server's error message inline. No
  client-side capability detection.

## 4. Pure functions

### 4.1 `strategyDiversity(strategies: string[]): number` (server, `src/core/analytics.ts`)

Mean pairwise **1 − Jaccard distance** over word sets:
tokenize on whitespace, drop empty, case-insensitive; for each unordered pair
(i<j) compute `1 − |A∩B| / |A∪B|` (pair where both sets are empty counts as 1 —
identical); average over all pairs.
- n < 2 → 0 (no pairs, no diversity signal — documented, not an error).
- 0 = all strategies identical, 1 = all pairwise disjoint.
- `ponytail:` comment: naive O(n²·w) word-set Jaccard; ceiling ≈ 100 agents × ~300
  words ≈ 3M set ops per round — fine; upgrade path: min-hash if population or
  strategy length grows an order of magnitude.

### 4.2 `lineDiff(a: string, b: string): DiffLine[]` (web, `web/src/lib/diff.ts`)

LCS-based line diff. `DiffLine = { kind: 'same' | 'add' | 'del', text: string }`.
- Split on `\n`, LCS over lines (dynamic programming), emit in order.
- `ponytail:` comment: O(lenA·lenB) DP; strategies are capped (strategy cap exists) and
  diffs render in one drawer — ceiling: a few thousand lines; upgrade path:
  Myers/patience only if that ever hurts.
- No new dependencies; testable from the root suite (plain `.ts`).

## 5. Web

### 5.1 Agent detail drawer

- `AgentGrid` cells become clickable (`onSelect(agentId)`); `App` holds
  `selectedAgentId` and renders `<AgentDrawer runId agentId onClose>` as a right panel.
- Fetch `getAgentDetail(runId, agentId)` (new `web/src/api.ts` function) on select;
  loading + error states (error shows the message, drawer stays open).
- Sections (scrollable, stacked, `<pre>` for all markdown-ish text):
  1. Header: label, model badge + temperature, born round, status, close ✕.
  2. Score history: table `round → rank / score / band` (asc); also a one-line
     "best rank" summary.
  3. Strategy: current (last genome) in full; below it "vs previous round" via
     `lineDiff(previous.strategyMd, current.strategyMd)` rendered as −/+/= lines
     (skip the section when the agent has < 2 genomes).
  4. Notes: `lineDiff(previous.notesMd, current.notesMd)` (same renderer).
  5. Latest submission: status badge, cost, duration, error (when any);
     `submissionMd` in full; file manifest as a plain list (parse the JSON if present).
  6. Latest judge rationale (last `history` entry's `rationaleMd`).
  7. Lineage path: `seed → … → self` breadcrumb of labels (each with born round),
     from the endpoint's `lineage` (reversed for display).
- Close: ✕, Esc, backdrop click. Selecting another cell refetches.

### 5.2 Analytics panel (below arena, always rendered once ≥ 1 completed round)

- Fetch `getRoundStats(runId)` on mount and after each `round.scored`/snapshot refresh
  (piggyback the existing useLiveRun refresh trigger — no new polling loop).
- **Fitness over time** — hand-rolled SVG line chart: x = round idx, y = score;
  three polylines (mean, max, min) or mean + min/max band (implementer's call,
  visually distinguishable); the line **breaks** (segment ends) wherever
  `goalMd` changed between consecutive entries; axis ticks for round idx and a couple
  of score values; legend. No chart library.
- **Per-round table**: `idx | mean | min | max | diversity | model share cells` —
  model share columns = union of models across rounds, cell = count (title tooltip
  with % of that round's agents).
- **Lineage tree** — nested `<ul>` built client-side from the snapshot's agents
  (`parentAgentId`), seeds as roots; each name is a button that opens the drawer.
  (Snapshot only → active agents; dead agents appear in the drawer's lineage but not
  as tree nodes. Documented limitation, not a bug: dead agents keep their row in db.)

### 5.3 Stop button

Arena header: "Stop run" (danger style) → `window.confirm` → `deleteRun(runId)`
(new `web/src/api.ts` function) → disabled while in flight. Success → one-line
"run stopped" note and the button hides; 404/409 → inline error message from the
server. Always rendered (see §3.3 — the server is the authority on stoppability).

## 6. Constraints and rulings

- **No new dependencies** (root or web). No engine/runtime/CLI/schema/migration change.
- New routes are read-only (DELETE excepted) and never touch round/busy state.
- 404/400 shapes mirror existing endpoints; no new error taxonomy.
- `strategyDiversity` lives server-side (`src/core/`) because the endpoint computes it;
  `lineDiff` lives web-side. Both pure, both unit-tested from the root suite.
- Repo getters are additive; existing getters untouched.
- The 3-arg legacy `buildApi` path gets the new routes for free (same `app`) — no
  special-casing, no extra tests beyond the standard inject tests.
- Drawer text is `<pre>`: markdown rendering is explicitly deferred (see §1).

## 7. Testing

- **Unit (root suite):**
  - `strategyDiversity`: identical set → 0; fully disjoint → 1; n<2 → 0; empty
    strings pair → counts as identical (1); mixed case/whitespace tokenization.
  - `lineDiff`: identical → all `same`; pure additions; pure deletions; modified line
    → del+add; empty a/b; single-line case.
  - Goal-change segmentation helper (if extracted client-side as a pure fn — expected:
    yes, `goalChangedFlags(rounds)` in `web/src/lib/`, one test).
- **API (fastify inject + in-memory repos, seeded multi-round db — mirror
  state.test.ts / api.test.ts patterns):**
  - agent-detail 200: lineage order self→seed (3-deep), genomes asc, history joins
    score+submission, submission null where absent; 404 run, 404 agent.
  - round-stats 200: fitness math (mean/min/max) on a seeded 3-round run, modelShare
    counts (mixed roster), diversity present and in [0,1], in-flight/failed rounds
    excluded; 404 run.
  - DELETE: registry run → 200 + registry empty + disposeRunRecord called (spy) +
    `runs.status === 'stopped'` + subsequent POST /rounds → 409 'run is stopped';
    no db row → 404; legacy db-only run (no registry record) → 409 not-stoppable and
    the row is untouched.
- **E2E guard (dashboard.e2e.test.ts):** new endpoints respond on the mock run
  (create run, complete 1 round via the existing mock flow, GET both endpoints,
  assert shapes). The e2e run is legacy (3-arg server) — DELETE against it pins the
  409 not-stoppable path; the success path is covered by the inject test above.
- **Gate:** `npm test` (0 failed; 2 pre-existing daemon-gated skips),
  `npm run typecheck` exit 0, `npm run web:build` exit 0.

## 8. Spec coverage map (design §14)

- "Agent detail drawer — strategy diff against previous round, notes diff, submission
  render, judge rationale, lineage path, per-round score history" → §3.1 + §5.1.
- "Analytics — fitness over time (mean, max, min), model share per round, strategy
  diversity metric, lineage tree" → §3.2 + §5.2.
- Design line 450 (chart segments at goal changes) → §3.2 rule + §5.2.
- Design §13 `GET /api/agents/:id/lineage` + `GET /api/submissions/:id` → consolidated
  into §3.1 (one fetch serves the drawer; lineage and submissions are fields, not
  endpoints). Deliberate deviation from the 2026-08-22 API sketch: no other consumer
  wants the separate shapes, and the drawer is the only UI that needs them.
- 4b deferred #8 (stop a run) → §3.3 + §5.3.