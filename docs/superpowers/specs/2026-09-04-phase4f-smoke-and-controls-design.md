# Phase 4f — Smoke findings + remaining evolution controls

Status: approved for planning
Provenance: the first real end-to-end run (docker, 2 agents × 1 round, haiku goal,
2026-09-04) COMPLETED and scored (mean 41 / best 82), and surfaced three
robustness bugs plus three deferred evolution controls. The green run itself is the
acceptance baseline: every item below must keep a real round green.

## 1. Goal and non-goals

Fix what the smoke proved broken (process hygiene around real runs) and build the
three remaining evolution controls (diversityFloor, LLM-recombine crossover,
session-level abort).

In scope (§2–§5): 6 items.
Out of scope (stay out):
- Mid-JUDGE-call abortion (provider-level abort doesn't exist; the call finishes in
  seconds — §5 documents this boundary honestly).
- Container adopt-or-recreate on boot (ruled out in 4e §1).
- A second smoke configuration (one green docker run is the gate; local-mode
  parity rides the same code paths minus the shard layer).

## 2. Verified facts (state of the world, 2026-09-04 smoke)

- `agent-runner.ts:112-126`: the prompt/timeout `Promise.race` creates
  `setTimeout(reject, ctx.timeoutMs)` with NO handle and NO clear — every
  successful agent run leaves a `timeoutMs` (default 600s) timer holding the
  event loop. The CLI printed final results then hung ~10 min. (The driver's own
  race timer has the `finally`-clear with an explicit comment about this exact
  hang — the runner lacks it.)
- `startServer` (`src/runtime/opencode/server.ts`) inherits the parent env: a
  shell exporting `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD` (leaked
  here by the desktop-app session) makes every spawned `opencode serve` demand
  Basic auth our client never sends → 401 on all validation probes. Observed live.
- The workspace root must pre-exist: opencode `realpath`s the session directory
  and 500s when missing (observed: `ENOENT .../work`). The app never creates it.
- `validateRosterModels` all-workers-fatal fired correctly on the 401s (4b §4
  machinery working in production as specified) — no change needed.
- Post-round teardown is sound: shards stopped, no `arena-*` residue, host server
  stopped (its orphan in the log analysis was a pre-existing desktop-app process,
  not ours).
- `diversityFloor` (risk-table Phase 5 item): no code exists; needs the mechanism
  (evidence of benefit stays a future A/B, but the knob must exist to run one).
- Crossover is deterministic line-split only (4d §7 ponytail note names
  LLM-recombine as the upgrade path).
- Abort is cooperative at dispatch/phase boundaries only (4d §8); in-flight agent
  sessions cannot be stopped (no session tracking in the driver).

## 3. Smoke-hardening fixes (process hygiene)

### 3.1 Clear the runner's race timer
- `agent-runner.ts:112-126`: capture the timeout handle, `clearTimeout` in a
  `finally` around the race (mirror `driver.ts:310-313`, including the WHY
  comment about holding the process open).
- Test (runner test file, fake timers): mock `client.prompt` resolving
  immediately with `timeoutMs: 600_000` → after `run` settles,
  `vi.getTimerCount() === 0`. Plus the existing behavior tests stay green.
  (Deterministic, no wall-clock wait.)

### 3.2 Scrub server-auth env in `startServer`
- `server.ts` spawn: `env: { ...process.env }` minus `OPENCODE_SERVER_USERNAME`
  and `OPENCODE_SERVER_PASSWORD` (delete from a copy — clearest; do NOT
  allowlist-strip anything else). WHY comment: our client never sends Basic
  auth, so inherited server-auth env can only 401 our own spawned servers;
  loopback-only plumbing must not depend on ambient credentials.
- Test (server.test.ts pattern): spawn with the two vars set in `process.env`
  (save/restore around the test) → child sees neither (assert via a fixture
  command that prints its env? simplest: preloaded `node -e` printing
  `!!process.env.OPENCODE_SERVER_PASSWORD`... but `startServer` hardcodes
  `serve` args — reuse the file's existing fixture-command pattern; if the
  harness can't echo env, assert on the spawn-call args via the
  `child_process` mock passthrough from the 4d Task-1 tests).

