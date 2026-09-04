# Phase 4e Implementation Plan — Recovery, setup knobs, model discovery

Spec: `docs/superpowers/specs/2026-09-03-phase4e-gaps-design.md` (commit `dca9804`).
When the plan and spec disagree, the spec wins — flag the disagreement, don't silently pick.

## Global constraints

- **Gate (run after EVERY task, all three):** `npm test` (0 failed; 2 pre-existing
  daemon-gated e2e skips), `npm run typecheck` (exit 0), `npm run web:build` (exit 0).
- **No new dependencies**. No schema/migration changes. No engine behavior changes
  (the driver is NOT touched in this phase — PATCH knob effects ride the 4b
  `reconfigure` swap; verify by `git diff --name-only` showing no `src/engine/*`).
- Test layout: flat root vitest suite; web pure helpers tested from
  `test/web/*.test.ts`; API tests via fastify `inject` + in-memory repos.
- Server shapes from the spec verbatim; 404/400/409/502 messages mirror existing
  conventions. Comment-dense WHY style; `ponytail:` where the spec names a ceiling.
- One commit per task, message style per `git log --oneline -10`.

## Verified starting points (read these first)

- `src/db/repos.ts` (`rounds.create/get/setStatus`, `runs.get`) + `src/db/schema.ts`
  (round statuses live here).
- `src/server/index.ts` (server boot path — find where repos open, before listen)
  + `src/cli.ts` (where the run command opens repos).
- `src/server/run-spec.ts` IN FULL (schema + return literal — check whether
  `criteria` survives into the returned `RunSpec`), `src/server/compose-run.ts:77-89`
  (`runConfigFor`), `src/server/api.ts` PATCH schema (~line 447) + POST /api/runs
  handler + the Task-4d guard idioms.
- `src/runtime/opencode/discovery.ts` (14-line `discoverModels`) +
  `src/runtime/opencode/server.ts` (`startServer`/`stop` — Task-1 of Phase 4d).
- `src/core/types.ts` DEFAULT_CONFIG (selection/concurrency/budget/pricing blocks).
- `web/src/components/RunSetup.tsx` IN FULL + `web/src/api.ts` (`FullRunSpec`,
  `createRunFull`, fetch convention) + `web/src/App.tsx` (setup flow + first
  `startRound` call site).

---

## Task 1 — Startup recovery

**Files:** `src/db/recover.ts` (new) or the repos-adjacent home the codebase
suggests (your call — single small module), `test/db/recover.test.ts` (new),
`src/server/index.ts` + `src/cli.ts` (one call each + log line).

