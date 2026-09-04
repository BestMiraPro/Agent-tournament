# Phase 4e — Startup recovery + setup-time knobs + model discovery

Status: approved for planning
Closes the surveyed gaps against the design doc: §15 crash recovery (missing),
§14 setup controls (criteria, selection ratios, concurrency, price table — all
`DEFAULT_CONFIG`-fixed today), §13 `GET /api/models` (discovery exists
backend-only). `diversityFloor` (risk-table Phase 5 item) is explicitly NOT
included — it needs A/B evidence first, not code.

## 1. Goal and non-goals

A restarted server leaves no round stuck non-terminal; every create-time knob the
engine already honors is settable at setup (and PATCH-adjustable where the engine
reads it per round); the setup screen offers real model ids with free-text fallback.

In scope (§2–§5): 4 items.
Out of scope (stay out):
- Container adopt-or-recreate on boot (design §15's second half): the registry is
  in-memory, so a restarted server owns no live runs; orphan containers are swept
  at the next docker creation (existing behavior). Documented, not built.
- `diversityFloor`, LLM-recombine crossover, mid-call abort (prior-phase rulings stand).
- Page-reload persistence of setup criteria (single-session dashboard; noted in §4).
- Markdown/full-model-picker componentry (datalist only).

## 2. Verified facts (state of the world)

- Round statuses: `pending|preparing|running|collecting|judging|evolving|reflecting`
  are non-terminal; `complete|failed` are terminal. `rounds.create` starts at
  `pending`; every later transition goes through `repos.rounds.setStatus`.
- No restart-recovery code exists anywhere in `src/server` (grep-verified in 4c
  review). The registry, budgets, and in-flight tasks are all in-memory — a second
  process cannot drive the first's runs, so boot-time recovery cannot strand live
  work (single-server-per-db is already assumed; one-line WHY).
- `discoverModels(client): Promise<string[]>` (`src/runtime/opencode/discovery.ts`)
  needs an `OpenCodeClient` (a running server). Host `opencode` CLI is currently
  absent on PATH (design §20's 2026-08-22 note is stale); `~/.local/share/opencode/
  auth.json` exists. The endpoint must therefore degrade honestly when no server
  can start.
- `RunSpec` already accepts `criteria: string|null` but NO code reads
  `spec.criteria` (grep-verified) — accepted-and-dropped. Rounds own criteria
  (`POST /rounds` body today); setup criteria is a client-side default for round 1.
- `runConfigFor` spreads `...DEFAULT_CONFIG` then overrides explicitly; `selection`
  already merges wholesale (new selection keys flow automatically once `RunSpec`
  carries them). `concurrency`/`pricing` have no spec fields (always defaults).
- PATCH merges onto `record.spec` then re-validates via `parseRunSpec` (4b design) —
  a cross-field rule placed in `parseRunSpec` applies to PATCH for free.
- Driver reads `config.concurrency` per `runRound`, `planSelection` reads
  `config.selection` at EVOLVE, `budget.updateConfig` takes new pricing — all via
  the `reconfigure` swap (4b). PATCH extensions need ZERO engine changes.
- `DEFAULT_CONFIG.pricing = {}`, `concurrency = 8`.

## 3. Startup recovery

- New shared helper `recoverIncompleteRounds(repos): number` (put it next to the
  repos, e.g. `src/db/recover.ts` — one query:
  `UPDATE rounds SET status='failed' WHERE status NOT IN ('complete','failed')`;
  returns the affected count; no other table touched — workspaces are preserved by
  construction since nothing deletes them, containers are left for the
  creation-time sweep).
- Called at startup of BOTH entry points that open the db for serving/running:
  `src/server/index.ts` (server boot, before listen) and the CLI run path
  (`src/cli.ts` — find where it opens repos; if the CLI opens repos in exactly one
  place, call it there). One-line startup log (`recovered N interrupted round(s)`).
- Tests: seed rounds in every status → call → only non-terminal flipped to
  `failed`; returns the count; complete/failed untouched; empty db → 0.

## 4. Setup-time knobs (server)

### 4.1 `GET /api/models`
- Starts an ephemeral server (`startServer` defaults — PATH lookup, no flags),
  calls `discoverModels(client)`, stops the server in a `finally`, returns
  `200 { models: string[] }` (pass through discovery order; no sorting/filtering —
  the client does presentation).
- Failure (no binary, timeout, discovery throw) → `502 { error }` with the
  underlying message (honest degradation; the UI falls back to free text).
- Process-level cache: successful results cached 60s (module-local
  `{ at, models }`); failures NEVER cached. One-line WHY (spawning a server per
  keystroke is the cost being avoided; staleness window is harmless for a model
  list).
- Tests: unit with a fake starter (parameterize the starter — default `startServer`
  — so no daemon needed): shape passthrough, 502 on starter throw, cache hit
  serves without a second start, failures not cached (two calls → two starts).
  NO e2e (environment-dependent by nature: 200 where opencode exists, 502 where
  it doesn't — never pin environment in e2e).

### 4.2 `RunSpec` extensions (all optional, all validated)
- `selection`: add `eliteCount: z.number().int().min(0)`,
  `topPct`/`bottomPct: z.number().finite().min(0).max(1)` to the existing partial
  (crossoverPct stays). Rationale for [0,1] (stricter than selection.ts's
  finite-only): API boundary kindness; `bottomPct: 0` stays legal (the design's own
  no-cull A/B).
- Cross-field rule in `parseRunSpec` (so PATCH inherits it): `eliteCount >
  Math.max(1, Math.floor(population * topPct))` → throw, mirroring
  `selection.ts:54-58` message style (`eliteCount (X) cannot exceed the top band
  size (Y)` — same words, computed from spec fields).
- `concurrency: z.number().int().min(1).max(64).optional()` (upper bound is a
  typo-guard, not tuning — one-line WHY; the provider rate-limits real
  parallelism anyway).
- `pricing: z.record(z.string().min(1), z.object({ inPerM: z.number().nonnegative(),
  outPerM: z.number().nonnegative(), cacheReadPerM: z.number().nonnegative(),
  cacheWritePerM: z.number().nonnegative() })).optional()` (shape check; deep
  validation stays at `createRun` preflight).
  FOUR keys, not two: the engine's `assertPrice` fail-closes on missing cache
  rates ("omitting them prices the bulk of a run at zero" — budget.ts), so a
  2-key shape (as the design §17 sketch shows) would make every custom-priced run
  fail at creation. The §17 sketch is stale; the engine is the authority.
- `criteria`: NO schema change (already nullable). Verify `parseRunSpec`'s return
  object actually carries `criteria` through (if the return literal drops it, add
  it — accepted-but-dropped today; one line).
- `runConfigFor`: add `concurrency: spec.concurrency ?? DEFAULT_CONFIG.concurrency`
  and `pricing: { ...DEFAULT_CONFIG.pricing, ...spec.pricing }` (selection flows
  via the existing wholesale spread — verify, don't duplicate).
- Tests (run-spec.test.ts): each new field accepts/rejects at the boundaries
  (eliteCount -1, topPct 1.5/NaN, bottomPct 0 accepted, concurrency 0/65 rejected,
  pricing negative rejected); cross-field rule fires (elite 5, pop 4, topPct 0.2)
  and passes (elite 1, pop 4, topPct 0.2); criteria round-trips through the return.

### 4.3 PATCH extensions (no engine changes)
- Schema: `selection` partial gains the three fields (same shapes as §4.2);
  top-level `concurrency` (1..64) and `pricing` (record shape) `.partial().optional()`.
- Merges mirror the existing lines (+ the 4d selection default-fill pattern):
  `selection: { ...DEFAULT_CONFIG.selection, ...run.config.selection,
  ...patch.selection }`, `concurrency: patch.concurrency ?? run.config.concurrency`,
  `pricing: { ...run.config.pricing, ...patch.pricing }`.
- Engine effect (no code — state it in a comment at the merge site so the next
  reader doesn't wonder): concurrency/selection/pricing are all re-read per round
  through the 4b `reconfigure` swap.
- Tests (api.test.ts inject): PATCH each knob → stored config carries it; PATCH
  eliteCount violating the cross-field rule → 400; PATCH concurrency 65 → 400.

## 5. Setup screen (web only)

- `RunSetup`: criteria textarea (optional, placeholder "auto-generate from goal");
  selection inputs (eliteCount/topPct/bottomPct/crossoverPct, prefilled from
  `DEFAULT_CONFIG.selection` — import already exists in the file);
  concurrency input (prefilled 8); pricing textarea, one
  `modelId inPerM outPerM cacheReadPerM cacheWritePerM` per line (mirror the
  roster parser's style + inline error convention; skip blanks; wrong arity /
  non-numeric / negative → inline error naming the line; all four rates required
  per the §4.2 pricing rule — the engine fail-closes without cache rates).
- Model `<datalist>` fed by `GET /api/models` (fetch on setup mount; failure →
  free text still works — the inputs stay plain text with datalist enhancement,
  never a blocking select). Attach the datalist to BOTH the roster textarea's
  model position (best-effort: datalist on a text input can't target one line —
  attach to the temperature... no. Honest approach: datalist backs a separate
  "model" text input ONLY where the input is single-model (the add-agent form's
  model select could become a datalist input too — out of scope; keep roster
  textarea free-text). DECISION (controller, to avoid a fiddly mismatch): the
  datalist backs the pricing textarea's model column via a small "insert model"
  affordance? NO — simplest honest: a read-only "known models" `<details>` list
  under the roster field (copy-paste source) + free-text inputs everywhere. Zero
  fiddliness, full value. (If the implementer sees a cleaner datalist wiring that
  stays graceful, they may take it with a ledger note.)
- `web/src/api.ts`: `listModels(): Promise<string[]>` (throws the server's 502
  message verbatim); `FullRunSpec` gains `criteria`, `selection`, `concurrency`,
  `pricing` iff absent (check first — additive only).
- `App.tsx`: hold setup criteria as pending-first-round state; the FIRST
  `startRound` after a setup-created run includes it as `criteriaMd` (later rounds
  default to null/auto unless the RoundControls criteria box says otherwise).
  Document the limitation in a comment: reload before round 1 loses the pending
  criteria (single-session dashboard; rounds own criteria).
- Tests: parser unit tests from the root suite (pricing line parser: valid line,
  blank skip, bad-number line error with line number, negative rejection;
  mirror the roster-parser test location/pattern — grep where the roster parser
  is tested and co-locate). No new web harness.

## 6. Testing + gate

- **Unit:** recovery helper (all statuses → only non-terminal flipped + count);
  run-spec boundaries + cross-field rule; pricing parser cases.
- **API (inject):** `GET /api/models` with fake starter (shape/502/cache/no-cache-
  on-failure); PATCH knob flows + 400s; POST accepts the extended spec (201 with
  eliteCount/topPct/pricing/concurrency/criteria carried — assert acceptance, and
  that `runConfigFor` output feeds `createRun` — the compose path already covers
  derivation; keep it to acceptance + one derivation pin).
- **E2E guard (dashboard.e2e.test.ts, append-only):** POST accepts criteria
  (201; server-side it rides to the first round via the CLIENT in production —
  assert 201 + snapshot unaffected, not the client flow); recovery NOT in e2e
  (boot-time, covered by unit).
- **Gate every task:** `npm test` (0 failed; 2 pre-existing daemon-gated skips),
  `npm run typecheck` exit 0, `npm run web:build` exit 0.

## 7. Spec coverage map

- Design §15 crash recovery → §3 (rounds failed; workspaces preserved by
  construction; containers via existing creation sweep — the adopt/recreate half
  explicitly not built, single-server-per-db assumption documented).
- Design §14 setup (criteria, selection ratios, concurrency, price table) →
  §4.2 + §5.
- Design §13 `GET /api/models` → §4.1 (ephemeral-server + cache + honest 502).
- Risk-table `diversityFloor` → explicitly NOT built (needs A/B evidence first).
- Setup criteria → client-side default for round 1 (§5 + `RunSpec.criteria`
  passthrough verified in §4.2); no server storage (rounds own criteria).