# Phase 4f Implementation Plan — Smoke hardening + evolution controls

Spec: `docs/superpowers/specs/2026-09-04-phase4f-smoke-and-controls-design.md`
(commit `9fcc93d`). When the plan and spec disagree, the spec wins — flag the
disagreement, don't silently pick.

## Global constraints

- **Gate (run after EVERY task, all three):** `npm test` (0 failed; 2 pre-existing
  daemon-gated e2e skips), `npm run typecheck` (exit 0), `npm run web:build` (exit 0).
- **No new dependencies**. No schema/migration changes.
- Driver changes limited to spec §5 (abort-session wiring) — nothing else in
  `src/engine/driver.ts`. No CLI behavior change beyond §3.3's mkdir-p.
- Test layout: flat root vitest suite; web untouched in this phase (one web COPY
  change in Task 3 — no logic). API tests via fastify `inject` + in-memory repos.
- Comment-dense WHY style; `ponytail:` where the spec names a ceiling.
- One commit per task, message style per `git log --oneline -10`.

## Verified starting points (read these first)

- `src/runtime/opencode/agent-runner.ts:85-190` (`run` + `quiesce` + `LiveRun` map;
  the `:112-126` race is the timer bug) + its test file (fake-timer pattern?
  check — Task 1 needs `vi.getTimerCount` or equivalent).
- `src/runtime/opencode/server.ts:38-88` (spawn env + `stop()`).
- `src/server/compose-run.ts` top + `src/cli.ts` repos-open site (Task-1-4e
  `recoverIncompleteRounds` call neighborhoods — §3.3 placement decision).
- `src/core/selection.ts` IN FULL + `test/core/selection.test.ts` (Task 2 extends).
- `src/evolution/breed.ts` + `test/evolution/breed.test.ts` (Task 4 extends) +
  `src/judge/judge.ts` `resolveCriteria`/`score` + `parseWithRepair`
  (`src/judge/parse.ts`? grep — Task 4 reuses the structured-call pattern).
- `src/engine/driver.ts` `runRound` (abort flag + gates from 4d Task 6 — Task 3
  extends) + `test/engine/driver.test.ts` (deterministic abort patterns).
- `src/runtime/opencode/agent-runner.ts` interface consumers: grep
  `AgentRunner` implementations (Mock + OpenCode — Task 3 adds `abortAll` to the
  interface + both).
- `web/src/components/RoundControls.tsx` abort copy + `web/src/App.tsx` abort
  message (Task 3 copy change only).

---

## Task 1 — Smoke-hardening trio (runner timer + env scrub + mkdir-p)

**Files:** `src/runtime/opencode/agent-runner.ts` (+ test),
`src/runtime/opencode/server.ts` (+ test), startup-path file for mkdir-p (+ test),
`test/...` mirrors.

