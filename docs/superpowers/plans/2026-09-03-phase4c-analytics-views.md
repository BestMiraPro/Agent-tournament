# Phase 4c Implementation Plan — Analytics views (agent drawer + run analytics)

Spec: `docs/superpowers/specs/2026-09-03-phase4c-analytics-views-design.md` (commit `9d0f3a1`).
When the plan and spec disagree, the spec wins — flag the disagreement, don't silently pick.

## Global constraints

- **Gate (run after EVERY task, all three):** `npm test` (0 failed; 2 pre-existing
  daemon-gated e2e skips), `npm run typecheck` (exit 0), `npm run web:build` (exit 0).
- **No new dependencies** (root or web). No engine / runtime / CLI / schema / migration
  changes. No changes to existing endpoints' behavior (the `POST /rounds` / `PATCH`
  409-on-stopped guards are the only additions to existing routes).
- Repo getters are additive; existing getters byte-for-byte untouched.
- Test layout: flat root vitest suite; web pure helpers in plain `web/src/lib/*.ts`
  tested from `test/web/*.test.ts` (see `test/web/live-run.test.ts` for the import
  pattern). API tests use fastify `inject` + in-memory repos (see
  `test/server/api.test.ts`, `test/server/state.test.ts`, `test/server/real-modes.test.ts`).
- Server response shapes come from spec §3 verbatim. 404/400/409 messages mirror
  existing routes (`'no such run'` style).
- Web text rendering is `<pre>` (markdown rendering deferred). No chart/diff libraries.
- Codebase is comment-dense with WHY comments — match the convention. `ponytail:`
  comments where the spec names a deliberate ceiling (strategyDiversity, lineDiff).
- One commit per task, message style per `git log --oneline -10`.

## Verified starting points (read these first)

- `src/server/api.ts` — route table, 3-arg/5-arg `buildApi`, registry access,
  `specErrorCode`, the 4b stop-relevant handlers (`POST /rounds` line ~151,
  `PATCH config` line ~165, `disposeRunRecord` usage in `src/server/runs.ts`).
- `src/server/runs.ts` — `RunRecord`, `disposeRunRecord` (pinned order:
  bridges → manager.disposeAll → cleanup).
- `src/server/state.ts` — `buildRunSnapshot` (snapshot already carries
  `parentAgentId`; lineage tree is client-side).
- `src/db/repos.ts` + `src/db/schema.ts` — every table/field the views need exists.
  Note `runs.status` is a loose string (`'active'` at create) — the stop marker needs
  no migration.
- `web/src/App.tsx` — setup-first flow, `parseRoster`, snapshot state;
  `web/src/useLiveRun.ts` — WS + refresh triggers; `web/src/components/*` —
  AgentGrid (cells not yet clickable), Leaderboard, RoundControls, RunSetup.
- `web/src/api.ts` — fetch helpers to extend.

---

## Task 1 — Pure analytics functions (server + web)

**Files:** `src/core/analytics.ts` (new), `test/core/analytics.test.ts` (new),
`web/src/lib/diff.ts` (new), `web/src/lib/goals.ts` (new), `test/web/diff.test.ts` (new).

Per spec §4:

1. `strategyDiversity(strategies: string[]): number` in `src/core/analytics.ts`.
   Mean pairwise `1 − Jaccard` over lowercased whitespace word sets; n<2 → 0; both
   empty sets → identical (contributes 1). `ponytail:` comment with the O(n²·w)
   ceiling + min-hash upgrade path (spec §4.1 wording).
   Tests (write first): identical set → 0; disjoint → 1; n<2 → 0 (0, 1 element);
   both-empty pair → 1; case/whitespace-insensitive tokenization; a mixed case with a
   hand-computed value.
2. `lineDiff(a, b): DiffLine[]` in `web/src/lib/diff.ts` (spec §4.2: LCS DP over
   `\n`-split lines; `DiffLine = { kind: 'same'|'add'|'del', text }`; `ponytail:`
   comment with the O(n·m) ceiling). Tests in `test/web/diff.test.ts`: identical →
   all `same`; pure additions; pure deletions; modified line → del+add; empty a;
   empty b; single-line identical.
3. `goalChangeFlags(goalMdPerRound: string[]): boolean[]` in `web/src/lib/goals.ts` —
   `flags[i]` is true when `goalMdPerRound[i] !== goalMdPerRound[i-1]` (first entry
   false). Used by the chart to break the line at goal changes (spec §3.2 rule).
   Tests: single round → [false]; unchanged goals → all false; change at round 3 →
   flags[2] true only.

Gate. Commit: `feat: pure analytics functions — diversity, line diff, goal flags`.

