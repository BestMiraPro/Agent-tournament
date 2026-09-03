# Phase 4d Implementation Plan — Remaining design-spec items

Spec: `docs/superpowers/specs/2026-09-03-phase4d-remaining-items-design.md` (commit `6bf88f9`).
When the plan and spec disagree, the spec wins — flag the disagreement, don't silently pick.

## Global constraints

- **Gate (run after EVERY task, all three):** `npm test` (0 failed; 2 pre-existing
  daemon-gated e2e skips), `npm run typecheck` (exit 0), `npm run web:build` (exit 0).
- **No new dependencies** (root or web). No schema/migration changes. No CLI changes.
- Driver changes are limited to spec §5.2 (criteria re-read, ~3 lines) and §8 (abort
  flag + gates) — nothing else in `src/engine/driver.ts`.
- Test layout: flat root vitest suite; web pure helpers in plain `web/src/lib/*.ts`
  tested from `test/web/*.test.ts` (see `test/web/diff.test.ts`, `test/web/live-run.test.ts`).
  API tests use fastify `inject` + in-memory repos (see `test/server/api.test.ts`,
  `test/server/analytics-api.test.ts`, `test/server/real-modes.test.ts`).
- Server response shapes come from the spec verbatim. 404/400/409 messages mirror
  existing routes (`'no such run'` style).
- Codebase is comment-dense with WHY comments — match the convention. `ponytail:`
  comments where the spec names a deliberate ceiling.
- One commit per task, message style per `git log --oneline -10`.

## Verified starting points (read these first)

- `src/runtime/opencode/server.ts:38-71` + `test/runtime/opencode/server.test.ts`
  (faking pattern for Task 1).
- `src/core/selection.ts` (76 lines, read fully) + `test/core/selection.test.ts`
  (property-test style for Task 3 to extend).
- `src/evolution/breed.ts` (80 lines, read fully) + `test/evolution/breed.test.ts`.
- `src/server/run-spec.ts` (RunSpec schema), `src/server/api.ts` PATCH schema
  (~line 171) + `runConfigFor` in `src/server/compose-run.ts:71` (Task 3 plumbing).
- `src/db/repos.ts` (`agents.create/retire`, `genomes.*`, `rounds.setCriteria/get`,
  `runs.setStatus`) + `src/db/schema.ts` (no changes).
- `src/engine/driver.ts` JUDGE phase (~line 452), EVOLVE/REFLECT phases, `runRound`
  try/catch/finally shape (Tasks 5+6 touch these — read the whole `runRound` once).
- `src/judge/judge.ts:69-81` (`resolveCriteria` short-circuit — Task 5 relies on it).
- `src/server/run-manager.ts` (62 lines, read fully — Task 6 adds one method).
- `src/core/pool.ts` (or wherever `runPool` lives — grep it; Task 6 adds
  `shouldStop`).
- `web/src/components/RoundControls.tsx` (28 lines) + `web/src/App.tsx` (wiring for
  Task 7) + `web/src/components/AgentDrawer.tsx` (retire button host).
- Spec §2 (verified facts) for the load-bearing details (round-create criteria
  default, PATCH unknown-key stripping, retire signature, budget sentinel).

---

## Task 1 — `startServer` kills the child on timeout

**Files:** `src/runtime/opencode/server.ts`, `test/runtime/opencode/server.test.ts`.

Per spec §9: in the startup-timeout rejection path ONLY, `child.kill()` before
rejecting (one-line WHY: the `error`/`exit` rejections mean the child is already
dead/dying — killing there is pointless). No other behavior change.
Test via the file's existing faking pattern: a command that sleeps past a tiny
`startupTimeoutMs` → promise rejects AND the child is dead (assert kill delivery
the way the file's harness allows — e.g. the sleeper's `exit`/`close` fires or the
handle reports killed; do not add new test infrastructure).

Gate. Commit: `fix: kill the opencode child when startServer times out`.

## Task 2 — Markdown subset renderer (web only)

**Files:** `web/src/lib/markdown.ts` (new), `web/src/components/Markdown.tsx` (new),
`test/web/markdown.test.ts` (new).

