# Phase 4d — Remaining design-spec items (population edits, criteria, abort, crossover, markdown, server kill)

Status: approved for planning
Completes the deferred follow-ups: 4b review #13 (`startServer` orphan kill), 4c §1
deferrals (markdown rendering, add/retire agents, criteria override, `meta_digest`
display), design §13 abort endpoint, and design §20/`crossoverPct` crossover operator.

## 1. Goal and non-goals

Close the dashboard's between-rounds loop (population edits, criteria control, abort)
and the engine's last accepted-but-dead knob (`crossoverPct`), plus two small
robustness items (server kill, markdown).

In scope (§2–§9): 8 items, each independently reviewable.
Out of scope (stay out):
- Engine cancellation mid-call (abort is cooperative: stops NEW work, in-flight
  agents run to completion/timeout — §8 documents this honestly).
- LLM-recombine crossover (deterministic line-split merge is v1 — §7).
- Full markdown (closed subset only — §3).
- `GET /api/rounds/:id` as a separate endpoint (round detail needs are met by the
  additive fields in §6).
- Crossover UI control beyond PATCH (no setup-screen/RunSetup change; `crossoverPct`
  is PATCH-adjustable, default 0).
- Anything in 4b/4c scope already shipped.

## 2. Verified facts (state of the world)

- `startServer` (`src/runtime/opencode/server.ts:38-71`): startup-timeout rejects the
  promise but never kills the child → slow starters become orphans (4b review #13,
  still true).
- Web renders all markdown-ish text as `<pre>`; no markdown lib, no
  `dangerouslySetInnerHTML` anywhere in `web/src` (4c final review verified).
- `crossoverPct` EXISTS in `RunConfig` + `DEFAULT_CONFIG.selection` (default 0) and in
  `SelectionConfig`, but `planSelection` never validates or uses it and `breed` has
  no crossover branch — the knob is accepted and dead. `GenomeOrigin` already
  includes `'crossover'`; `CloneAssignment`/clone labels (`competitor-r{N}-{i}`) are
  the pattern to mirror.
- `planSelection` returns `{ elite, survivors, culled, clones }`; clone count is
  derived from cull count (population invariant); clone parents cycle
  `topBand[i % topBand.length]`; empty input returns the empty plan.