1. Runner race timer (spec §3.1): capture the `setTimeout` handle at
   `agent-runner.ts:123-125`, `clearTimeout` in a `finally` around the race —
   mirror `driver.ts:310-313` INCLUDING the WHY comment about holding the process
   open. Test with fake timers: mock `client.prompt` resolving immediately,
   `timeoutMs: 600_000` → after `run` settles, timer count is 0
   (`vi.getTimerCount()` or the file's fake-timer idiom — check first).
2. Env scrub (spec §3.2): spawn env deletes `OPENCODE_SERVER_USERNAME` +
   `OPENCODE_SERVER_PASSWORD` from a copy of `process.env` (nothing else).
   WHY comment: our client never sends Basic auth; ambient server-auth env can
   only 401 our loopback plumbing. Test via the 4d-Task-1 fixture/mock pattern:
   with both vars set in `process.env` (save/restore), the spawned child sees
   neither.
3. mkdir-p (spec §3.3): earliest common point shared by CLI + server POST paths
   (investigate: top of `composeRun` vs CLI/server call sites — composeRun is
   called with mock roots in tests, so a real `mkdirSync(recursive)` there must
   be mock-safe... `fs.mkdirSync(path, {recursive:true})` on an existing dir is
   a no-op, and on mock paths creates tiny dirs — acceptable? The cleaner
   alternative is CLI-startup + POST-handler. DECISION RULE: prefer the single
   shared point if its tests stay hermetic; else the two call sites. Ledger-note
   the choice). Failure → throw the file's fail-loud validation-error style
   before any server starts. Test: nested non-existent root exists after;
   file-in-the-way → clear error, no server started (assert via seams/fakes —
   no daemon).

Gate. Commit: `fix: smoke hardening — runner timer, env scrub, workspace mkdir`.

## Task 2 — diversityFloor (selection + config)

**Files:** `src/core/selection.ts` (+ test), `src/server/run-spec.ts`,
`src/server/api.ts` (PATCH schema only), `src/server/compose-run.ts`
(only if runConfigFor needs a line — selection spreads wholesale, verify),
`src/core/types.ts` (DEFAULT_CONFIG only if the selection block needs the key —
it does: `diversityFloor: false`).

Per spec §4: `diversityFloor: boolean` default false (NOT a number — decided).
`SelectionPlan` gains `rescued: string[]` (all construction sites updated,
compiler-aided). Mechanism: after culled is computed, when on, compute each
culled agent's mean pairwise word-set Jaccard distance (reuse the 4c
`strategyDiversity` pairwise machinery — READ `src/core/analytics.ts` first and
export a small helper from it rather than duplicating tokenization); rescue the
max (deterministic first-max tie-break); bump the lowest-ranked survivor
(last element of the survivors slice) into culled; derive clones/crossovers from
FINAL culled (order matters — comment it); elite untouched by construction
(rescue/bump operate strictly below the elite slice — assert it in a test).
Breed UNCHANGED (rescued flow through the survivors/mutated path; verify by
reading breed's survivor loop — no edit needed).
Config: `RunConfig.selection.diversityFloor`, `RunSpec.selection` optional
boolean, PATCH partial (same additive pattern as 4d Task 3; no engine code —
planSelection reads config at EVOLVE through the existing swap).
Tests (selection.test.ts, write first): off → byte-identical; on + distinct →
rescued max-distance + bumped lowest-survivor + same totals + clones derived
from final culled; all-identical tie → deterministic first; elite most-distinct
→ elite kept, rescue among culled only; empty plan shape carries `rescued: []`.
One inject test: PATCH diversityFloor stored (mirror crossover PATCH test).

Gate. Commit: `feat: diversityFloor — rescue the most distinct culled agent`.

## Task 3 — Session-level abort (runner + driver + copy)

**Files:** `src/runtime/opencode/agent-runner.ts` (+ Mock twin — grep ALL
`AgentRunner` implementations), `src/engine/driver.ts` (abort wiring only),
`test/engine/driver.test.ts`, runner test file(s), `web/src/components/
RoundControls.tsx` + `web/src/App.tsx` (copy strings only).

Per spec §5 (boundary: in-flight JUDGE finishes; no new failure mechanism):
1. Runner: `abortAll(): Promise<void>` on the `AgentRunner` interface — aborts
   every tracked session (reuse `quiesce` per agent: abort + grace-wait) then
   clears them from the map; unknown/empty → no-op success. Implement in the
   OpenCode runner + the Mock runner (mock tracks its own in-flight the way the
   file already does — read it; keep the mock honest: record aborted ids for
   assertions). NO new wait primitive.
2. Driver: `abortRound` (4d flag) now ALSO calls `await this.d.runner.abortAll()`
   (after setting the flag, before returning — read the 4d method; keep its
   boolean contract). Existing gates skip subsequent phases unchanged.
3. Copy (web, strings only): confirm dialog + success message → "Abort
   requested. Running agents are stopped; the round is marked failed." (spec
   wording — both `RoundControls.tsx` confirm and `App.tsx` message).