Per spec §3 (escape-first pipeline, closed subset, code-placeholders-before-inline
order — the ORDER matters, implement it exactly as specified):
`renderMarkdown(md: string): string` + tiny `<Markdown text>` wrapper with the
single sanctioned `dangerouslySetInnerHTML` (comment cites the escape-first
pipeline + XSS tests).
Tests (write first, root suite): escape-first pin (`<script>`/`<img onerror>`
render inert — assert no `<script`, no `<img`, no `onerror=` attribute in output
with the escaped text present); one test per supported construct (fence, h1-h3,
bold, italic, inline code, list, quote, rule, paragraph); code-span protection
(`` `**not bold**` `` stays literal); unsupported (`[x](http://y)`, `![a](b)`,
`| t |`) → plain text with no `<a`/`<img`/`<table`; empty string → empty string.
NOT adopted anywhere yet (Task 7 does the adoption) — no other file touched.

Gate. Commit: `feat: escape-first markdown subset renderer with XSS pins`.

## Task 3 — Crossover: selection + breed + config plumbing

**Files:** `src/core/selection.ts`, `test/core/selection.test.ts`,
`src/evolution/breed.ts`, `test/evolution/breed.test.ts`,
`test/evolution/crossover-round.test.ts` (new, or extend the evolution integration
file if the mock-round pattern lives there), `src/server/run-spec.ts`,
`src/server/api.ts` (PATCH schema only), `src/server/compose-run.ts`
(`runConfigFor` selection merge only).

1. Selection per spec §7.1: `crossoverPct` finite + [0,1] validation (throw; WHY
   comment noting it's stricter than the sibling pcts); plan gains `crossovers`
   (new `CrossoverAssignment` interface); empty-plan early return gains
   `crossovers: []` — grep EVERY construction site of a SelectionPlan and update
   them (compiler will flag the misses; there may be test fakes).
   `numCrossover = min(culled.length, floor(culled.length * crossoverPct))`, 0 when
   `topBand.length < 2`; first slots become crossovers; parents
   `A = topBand[(2i) % L]`, `B = topBand[(2i+1) % L]`.
   Tests (extend selection.test.ts, write first): pct 0 → `crossovers: []`, clones
   unchanged (default path byte-identical); 0.5 on 4 culled → 2 crossovers (first
   slots) + 2 clones, parents distinct and from the top band; pct 1 → all
   crossover; single-entry top band → all clones; NaN/1.5/-0.1 → throw; empty
   input → shape with `crossovers: []`.
2. Breed per spec §7.2: crossover branch with the exact merge rules (ceil-half A +
   floor-half B by lines; provenance notes + A's notes; model/temp from A;
   `parentAgentId` = A; `parentGenomeId` = A's genome; `origin: 'crossover'`;
   shared label counter with clones; missing-parent skip mirroring clones).
   `ponytail:` comment per spec. Tests (write first): odd + even line counts with
   exact expected strings; provenance/origin/parentage/model/temp pins; label
   uniqueness vs a clone in the same plan; missing-parent skip.
3. Config plumbing per spec §7.3 (three additive edits): RunSpec optional
   `selection` (crossoverPct 0..1); PATCH schema same shape; `runConfigFor`
   `{ ...DEFAULT_CONFIG.selection, ...spec.selection }`.
   Tests: run-spec accepts/rejects (incl. 1.5 and -0.1); PATCH with
   `selection.crossoverPct` reaches the next round's plan (one inject test —
   mock engine or plan-level assertion, your call, keep it to one).
4. End-to-end pin: one mock-driver round with `crossoverPct > 0` asserting a
   `'crossover'` genome row exists (small scale — 4 agents, 1 round — mirror the
   evolution integration style, do not build new harness).
5. Driver UNTOUCHED (breed reads `plan.crossovers`; pct 0 yields none) — verify by
   `git diff --name-only` showing no `src/engine/*`.

Gate. Commit: `feat: crossover operator — selection, breed, config plumbing`.

## Task 4 — Add-agent + retire-agent endpoints

**Files:** `src/server/api.ts` (two routes), `test/server/population.test.ts` (new,
or extend analytics-api.test.ts if its seed style fits better — your call, say which).