- Criteria flow: `POST /rounds` body `criteriaMd` → `runRound(runId, { goalMd,
  criteriaMd })` → JUDGE phase `judge.resolveCriteria(goalMd, input.criteriaMd)` →
  `repos.rounds.setCriteria(row, md, source)`. `rounds.create` defaults
  `criteriaMd: null, criteriaSource: 'generated'` — a fresh row NEVER looks
  user-overridden (this is what makes §5's re-read safe).
- `RoundControls` is goal-textarea + run button only (no criteria input, no
  `meta_digest`, no abort). `GET /api/runs/:runId/rounds` (4c) entries carry
  `{ idx, goalMd, costUsd, fitness, modelShare, diversity }` — no criteria/digest.
- `RunManager` (`src/server/run-manager.ts`): no abort; `startRound` launches a task,
  `disposeAll` awaits it. Driver `runRound` phases (PREPARE pool → RUN pool →
  COLLECT → JUDGE → EVOLVE → REFLECT) have no cancellation points; per-item failure
  paths already exist in both pools (a worker exception becomes a per-item error
  result — abort degrades through these, §8).
- `agents.retire(agentId, roundIdx, status)` exists (breed uses it with `'culled'`);
  design: remove = `status = retired` + `died_round` set.
- PATCH schema (4b) accepts `roster`/`budget`/`judge` only; `RunSpec` has no
  `selection` field; `runConfigFor` builds judge/reflect/budget explicitly.
  (Unknown PATCH keys are stripped, not rejected — so `selection` must be added
  explicitly to flow through.)

## 3. Markdown subset renderer (web only)

- New `web/src/lib/markdown.ts`: `renderMarkdown(md: string): string`.
  **Escape HTML FIRST** (`&<>"'`), then apply a CLOSED subset, in this order:
  fenced code blocks (``` … ```) and inline code (`` `x` ``) are extracted to
  placeholders FIRST (so `**`/`*` inside code never fire), then headings
  (`#`–`###`), bold (`**x**`), italic (`*x*`), unordered lists (`-`/`*` lines →
  `<ul>`), blockquotes (`>`), horizontal rules (`---`), else paragraph-wrap, then
  code placeholders restored. No links, no images, no tables, no raw HTML
  passthrough (unsupported syntax renders as plain escaped text — never an
  `<a>`/`<img>`/`<table>` in the output).
- New `web/src/components/Markdown.tsx`: tiny `<Markdown text>` wrapper using the
  single sanctioned `dangerouslySetInnerHTML`, with a comment citing the
  escape-first pipeline and pointing at the XSS tests.
- Adopt in the drawer: current strategy, latest submission, latest rationale
  (`<pre>` → `<Markdown>`). Diffs STAY plain text (markup inside +/- lines
  confuses). Lineage/labels/scores stay text. Adopt for the §6 `meta_digest` block.
  Goals stay as-is.
- Tests (`test/web/markdown.test.ts`, root suite): escape-first pin
  (`<script>` renders inert — assert no `<script` substring in output and the
  escaped text present); one test per supported construct; unsupported
  (`[x](http://y)`, `![a](b)`, `| table |`) → plain text, assert output contains no
  `<a`, `<img`, `<table`.

## 4. Population edits (server + web)

Shared rules: 404 no run; 409 `'run is stopped'`; 409 `'run is busy'` (between rounds
only — the driver snapshots `listActive` at PREPARE, so mid-round edits corrupt
nothing today but would write rows the in-flight round never sees; fail loud).

### 4.1 `POST /api/runs/:runId/agents` (add agent)
Body: `{ modelId: string(min 1), temperature: number(0..2, mirrors roster rule),
strategy: { mode: 'blank' } | { mode: 'pasted', strategyMd: string(min 1) } |
{ mode: 'clone', agentId: string } }`.
- 404 `'no such agent'` when a clone source is missing or belongs to another run;
  400 `'clone source has no genome yet'` when the source has no genome row (an
  agent added this same between-rounds window, before any round ran).
- USD-budget check: when the run config has any USD limit and `modelId` is absent
  from `config.pricing` → 400, mirroring `createRun`'s missing-pricing message
  style (Infinity survives the db round-trip via the existing sentinel — read limits
  from the repo-decoded config).
- Label `competitor-r{nextIdx}-manual-{n}` (`nextIdx = lastRoundIdx + 1`), unique by
  construction (agents are never deleted; loop with a bounded suffix on collision —
  races between concurrent adds are the only collision source).
- `bornRound = nextIdx`; genome at `roundIdx = bornRound`, `origin: 'manual'`,
  `parentGenomeId` = clone source's latest genome id (or null),
  `parentAgentId` = clone source (or null); `blank` = empty `strategyMd`
  (documented WHY: the agent's first reflection fills it in; the judge scores its
  submission, not its strategy); `pasted` = the supplied text; `clone` = the
  source's latest genome strategy + notes.
- NO provisioning (documented WHY: PREPARE provisions every active agent each
  round, so a between-rounds add needs no immediate sandbox work).
- 201 `{ agentId, label }`.
- Web: "Add agent" form in the between-rounds area (disabled while busy): model
  `<select>` from the run's roster modelIds, temperature number input, mode radio
  (blank / pasted + textarea / clone + agent `<select>` from snapshot agents);
  inline server-message display. Style follows `RoundControls`.

### 4.2 `DELETE /api/runs/:runId/agents/:agentId` (retire agent)
- 404 no run / no such agent (membership enforced); 409 busy; 409 stopped;
  409 `'agent is not active'` when already retired/culled;
  409 `'cannot retire the last active agent'` (an empty population breaks the next
  round's judge — fail loud, one-line WHY comment).
- Else `agents.retire(agentId, lastRoundIdx, 'retired')` → 200 `{ retired: true }`.
- NO per-agent teardown — deliberate deviation from design line 250 ("the container
  is torn down"), documented WHY at the call site: shard containers are shared
  per-run (no per-agent container exists to tear down) and workspace dirs are
  submission evidence referenced by db rows (`workspace_path`) and must survive.
- Web: "Retire agent" button in the drawer header (Task 4's drawer — no grid
  redesign): `window.confirm`, on success close the drawer and refresh the snapshot
  (reuse the existing refresh path), on 4xx show the server message inline.

## 5. Criteria control (server + small driver change + web)

### 5.1 `POST /api/runs/:runId/rounds/:idx/criteria` (override)
Body: `{ criteriaMd: string(min 1) }`.
- 404 no run / no such round idx; 409 `'run is stopped'`; 409 when the round is
  `complete`/`failed` (`'round already scored'`).
- Else `repos.rounds.setCriteria(round.id, criteriaMd, 'user')` → 200.
- Honest limitation (documented in the handler comment AND the spec's UI copy):
  best-effort before scoring — if the JUDGE phase already resolved criteria, the row
  still records the user's text (display shows it) but scoring used the earlier
  ones. The API cannot see the judge phase (only the busy boolean), so no finer
  guard exists without engine phase reporting (out of scope).

### 5.2 Driver re-read at JUDGE (driver.ts, ~line 452)
Before `resolveCriteria`, insert: read the row —
`const rowNow = repos.rounds.get(round.id);` — and use
`rowNow?.criteriaSource === 'user' ? rowNow.criteriaMd : input.criteriaMd`
as the user-criteria argument. WHY comment: an override that lands mid-round must
win over the POST body; a fresh row defaults to `generated`/null so the fast path
is byte-identical to today. No other driver change.
- Test (driver.test.ts, mocks): round row pre-seeded with user criteria +
  `input.criteriaMd = null` → `judge.score` receives the row's criteria (proves the
  re-read); existing input-path tests keep passing untouched.

### 5.3 RoundControls criteria + digest (web)
- Criteria textarea (prefilled from the last round's `criteriaMd` when the §6 field
  exists and is non-null, else empty = auto-generate): its content goes into the
  next `POST /rounds` body. While busy, an "Override running round" button POSTs
  the same text to §5.1 (inline server message; the best-effort limitation shown as
  a one-line hint under the button).
- Last round's `meta_digest` shown in a small "What separated winners from losers"
  block (`<Markdown>`, §3) when non-null; last round's `criteriaSource` shown as a
  `user`/`generated` badge next to it.

## 6. Round detail fields (server additive + web display)

- `GET /api/runs/:runId/rounds` entries gain three ADDITIVE fields:
  `criteriaMd: string|null`, `criteriaSource: 'user'|'generated'`,
  `metaDigest: string|null` (straight from the round row; unscored rounds still
  excluded per 4c).
- Tests: extend the Task-3 round-stats assertions (one round with user criteria +
  digest asserts the three fields; one generated round asserts null digest).
- Web: consumed only by §5.3 (no analytics-table change; no chart change).

## 7. Crossover operator (selection + breed + config plumbing)

### 7.1 Selection (`src/core/selection.ts`)
- Validate `crossoverPct`: finite AND in [0,1], else throw (one-line WHY: stricter
  than the sibling pcts because it indexes parent pairs; `topPct`/`bottomPct`
  validation untouched).
- `SelectionPlan` gains `crossovers: CrossoverAssignment[]`
  (`{ parentAId, parentBId, replacesAgentId }`); the empty-plan early return gains
  `crossovers: []` (every existing plan-construction site updated — grep them).
- `numCrossover = min(culled.length, floor(culled.length * crossoverPct))`, and 0
  when `topBand.length < 2` (degenerate single-parent crossover is a clone with
  extra steps — WHY comment). The FIRST `numCrossover` culled slots become
  crossovers; the rest stay clones. Parents cycle the top band with guaranteed
  distinctness: `A = topBand[(2i) % L]`, `B = topBand[(2i+1) % L]`.
  Population invariant holds (replacements == culled count, same as clones).
- Tests (selection.test.ts): pct 0 → no crossovers, all clones (default behavior
  byte-identical); pct 0.5 on 4 culled → 2 crossovers + 2 clones with distinct
  top-band parents and first-slots rule; pct 1 → all crossover; single-entry top
  band → all clones; NaN/1.5/-0.1 → throw; empty plan carries `crossovers: []`.

### 7.2 Breed (`src/evolution/breed.ts`)
For each crossover assignment (skip when either parent's prev genome is missing —
mirrors the clone skip): create a NEW agent (label counter SHARED with clones so
`competitor-r{N}-{i}` stays unique) with `parentAgentId = A`, and a genome:
- `strategyMd` = first `ceil(n/2)` lines of A's strategy + last `floor(n/2)` lines
  of B's (line-based split; document the odd-line rule in a comment),
- `notesMd` = `Crossover of ${labelA} × ${labelB}.\n` + A's notes,
- `modelId`/`temperature` from A, `parentGenomeId` = A's genome id,
  `origin: 'crossover'`.
- `ponytail:` comment: naive line-split merge — deterministic and free; upgrade
  path is LLM-recombine if crossover proves load-bearing.
- Tests (breed.test.ts): exact merged lines (odd + even counts), provenance notes,
  origin, `parentAgentId`/genome = A, model/temp from A, label uniqueness against a
  clone in the same plan, missing-parent skip. Plus one mock-driver round with
  `crossoverPct > 0` asserting a `'crossover'` genome row exists (end-to-end pin;
  mirror the evolution integration style at small scale).

### 7.3 Config plumbing (3 additive edits)
- `RunSpec` (`src/server/run-spec.ts`): optional `selection: z.object({
  crossoverPct: z.number().min(0).max(1) }).partial().optional()` (strict-safe:
  unknown keys are stripped, so the field must exist to survive a PATCH merge).
- PATCH schema (api.ts): same `selection` shape, `.partial().optional()`.
- `runConfigFor` (compose-run.ts): `{ ...DEFAULT_CONFIG.selection,
  ...spec.selection }` mirroring the existing budget-merge pattern.
- Driver needs NO change (`breed` reads `plan.crossovers`; `crossoverPct: 0`
  yields none — existing rounds byte-identical).
- Tests: run-spec accepts/rejects the field (incl. out-of-range); PATCH with
  `selection.crossoverPct` flows into the next round's plan (inject test with a
  mock engine or plan-level assertion — implementer's call, keep it to one).

## 8. Cooperative abort (manager + pool + driver gates + endpoint + web)

Semantics (honest, documented in the endpoint comment and the UI copy): abort stops
NEW work; in-flight agents run to completion/timeout; completed phases keep their
rows; the round ends `'failed'`; busy clears when the in-flight task settles.

- `runPool` (read its result shape first): new optional
  `opts.shouldStop?: () => boolean`; workers stop pulling new items when true;
  unprocessed items resolve in the EXISTING failure shape (same as a worker
  exception — no new result variant; message `'round aborted'`). No signature change
  for existing callers.
- Engine: `TournamentEngine.abortRound(runId): void` sets a per-run flag (private
  set; cleared in `runRound`'s finally AND at start — a stale flag must never kill
  the next round; one-line WHY). Driver gates: PREPARE pool + RUN pool get
  `shouldStop: () => this.aborted(runId)`; before JUDGE, before EVOLVE, before
  REFLECT: `if (this.aborted(runId)) throw new Error('round aborted by user')` —
  reusing the existing catch path (marks the round failed, sets lastError, emits
  `round.complete`), NOT a new failure mechanism.
- Manager: `abortRound(runId): boolean` — false when not busy (sets nothing);
  true when busy (calls `engine.abortRound(runId)`). Both `buildApi` arities get it
  (method on the shared `RunManager`; `TournamentEngine` method likewise).
- Endpoint: `POST /api/runs/:runId/rounds/:idx/abort` → 404 no run; 404 no such
  round idx; 409 `'run is stopped'`; 409 `'no round in flight'` when idx isn't the
  run's last round OR the manager isn't busy; else `abortRound` → 202
  `{ aborted: true }`.
- Web: "Abort round" button in `RoundControls` while busy (danger outline):
  `window.confirm('Abort the running round? Queued agents stop; in-flight agents
  finish; the round is marked failed.')` → disabled while aborting (local state,
  cleared when the snapshot refresh shows idle).
- Tests: `runPool` shouldStop (queued items resolve failed-shape, the in-flight one
  completes); manager `abortRound` false-when-idle; driver abort-before-RUN with
  mocks (runner spy never called, round failed, lastError set, judge never called);
  API inject (fake manager a la 4b: `isBusy → true` + `abortRound` spy → 202 + spy
  called; idle → 409; bad idx → 404).

## 9. `startServer` orphan kill (4b review #13)

- `src/runtime/opencode/server.ts`: on startup-timeout rejection, `child.kill()`
  before rejecting (SIGTERM; the child is our own spawn — no `detached` games).
  Same for the `error`/`exit` rejections? No — those mean the child is already
  dead/dying; kill only on the timeout path (document WHY in one line).
- Test via the file's existing faking pattern (`test/runtime/opencode/server.test.ts`
  — read it first): a command that sleeps past a tiny `startupTimeoutMs` →
  rejection AND the child is dead (assert kill was delivered — e.g. the sleeper
  exits / the handle reports it).

## 10. Testing + gate

- **Unit (root suite):** selection crossover cases (§7.1); breed crossover (§7.2);
  markdown XSS + constructs (§3); runPool shouldStop (§8).
- **Driver (mocks):** criteria re-read (§5.2); abort-before-RUN (§8); one
  crossover round end-to-end (§7.2).
- **API (inject):** add-agent (201 + all three modes + 400s + 409s); retire (200 +
  all 409s incl. last-agent); criteria override (200 + 404s + 409-scored);
  round-stats additive fields (§6); abort (202 + 404s + 409s); PATCH selection
  flow (§7.3).
- **E2E guard (dashboard.e2e.test.ts, append-only):** add-agent (pasted) then
  retire it on the mock run; criteria override on the in-flight... (mock rounds
  complete fast — override the completed round → 409-scored pin; the success path
  is pinned by inject + driver tests); abort on the idle mock run → 409.
- **Gate every task:** `npm test` (0 failed; 2 pre-existing daemon-gated skips),
  `npm run typecheck` exit 0, `npm run web:build` exit 0.

## 11. Spec coverage map

- Design §13 `POST /api/runs/:id/agents` → §4.1 (path nested under the run, matching
  this codebase's `/api/runs/:id/...` convention instead of the sketch's flat shape).
- Design §13 `DELETE /api/runs/:id/agents/:agentId` → §4.2 (no per-agent teardown —
  documented deviation: shards are shared, workspaces are evidence).
- Design §13 `POST /api/rounds/:id/criteria` → §5.1 (path nested as
  `/api/runs/:runId/rounds/:idx/criteria`, matching the codebase's run-scoped
  addressing; rounds have no global GET in this codebase).
- Design §13 `POST /api/rounds/:id/abort` → §8 (same nesting reason; cooperative
  semantics — the sketch pins no semantics).
- Design §14 between-rounds panel (edit goal ✓ exists, review/edit criteria,
  add/remove agents, `meta_digest`, run-next) → §4 + §5.3 + §6.
- Design §14 "submission render" (markdown) → §3.
- Design line 250 population edits → §4 (blank = empty strategy with first-
  reflection-fills-it documented; "generated from the goal" needs no LLM — the
  reflection operator already generates from goal context each round).
- Design line 425 `crossoverPct` → §7 (default 0 preserved everywhere).
- 4b review #13 → §9.