## Task 2 — Repo getters + agent-detail endpoint

**Files:** `src/db/repos.ts` (additive), `test/db/repos.test.ts` (or existing repos
test file — extend it), `src/server/api.ts` (new route), `test/server/analytics-api.test.ts`
(new).

1. Repo getters (additive, existing style, one query each):
   - `agents.listAll(runId): AgentRow[]` (all statuses, asc by rowid/insertion),
   - `genomes.forAgent(agentId)` asc `round_idx`,
   - `scores.forAgent(roundIds: string[], agentId)` (or `forAgentRun(runId, agentId)`
     — implementer's call, keep it one query),
   - `submissions.forAgent(roundId, agentId)` (the table already has
     `UNIQUE(round_id, agent_id)`; a `WHERE round_id=? AND agent_id=?` get).
   Extend the existing repos test file with one assertion cluster per getter (seed
   rows, read back, assert order/contents).
2. `GET /api/runs/:runId/agents/:agentId` (spec §3.1 verbatim):
   - 404 `'no such run'` / `'no such agent'` (agent must belong to the run).
   - `agent` from the row (diedRound null-safe); `lineage` walks `parentAgentId`
     through `listAll` labels, self first, max depth = number of agents (cycle guard);
   - `genomes` asc; `history` = rounds with a score row for the agent, asc, each with
     the submission join (null when absent) — token fields mapped to the spec's
     `{ in, out, cacheRead, cacheWrite }` shape.
   Inject tests (write first): a seeded 3-round run with a 3-deep lineage — assert
   full shape (lineage order, genomes asc, history order, submission join, one
   history entry with `submission: null`), 404 unknown run, 404 unknown agent, and
   404 for a valid agent that belongs to a *different* run (agent ids are globally
   unique; the endpoint must verify membership in the requested run).
3. Legacy 3-arg path: route hangs off the same `app` — verify by constructing the
   3-arg api in one inject test and hitting the route (repos-only run works).

Gate. Commit: `feat: agent-detail endpoint with lineage, genomes, history`.

## Task 3 — Round-stats endpoint + stop run

**Files:** `src/server/api.ts` (new route + two guards), `src/db/repos.ts` (one
additive `runs.setStatus(runId, status)`), `src/server/runs.ts` (only if a helper
belongs there — keep the handler thin), `test/server/analytics-api.test.ts` (extend),
`test/server/stop-run.test.ts` (new, or extend real-modes.test.ts if the fake-seams
pattern is closer).

1. `GET /api/runs/:runId/rounds` (spec §3.2 verbatim): per round with score rows,
   asc — `fitness { mean, min, max }`, `modelShare` from `genomes.forRound(agentId,
   idx)` per agent that has one, `diversity` via Task 1's `strategyDiversity`.
   In-flight/failed rounds excluded. Inject tests (write first): seeded 3-round mixed
   roster — hand-computed mean/min/max, modelShare counts, diversity in [0,1] and
   > 0 for distinct strategies; a round with no scores (created but not scored)
   absent; 404 unknown run.
2. `DELETE /api/runs/:id` (spec §3.3):
   - no db row → 404; run not in registry → 409 `'run is not stoppable (created
     outside the dashboard)'` and the row untouched;
   - else: `disposeRunRecord(record)` (existing, order pinned) →
     `runs.setStatus(id, 'stopped')` → `registry.delete(id)` → 200 `{ stopped: true }`.
     Never throws (mirror `disposeRunRecord`'s never-throw contract).
   - Guards: `POST /rounds` and `PATCH config` early-return 409 `'run is stopped'`
     when `run.status === 'stopped'` (after the existing 404 row check, before the
     busy check). Grep first: confirm nothing else reads `runs.status` before
     introducing the new value (spec ruling).
   Tests: registry run (fake seams, mirror real-modes.test.ts) → 200, registry empty,
   disposeRunRecord called (spy), status `'stopped'` in db, subsequent POST /rounds →
   409 'run is stopped', PATCH → 409; no-row → 404; legacy run → 409 not-stoppable,
   row untouched; existing dispose-order tests stay green (no reordering).
3. No changes to the 3-arg path beyond the route/guards (same `app`).

Gate. Commit: `feat: round-stats endpoint and DELETE stop-run with stopped guards`.

## Task 4 — Web: agent detail drawer

**Files:** `web/src/api.ts` (`getAgentDetail`), `web/src/components/AgentDrawer.tsx`
(new), `web/src/components/AgentGrid.tsx` (cells clickable), `web/src/App.tsx`
(selection state + drawer mount), `web/src/styles.css` (drawer/line-diff styles,
matching existing class conventions).

1. `getAgentDetail(runId, agentId)` in `web/src/api.ts` (same fetch/error convention
   as the existing helpers — `parseError` style).
2. `AgentDrawer({ runId, agentId, onClose })`: fetch on select (loading spinner +
   error message, drawer stays open on error); sections per spec §5.1:
   header (label, model+temp badge, born round, status, ✕); score-history table
   (round → rank/score/band asc + best-rank line); current strategy `<pre>` +
   "vs previous round" via Task 1's `lineDiff` (−/+/= colored lines; section hidden
   when < 2 genomes); notes diff (same renderer); latest submission (status badge,
   cost, duration, errorText when any, `submissionMd` `<pre>`, file manifest as a
   plain list when the JSON parses); latest rationale `<pre>`; lineage breadcrumb
   (reversed `lineage`, labels with born rounds). Close on ✕/Esc/backdrop.
3. `AgentGrid` cells: `onSelect(agentId)` prop (button or clickable div with
   `cursor: pointer` + keyboard-focusable — a11y baseline: it's a real action).
   `App` holds `selectedAgentId`, renders the drawer, refetches on new selection.
4. No new web test infra (pure functions already covered in Task 1); correctness bar
   here is `typecheck` + `web:build` + the e2e guard (Task 6).

Gate. Commit: `feat: agent detail drawer — history, diffs, submission, lineage`.

## Task 5 — Web: analytics panel + stop button

**Files:** `web/src/api.ts` (`getRoundStats`, `deleteRun`),
`web/src/components/AnalyticsPanel.tsx` (new), `web/src/App.tsx`,
`web/src/styles.css`.

1. `getRoundStats(runId)`, `deleteRun(runId)` fetch helpers.
2. `AnalyticsPanel({ runId, agents, onOpenAgent, refreshKey })` — rendered below the
   arena once ≥ 1 completed round (fetch on mount + on the existing useLiveRun
   snapshot-refresh trigger — pass the refresh key through, no new polling):
   - Fitness chart: hand-rolled SVG (viewBox, polylines for mean/max/min with a
     legend; x = round idx ticks; y = a couple of score ticks; line **segments
     break** where Task 1's `goalChangeFlags` says the goal changed).
   - Per-round table: `idx | mean | min | max | diversity | <model share columns>`;
     share columns = union of models across rounds, cell = count with a `title`
     tooltip showing the round's % for that model.
   - Lineage tree: nested `<ul>` from the snapshot's `agents` (`parentAgentId`),
     seeds as roots; names are buttons → `onOpenAgent(agentId)` (opens the drawer).
     (Active agents only — documented limitation per spec §5.2.)
3. Stop button in the arena header (danger style): `window.confirm` → `deleteRun` →
   disabled in flight; 200 → hide button + "run stopped" note; 404/409 → inline
   server error (spec §5.3 — always rendered, server is the authority).

Gate. Commit: `feat: analytics panel — fitness chart, model share, lineage tree, stop`.

## Task 6 — E2E guard + full gate

**Files:** `test/server/dashboard.e2e.test.ts` (append).

1. In the existing mock run (create run, complete 1 round via the existing mock
   flow): `GET /api/runs/:id/agents/:agentId` → 200, assert `agent` + `genomes`
   length ≥ 1 + `history` length === 1 + lineage ends at the seed;
   `GET /api/runs/:id/rounds` → 200, one entry with `fitness` numbers,
   `modelShare` summing to the agent count, `diversity` in [0,1].
2. `DELETE /api/runs/:id` against the legacy e2e run → 409 not-stoppable, and the
   run still serves its snapshot (row untouched). (The success path is pinned by
   Task 3's inject tests — don't duplicate it here.)
3. Full gate: `npm test`, `npm run typecheck`, `npm run web:build`. All green.

Commit: `test: e2e guards for analytics endpoints and stop-run`.

---

## Out of scope (do NOT start)

Per spec §1: markdown rendering, agent add/retire + criteria-override + round-abort
endpoints, meta_digest display, `startServer` orphan-kill, crossover/§20 polish.

## Spec coverage check

- §3.1 agent-detail → Task 2. §3.2 round-stats → Task 3. §3.3 stop → Task 3 + Task 5.
- §4 pure fns → Task 1. §5.1 drawer → Task 4. §5.2 analytics → Task 5. §5.3 stop
  button → Task 5. §7 tests → Tasks 1-3 (unit+inject), 6 (e2e), gate on every task.
- §8 design-coverage: drawer items, analytics items, goal segmentation, endpoint
  consolidation, 4b-deferred #8 — all mapped above.