Per spec §3: `recoverIncompleteRounds(repos): number` — single
`UPDATE rounds SET status='failed' WHERE status NOT IN ('complete','failed')`,
return affected count, touch nothing else. WHY comment: single-server-per-db is
already assumed (registry/budgets/tasks are in-memory — a second process can't
drive the first's runs), so failing stuck rows can't strand live work; containers
are left for the creation-time sweep, workspaces preserved by construction.
Call sites: server boot before listen; CLI run path where repos open (grep for the
open site — if more than one sensible site exists, pick the earliest common one
and say which). Log `recovered N interrupted round(s)` (skip the log when N=0 —
quiet boot is the norm; check the file's logging convention first).
Tests (write first): seed all nine statuses → only the seven non-terminal flip;
returns the count; complete/failed untouched; empty db → 0.

Gate. Commit: `feat: fail interrupted rounds at startup`.

## Task 2 — Models endpoint + RunSpec/PATCH extensions

**Files:** `src/server/api.ts` (`GET /api/models` + PATCH schema/merges),
`src/server/run-spec.ts` (schema + return + cross-field rule),
`src/server/compose-run.ts` (`runConfigFor` concurrency/pricing lines),
`test/server/models.test.ts` (new) + extend `test/server/run-spec.test.ts` +
`test/server/api.test.ts` (PATCH pins).

1. `GET /api/models` per spec §4.1: ephemeral `startServer()` (defaults) →
   `discoverModels(client)` → stop in `finally` → `200 { models }` (discovery
   order, untouched). Failure → `502 { error }` with the underlying message.
   Module-local 60s success-only cache (`{ at, models }`, WHY comment per spec).
   Parameterize the starter for tests: `createModelsRoute(startServerFn =
   startServer)`-style or an opts param on the route factory — follow however
   `buildApi` threads its other seams (read it; do NOT restructure `buildApi` —
   smallest seam that works).
   Tests (write first, NO daemon): fake starter returning a canned client →
   shape passthrough; starter throw → 502 with message; two rapid calls → one
   start (cache hit); failing call twice → two starts (failures never cached).
2. RunSpec per spec §4.2: `selection` gains `eliteCount/topPct/bottomPct`
   (shapes as specified); cross-field `eliteCount` vs top-band rule in
   `parseRunSpec` with selection.ts-style message; `concurrency` 1..64 (WHY:
   typo-guard); `pricing` record shape (light); VERIFY `criteria` survives the
   return literal (add it if dropped — one line). `runConfigFor`: add the
   concurrency + pricing lines (selection flows via the existing wholesale
   spread — verify, don't duplicate).
   Tests: boundaries (eliteCount -1, topPct 1.5/NaN, bottomPct 0 accepted,
   concurrency 0/65, pricing negative); cross-field fires/passes; criteria
   round-trips.
3. PATCH per spec §4.3: schema gains the three selection fields + `concurrency` +
   `pricing`; merges with the 4d default-fill pattern
   (`selection: { ...DEFAULT_CONFIG.selection, ...run.config.selection,
   ...patch.selection }`, `concurrency: patch.concurrency ??
   run.config.concurrency`, `pricing: { ...run.config.pricing, ...patch.pricing }`);
   one-line comment noting the engine re-reads all three per round via
   `reconfigure` (no engine code). Cross-field rule arrives free via the existing
   merge→parseRunSpec path (assert it in a test — PATCH eliteCount violating →
   400).
   Tests (inject): each knob stored; cross-field 400; concurrency 65 → 400.
4. Driver UNTOUCHED — verify with `git diff --name-only`.

Gate. Commit: `feat: model discovery endpoint, setup-time RunSpec knobs, PATCH flows`.

## Task 3 — Setup screen controls (web only)

**Files:** `web/src/components/RunSetup.tsx` (controls), `web/src/lib/pricing.ts`
(new, line parser), `test/web/pricing.test.ts` (new), `web/src/api.ts`
(`listModels` + `FullRunSpec` additions iff absent), `web/src/App.tsx`
(pending-criteria flow).

Per spec §5:
1. `parsePricing(text): { pricing, error }` in `web/src/lib/pricing.ts` (mirror the
   roster parser's style + inline-error convention — grep where the roster parser
   lives/is tested and co-locate): one `modelId inPerM outPerM` per line, skip
   blanks, non-numeric/negative/wrong-arity → error naming the line number.
   Tests from the root suite (valid line, blank skip, bad-number + line number,
   negative rejection, extra token).
2. `RunSetup`: criteria textarea (placeholder "auto-generate from goal");
   selection inputs (eliteCount/topPct/bottomPct/crossoverPct prefilled from
   `DEFAULT_CONFIG.selection`); concurrency (prefilled 8, min 1 max 64);
   pricing textarea (placeholder showing the line format); "known models"
   `<details>` list under the roster field fed by `listModels()` (fetch on setup
   mount; failure/empty → the `<details>` block hides itself — free text always
   works; NO blocking select, NO datalist — controller decision, see spec).
   Extend `RunSetupValue` + the `onCreate` payload; validation errors inline
   (roster convention).
3. `web/src/api.ts`: `listModels(): Promise<string[]>` (server 502 message
   surfaces verbatim); `FullRunSpec` gains `criteria`/`selection`/`concurrency`/
   `pricing` ONLY if absent (check first — additive, mirror existing field style).
4. `App.tsx`: hold setup criteria as pending-first-round state; the FIRST
   `startRound` after a setup-created run includes it as `criteriaMd`
   (comment the limitation: reload before round 1 loses it — rounds own criteria).
   Later rounds send null/auto unless RoundControls says otherwise (existing path
   untouched).
5. No server code. No behavior change to existing setup fields.

Gate (tests = pricing parser; bar for the rest is typecheck + build). Commit:
`feat: setup-screen knobs — criteria, selection, concurrency, pricing, models`.

## Task 4 — E2E guards + full gate

**Files:** `test/server/dashboard.e2e.test.ts` (append-only).

In the existing mock run:
1. POST /api/runs with the extended spec (criteria + eliteCount/topPct/pricing/
   concurrency) → 201 (acceptance pin; server-side criteria rides to round 1 via
   the CLIENT in production — assert 201 + snapshot unaffected, not the client flow).
2. `GET /api/models` — DO NOT PIN (environment-dependent: 200 where opencode
   exists, 502 where it doesn't; spec §4.1 forbids pinning it).
3. Recovery NOT in e2e (boot-time; unit-covered in Task 1).
4. Full gate: `npm test`, `npm run typecheck`, `npm run web:build`. All green.

Commit: `test: e2e acceptance for extended run spec`.

---

## Out of scope (do NOT start)

Per spec §1: container adopt/recreate, `diversityFloor`, LLM crossover, mid-call
abort, page-reload criteria persistence, blocking model picker.

## Spec coverage check

- §3 recovery → Task 1. §4.1 models → Task 2. §4.2 RunSpec → Task 2.
  §4.3 PATCH → Task 2. §5 setup web → Task 3. §6 tests → Tasks 1-3
  (unit+inject), 4 (e2e), gate on every task.