Per spec §4 (both endpoints with every rule — 404s, 409 busy/stopped, pricing 400,
clone-source 404/400, label scheme, bornRound/genome/origin/parentage rules, no
provisioning WHY, retire guards incl. last-agent, no-teardown WHY deviation note):
- `POST /api/runs/:runId/agents` → 201 `{ agentId, label }`. TDD with a seeded run:
  blank (empty strategy, origin manual, null parents), pasted (text through),
  clone (strategy+notes from source's latest genome, parentage set); 400s (bad
  temperature, empty pasted text, clone source without genome); 404s (run, foreign
  clone source); 400 missing-pricing (USD-limited run + unpriced model — seed the
  run config with a USD cap to pin this); 409 busy (fake a busy manager the way
  real-modes.test.ts does); 409 stopped (set a row to 'stopped' first).
- `DELETE /api/runs/:runId/agents/:agentId` → 200 `{ retired: true }`: happy path
  asserts `status === 'retired'` + `diedRound === lastRoundIdx` in db; 404s; 409
  busy/stopped; 409 already-retired (retire twice); 409 last-active-agent (seed a
  1-agent run).
- No other file touched (no driver/sandbox changes — adds provision at next
  PREPARE by construction).

Gate. Commit: `feat: add-agent and retire-agent endpoints`.

## Task 5 — Criteria override + driver re-read + round detail fields

**Files:** `src/server/api.ts` (override route + GET-rounds additive fields),
`src/engine/driver.ts` (JUDGE re-read, ~4 lines), `test/server/population.test.ts`
(or the Task 4 file — extend it), `test/engine/driver.test.ts` (re-read test).

1. `POST /api/runs/:runId/rounds/:idx/criteria` per spec §5.1 (`{ criteriaMd }`
   min-1; 404 run/round-idx; 409 stopped; 409 complete/failed round; else
   `setCriteria(id, md, 'user')` → 200). Best-effort limitation in the handler
   comment. Tests: 200 writes row criteria+source; 404s; 409 scored round (seed a
   complete round); 409 stopped.
2. Driver re-read per spec §5.2 (insert before `resolveCriteria`, WHY comment
   citing the fresh-row default): `const rowNow = repos.rounds.get(round.id)` +
   effective-criteria line. Test (driver.test.ts, mocks, write first): round row
   pre-seeded with user criteria + `input.criteriaMd = null` → `judge.score`
   called with the row's criteria; all existing input-path tests pass untouched.
3. GET-rounds additive fields per spec §6 (`criteriaMd`, `criteriaSource`,
   `metaDigest` straight from the row): extend the Task-3 round-stats assertions
   (one user-criteria+digest round asserts all three; one generated round asserts
   null digest). No other endpoint change.

Gate. Commit: `feat: criteria override with driver re-read and round detail fields`.

## Task 6 — Cooperative abort

**Files:** `src/core/pool.ts` (or wherever `runPool` lives — grep; `shouldStop`
option), `test/core/pool.test.ts` (or the pool's test file), `src/engine/driver.ts`
(flag + gates), `src/server/run-manager.ts` (`abortRound`), `src/server/api.ts`
(abort route), `test/engine/driver.test.ts` (abort test), `test/server/population.test.ts`
(or the Task 4/5 file — abort API tests).

Per spec §8 (honest cooperative semantics — no mid-call kill, no new failure
mechanism, no new result variant):
1. `runPool`: optional `opts.shouldStop?: () => boolean`; workers stop pulling when
   true; unprocessed items resolve in the EXISTING failure shape with message
   `'round aborted'` (read pool.ts's result type first — mirror a worker exception
   exactly). Existing callers pass nothing (behavior identical). Tests: queued
   items abort-fail while the in-flight one completes; no-shouldStop path unchanged.
2. Engine: `abortRound(runId): void` sets a private per-run flag; driver gates —
   PREPARE pool + RUN pool get `shouldStop: () => this.aborted.has(runId)`, and
   before JUDGE/EVOLVE/REFLECT `if (this.aborted.has(runId)) throw new Error('round
   aborted by user')` reusing the existing catch path (round failed + lastError +
   `round.complete` emit). Flag cleared in `runRound`'s finally AND at start (WHY:
   a stale flag must never kill the next round). No other driver change.
3. Manager: `abortRound(runId): boolean` — false when not busy (sets nothing), true
   when busy (calls `engine.abortRound`). Both arities get it (shared classes).