### 3.3 Create the workspace root
- Where the workspace root first enters the system (CLI startup after spec parse
  + `composeRun` after validation — pick the EARLIEST common point that both
  paths share; likely top of `composeRun`... but composeRun is also called with
  mock roots in tests — `mkdir -p` on a mock path is harmless (fs call in
  composition; the existing seams already touch fs? check — if compose must stay
  fs-free, do it in the CLI + server POST handler instead. Implementer's call
  with a ledger note): `mkdir -p`, and on failure throw the existing
  fail-loud validation error style (`workspace root ...: <reason>`).
- Test: compose/CLI with a non-existent nested root → directory exists after;
  failure (e.g. a FILE at that path) → clear error before any server starts.

## 4. diversityFloor (selection + breed + config)

- New optional knob `diversityFloor: number` (default 0 = off): after culling is
  computed, if `diversityFloor > 0`, rescue the single culled agent with the
  HIGHEST mean pairwise strategy distance to the rest of the population
  (word-set Jaccard distance — reuse Task-1-4c `strategyDiversity` pairwise
  machinery via a small exported helper, do NOT duplicate tokenization):
  it survives (as a survivor with reflection like the rest) and the lowest-ranked
  non-elite, non-rescued survivor is culled in its place (population invariant
  holds; elite band untouched — the floor never deletes elite).
- Config: `RunConfig.selection.diversityFloor` (default 0) + `RunSpec.selection`
  + PATCH (same additive pattern as 4d Task 3; validation: finite ≥ 0... upper
  bound? It's a count-floor of 0/1 effectively — spec as `z.number().min(0).max(1)`
  int? Mechanism rescues AT MOST ONE agent (the max-distance one) — so boolean-ish.
  DECISION: `diversityFloor: boolean` default false. Simpler, honest: on/off.
  Hmm — risk table says "protecting the most distinct low performer" (singular).
  Boolean it is.)
- `SelectionPlan` gains `rescued: string[]` (empty when off/empty) — update all
  construction sites (compiler-aided, 4d precedent). Breed: rescued agents are
  survivors (mutated genome path — NO breed change needed if selection moves the
  id from culled to survivors... but the plan must still RECORD who was rescued
  for transparency (snapshot? events? — record in the plan only; the UI shows
  bands already... does the snapshot carry band? SnapshotScore has band. Rescued
  agents keep their judged band (they WERE bottom band) — honest. No snapshot change.)
- Wait — subtle: rescuing changes WHO gets culled (bump the lowest survivor).
  The replacement (clone/crossover) slots derive from culled[] AFTER the swap
  (implement in planSelection: compute culled, then swap, then derive clones/
  crossovers from final culled — order matters, comment it).
- Tests (selection.test.ts): off → byte-identical plans; on with distinct
  strategies → most-distinct culled survives + lowest survivor culled + same
  total; on with identical strategies (all distances 0 — tie → first max wins,
  deterministic); elite never bumped (elite-adjacent edge: floor can't touch
  elite even if elite is most distinct — assert); empty plan shape.

## 5. Session-level abort (driver + runner + manager)

Boundary (honest, documented in code + UI copy): aborts IN-FLIGHT AGENT SESSIONS;
an in-flight JUDGE call finishes (seconds); queued phases still gate-skip per 4d §8.

- Runner: track `sessionId` per in-flight agent (the `LiveRun` map already holds
  `sessionId` — reuse it); new `abortAgent(agentId): Promise<void>` — abort the
  session via `client.abort` (existing method, 5s timeout) and remove from the
  map ONLY after `done` settles or a short grace (mirror `quiesce` semantics —
  reuse `quiesce` itself if it fits: quiesce aborts + waits with grace. DECISION:
  implement `abortAgent` AS `quiesce` + map deletion; no new wait primitive).
- Driver: `abortRound` (4d flag) now ALSO aborts every in-flight agent session:
  iterate the runner's live sessions (needs a runner method —
  `abortAll(): Promise<void>` on the runner interface; mock + local + docker
  runners... check how many AgentRunner implementations exist — Mock + OpenCode
  runner presumably; add to the interface + both). Order: set flag, abort
  sessions, then existing gates skip subsequent phases. The RUN-pool
  `shouldStopDispatch` + in-flight abort compose: queued stop, live abort.
- Manager/endpoint/UI: UNCHANGED (same `abortRound` route, same 202; UI copy
  already honest — "Queued agents stop; in-flight agents finish" — hmm, now
  in-flight agents get ABORTED, so update the copy to "Abort requested. Running
  agents are stopped; the round is marked failed." — web copy change + confirm
  dialog).
- Tests: driver abort-mid-RUN with mocks (runner spy: session aborted via client,
  round failed, judge never called — deterministic via the 4d concurrency-1
  pattern); runner `abortAll` unit (aborts tracked sessions, clears map,
  unknown-agent safe); API/UI unchanged-behavior (no new endpoint tests; abort
  route tests stay green).

## 6. LLM-recombine crossover (breed + reflector-style call)

- New path in `breed` (or a `recombine` helper beside it): when `crossoverPct`
  yields crossover slots AND `config` allows (always — no new flag; the operator
  is already gated by pct > 0), build each crossover child via ONE structured
  LLM call instead of line-split: prompt = both parents' strategies + goal,
  strict JSON `{ strategy_md, notes_md }` (reuse `parseWithRepair` +
  `json_schema` pattern from judge/reflect — read it first), model =
  `config.reflect.modelId` (the mutation model — documented WHY: recombination
  is a mutation-shaped task), temperature = A's.
- Fallback (load-bearing): malformed/failed call after the standard retry →
  deterministic line-split (4d §7.2 rules verbatim) + notes provenance prefixed
  `Crossover of A × B (recombine failed, split merge).` — a crossover slot must
  NEVER fail a round (same philosophy as reflection carry-forward).
- Provenance/parentage/model/temp/label rules UNCHANGED from 4d §7.2 (only the
  text-generation step changes).
- Cost: one LLM call per crossover child per round (bounded by culled count;
  default pct 0 → zero calls — unchanged default behavior).
- Tests (breed.test.ts + mock provider): recombined text used verbatim on success;
  malformed JSON → repair attempt → fallback split with the failure prefix;
  provider throw → fallback; pct 0 → no provider call at all (zero-cost default
  pinned).

## 7. Testing + gate

- **Unit:** runner timer-count; env scrub (child sees neither var); mkdir-p
  (created + file-in-the-way error); diversityFloor cases; recombine
  success/repair/fallback/no-call; abortAll.
- **Driver (mocks):** abort-mid-RUN session abort + failed + no-judge.
- **API (inject):** diversityFloor PATCH flow (stored config); recombine needs no
  route; abort route unchanged-behavior.
- **E2E guard:** diversityFloor round on mocks (rescued agent survives with
  reflection output); recombine on mocks (child genome from mock provider text,
  origin crossover); abort-mid-RUN e2e stays out (timing — inject covers it).
- **Acceptance: a second real docker smoke (1 round, 2 agents) goes green
  end-to-end AND the CLI process exits on its own within 60s of printing
  results** (the §3.1 timer fix is proven by exit, not by code inspection).
- **Gate every task:** `npm test` (0 failed; 2 pre-existing daemon-gated skips),
  `npm run typecheck` exit 0, `npm run web:build` exit 0.

## 8. Spec coverage map

- Smoke §3.1 timer → Task 1 (runner) . §3.2 env scrub → Task 1 (server).
  §3.3 mkdir-p → Task 1 (startup path). §4 diversityFloor → Task 2 (selection+
  config+tests). §5 session abort → Task 3 (runner+driver+copy). §6 recombine →
  Task 4 (breed+tests). §7 tests+gate → Tasks 1-4 + Task 5 (e2e + real smoke).
- Tasks: 1 (hardening trio) → 2 (diversityFloor) → 3 (session abort) → 4 (LLM
  recombine) → 5 (e2e + REAL SMOKE — the implementer runs the docker smoke per
  the §7 acceptance including the 60s-exit proof; credentials/auth come from the
  operator's environment — document the exact command + env assumptions in the
  ledger).