4. Tests: runner `abortAll` unit (tracked sessions aborted via client spy, map
   cleared, empty safe); driver abort-mid-RUN (4d concurrency-1 pattern:
   runner session-abort spy called, round failed, judge never called —
   deterministic); API/UI unchanged-behavior (existing abort route tests green,
   no new endpoint tests).

Gate. Commit: `feat: abort in-flight agent sessions on abortRound`.

## Task 4 — LLM-recombine crossover (breed)

**Files:** `src/evolution/breed.ts` (+ test), possibly a small
`src/evolution/recombine.ts` (your call — one new file max), NO config file
changes (gated by existing `crossoverPct > 0`), NO driver changes (breed
signature unchanged).

Per spec §6: for crossover slots, ONE structured LLM call per child (prompt =
both parents' strategies + goal; strict JSON `{ strategy_md, notes_md }` via
the existing `parseWithRepair` + `json_schema` pattern — read judge/reflect's
usage first and mirror the retry count); model = `config.reflect.modelId`
(requiresBreed access to config — check what breed receives today: `BreedInput`
has repos/runId/idx/plan/mutated, NO config. Threading needed: add an optional
`recombine?: { modelId, goalMd, provider/client... }` — read how reflect gets
its provider (driver passes it?) and mirror the narrowest threading that works;
document the choice in a ledger note).
Fallback (load-bearing, must be tested): malformed/throw after standard retry →
deterministic 4d split-merge + notes prefixed `Crossover of A × B (recombine
failed, split merge).` — a crossover slot NEVER fails a round.
Provenance/parentage/model-temp/label rules UNCHANGED from 4d §7.2.
Cost note in a comment: one call per crossover child; pct 0 → zero calls
(pin it: pct-0 test asserts the provider spy was never called).
Tests (write first, mock provider): success text used verbatim; malformed →
repair → fallback prefix; throw → fallback; pct 0 → no call.

Gate. Commit: `feat: LLM-recombine crossover with split-merge fallback`.

## Task 5 — E2E guards + REAL SMOKE + full gate

**Files:** `test/server/dashboard.e2e.test.ts` (append-only) + the smoke run
itself (operator-executed, documented in the ledger).

1. E2E (mock, append-only): diversityFloor round (rescued agent survives with
   reflection output, population constant); recombine child on mocks (genome
   from mock-provider text, `origin: 'crossover'`); abort-mid-RUN stays
   inject-only (timing — covered in Task 3).
2. REAL SMOKE (acceptance, spec §7): docker, 1 round, 2 agents, free-tier
   workers, DeepSeek judge (mirror the 2026-09-04 green run: haiku-scale goal,
   `--db` to a temp file): asserts (a) round completes with real scores,
   (b) NO `arena-*` residue (`docker ps`), (c) **the CLI process exits on its
   own within 60s of printing results** (the §3.1 fix proven by exit, not
   inspection — timestamp the result print and the process exit).
   Credentials/auth come from the OPERATOR's environment (document the exact
   command + env assumptions in the ledger `## Task 5` section — auth-file path,
   required images/binaries, free-tier models used). If operator credentials are
   absent, record the skip explicitly with the reason — do NOT fake it.
3. Full gate: `npm test`, `npm run typecheck`, `npm run web:build`. All green.

Commit: `test: e2e guards for floor/recombine plus real-smoke acceptance`.

---

## Out of scope (do NOT start)

Per spec §1: mid-JUDGE-call abortion, container adopt/recreate, second smoke
configuration, local-mode parity work.

## Spec coverage check

- §3.1 timer → Task 1. §3.2 scrub → Task 1. §3.3 mkdir-p → Task 1.
  §4 floor → Task 2. §5 session abort → Task 3. §6 recombine → Task 4.
  §7 tests+gate → Tasks 1-4 (unit+inject), 5 (e2e + real smoke), gate every task.