4. `POST /api/runs/:runId/rounds/:idx/abort` → 404 no run; 404 no such round idx;
   409 stopped; 409 `'no round in flight'` when idx isn't the last round OR the
   manager isn't busy; else → 202 `{ aborted: true }`.
   Tests: driver abort-before-RUN with mocks (runner spy never called, round
   failed, lastError set, judge never called); API inject with a fake manager
   (busy + `abortRound` spy → 202 + called; idle → 409; bad idx → 404).

Gate. Commit: `feat: cooperative round abort — pool, engine, manager, endpoint`.

## Task 7 — Web: markdown adoption + between-rounds controls + drawer retire

**Files:** `web/src/components/RoundControls.tsx` (criteria input, override button,
digest block, add-agent form, abort button), `web/src/components/AgentDrawer.tsx`
(retire button), `web/src/components/Markdown.tsx` (already exists from Task 2 —
USE it), `web/src/api.ts` (`createAgent`, `retireAgent`, `overrideCriteria`,
`abortRound` helpers), `web/src/App.tsx` (wiring), `web/src/styles.css`.

1. Markdown adoption (Task 2's renderer): drawer current-strategy, latest
   submission, latest rationale `<pre>` → `<Markdown>`; diffs STAY text. No other
   component changes for this item.
2. `RoundControls` per spec §5.3 + §4 + §8 (props extended — check every usage):
   criteria textarea (prefill from last round's criteriaMd when non-null via the
   §6 fields, else empty; content flows into the next POST /rounds body — App
   wiring); "Override running round" button visible ONLY while busy (POSTs to
   §5.1, inline message + the best-effort hint line); last round's meta_digest
   block (`<Markdown>`, only when non-null) + criteriaSource badge; "Add agent"
   form (roster-model select + temperature + mode radio + conditional textarea /
   agent select; disabled while busy; inline messages); "Abort round" button
   visible ONLY while busy (danger outline, the spec's confirm copy, local
   `aborting` state cleared when the snapshot refresh shows idle).
3. Drawer retire button (header, per spec §4.2): confirm → `retireAgent` → success
   closes drawer + snapshot refresh (reuse App's existing refresh path); 4xx shows
   the server message inline, drawer stays open.
4. `web/src/api.ts`: four helpers in the file's convention (error messages surface
   verbatim via the shared `serverError`).
5. No server code. No behavior change to existing controls when the new props are
   absent (keep RoundControls backward-compatible if anything else renders it —
   grep usages).

Gate (`npm test` covers the Task 2 markdown tests; correctness bar here is
typecheck + build + Task 8 e2e). Commit: `feat: between-rounds controls — criteria,
population edits, abort, markdown`.

## Task 8 — E2E guards + full gate

**Files:** `test/server/dashboard.e2e.test.ts` (append-only).

In the existing mock run (reuse its flow — create, complete 1 round):
1. Add-agent (pasted) → 201; agent-detail on the new id → 200 with the pasted
   strategy; retire it → 200; second retire → 409; agent-detail still 200 with
   `status: 'retired'`.
2. Criteria override on the completed round → 409-scored pin (mock rounds finish
   fast — the success path is pinned by Task 5's inject + driver tests; do NOT
   duplicate it here).
3. Abort on the idle mock run → 409 `'no round in flight'`.
4. GET-rounds entry for the completed round carries the three §6 fields
   (criteriaMd non-null, source `'generated'`, metaDigest nullable — assert keys
   exist, not exact text).
5. Full gate: `npm test`, `npm run typecheck`, `npm run web:build`. All green.

Commit: `test: e2e guards for population edits, criteria, abort, round fields`.

---

## Out of scope (do NOT start)

Per spec §1: engine mid-call cancellation, LLM-recombine crossover, full markdown,
separate round-detail endpoint, RunSetup selection control, anything already
shipped in 4b/4c.

## Spec coverage check

- §3 markdown → Task 2 (+ adoption Task 7). §4.1 add → Task 4 (+ form Task 7).
  §4.2 retire → Task 4 (+ button Task 7). §5.1 override → Task 5 (+ UI Task 7).
  §5.2 re-read → Task 5. §5.3 controls → Task 7. §6 fields → Task 5 (+ display
  Task 7). §7.1 selection → Task 3. §7.2 breed → Task 3. §7.3 plumbing → Task 3.
  §8 abort → Task 6 (+ button Task 7). §9 kill → Task 1. §10 tests → Tasks 1-6
  (unit+inject), 8 (e2e), gate on every task.