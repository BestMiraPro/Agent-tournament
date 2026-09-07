# Agent Tournament: review and implementation handoff

**Audience:** Opus 5 or another implementation agent.  
**Reviewed:** 6 September 2026, commit `de7a431845c86ba0705aafc43d59aa220730ac69`.  
**Handoff finalized:** 7 September 2026.  
**Deliverable:** Review only. No implementation is included. The unfinished source and test edits made earlier in this review were restored to the reviewed commit.  
**Execution preference:** Do inexpensive, focused work first. Leave work that consumes substantial model usage, real tournament calls, repeated whole-project reviews, and extensive browser validation until last.

## 1. Read this before implementing

The most consequential findings concern round recovery, Docker startup, live dashboard state, and whether a remote agent has actually stopped. A passing suite currently misses these behaviors.

This review covered the production code in `src/core`, `src/db`, `src/engine`, `src/evolution`, `src/judge`, `src/runtime`, `src/server`, `src/cli.ts`, and `web/src`, together with relevant tests, configuration, Dockerfile, and operator documentation. Tests were inspected selectively around the behavior under review; this is not a claim that every test or historical design document was read line by line. UI findings come from source inspection, not a fresh visual browser audit. External OpenCode behavior was not retested against a paid provider.

Evidence labels used below:

- **Reproduced:** exercised against the original code using a local test or the existing mock-engine helper.
- **Code-confirmed:** a concrete defect follows from the inspected control/data flow; the stated regression still needs to be written and run.
- **Investigate:** plausible risk or incomplete contract; confirm the trigger before implementing a fix.
- **Recommendation:** an intentional product or engineering improvement, not a proven bug.

Priority is impact, not implementation order. P1 means broken core behavior or an important execution/isolation guarantee; P2 means a meaningful correctness or usability defect; P3 means a smaller usability defect.

### Baseline and constraints

The original `npm test` run passed **809 tests, with 3 skipped**, across **69 passing and 3 skipped test files**. Vitest reported 16.63 seconds. This is newer than the 767/2 baseline recorded in `AGENTS.md`. The output also included Node's existing `DEP0190` warning about `shell: true` with arguments. Typecheck and web build were not completed as part of this review-only deliverable; do not present them as verified.

The three gated files are `test/e2e/real-tournament.test.ts` (`ARENA_E2E`), `test/e2e/docker-tournament.test.ts` (`ARENA_DOCKER_E2E`), and `test/e2e/dashboard-real.test.ts` (`ARENA_DASHBOARD_E2E`). Each requires its flag set to `1`; the newer dashboard gate explains the additional skip.

Preserve these project decisions:

- Node 24, strict TypeScript, ESM, React 19, Fastify 5, Vitest 4, and `node:sqlite`.
- Use the existing two-space style and existing libraries. No new state-management framework or UI dependency is needed for the fixes below.
- Pricing entries require all four rates: input, output, cache read, cache write. Missing pricing is not zero pricing.
- Rejudge remains a non-destructive dry run. Never write replacement scores during rejudge.
- Historical round views show the stored `judgeMode`, not the current configured judge model. A historical model requires its own persisted field/migration.
- Abort is cooperative. Do not promise instantaneous termination. The current runner attempts session aborts; in-flight operations may still need time to finish.
- Keep export/comparison on `buildJsonDump`; do not introduce a parallel comparison endpoint.
- Real workspace roots must be absolute. Preserve caller-owned attached servers during cleanup.
- Follow the current `AGENTS.md`, including RTK command prefixes. Do not commit `.superpowers/sdd/`.

### Usage-conscious implementation order

| Batch | Work | Cost / sequencing |
| --- | --- | --- |
| 1 | B01 API validation; B02 score zero and keyboard interaction; B03 recoverable errors; B04 strategy cap; B05 breach/crossover; B06 failed-round accounting | Small, bounded edits and focused local tests. No real model calls. |
| 2 | B07 round recovery; B08 initial goal; B09 dashboard state; B10 active round controls; B11 stale rejudge | Moderate work. Solve B09 and B10 together; use deferred promises and fake sockets/timers. |
| 3 | B12 Docker planning; B13 concurrent shard startup; B14 late shard bridges; B15 truthful quiescence | Cross-component but daemon-free tests should cover the normal regression cases. B13 is needed before claiming Docker startup is reliable. |
| 4 | B16 filesystem containment; B17 Windows process cleanup; B18 stream parsing; B19 criteria integrity; B20 consistent score presentation | Keep each investigation bounded. OS-sensitive evidence may require the final validation batch. Do not treat delayed validation as permission to claim isolation fixed. |
| 5 | Investigation backlog; optional UX/UI refinements | Confirm one item at a time. Avoid broad refactors until evidence demonstrates the need. |
| Last | One integrated test/typecheck/build gate; targeted browser walkthrough; opt-in real local/Docker smoke tests; any dependency or architecture overhaul | These have the largest usage or operational costs. Do not repeatedly run full tournaments or commission new whole-repo agent reviews. |

Do not use a paid judge to reproduce a reducer bug. Do not run a population of 20 when a 2–5-agent mock fixture demonstrates the same failure. Use larger mock populations only where selection/batching thresholds require them. No need to implement every optional recommendation before returning a useful patch.

## 2. Bugs and concrete implementation tickets

### B01 — Validate request bodies before scheduling work

**P2 · Reproduced · Small**

**Where:** `src/server/api.ts`, legacy `POST /api/runs` and `POST /api/runs/:id/rounds`; corresponding `test/server/api.test.ts` and dashboard integration tests.

The round route casts `req.body` to a TypeScript shape and checks only truthiness of `goalMd`. That does not validate incoming JSON. Both `{ "goalMd": 42 }` and `{ "goalMd": "g", "criteriaMd": {} }` returned **202** in a local regression instead of rejecting invalid input. Invalid values can reach SQLite or prompt construction in a background task. The legacy create route similarly checks truthiness of `name` and `goal`.

**Implement:** Use the existing Zod dependency for runtime validation. Require non-empty string names/goals; allow criteria only as a string, null, or omitted. Decide whether whitespace-only text is rejected using trimming, while preserving meaningful Markdown formatting. Keep valid legacy name+goal requests working. Unknown runs remain 404 and stopped runs remain 409. Validation failures must return 400 without creating a round or scheduling work.

**Acceptance:** Parameterized tests for numbers, arrays/objects, null/missing values, whitespace, valid multiline goals, and nullable criteria. Assert both response status and absence of round rows. Do not test only a mocked validator.

### B02 — Fix zero scores and checkbox keyboard activation

**P3 for score display; P2 for keyboard behavior · Code-confirmed · Small**

**Where:** `web/src/components/RunBrowser.tsx`, row `onKeyDown` around line 76 and best-score cell around line 94.

`r.bestScore ? ... : '—'` displays a valid zero as missing. A Space key pressed on a comparison checkbox bubbles to the row's keyboard handler, which prevents the default action and opens the run. Stopping click propagation on the containing cell does not stop keydown.

**Implement:** Check null/undefined explicitly for scores. Limit row keyboard activation to the row itself (`target === currentTarget`) or use a real Open link/button inside the table and remove the row's button semantics. Preserve native checkbox Space behavior. Do not solve it by disabling keyboard access to the run.

**Acceptance:** Score `0` renders `0.00`; null renders the missing-value mark. Space on a focused checkbox toggles selection and does not open the run. Enter/Space on the intended open control still opens it. A later browser pass can verify the interaction without adding a UI framework solely for this change.

### B03 — Keep navigation and recovery available after errors

**P2 · Code-confirmed · Small**

**Where:** `web/src/App.tsx`, `refresh`, `onRun`, and the early `if (error) return` around line 194; `RunBrowser.tsx` initial fetch error.

A start-round 409 or temporary refresh failure replaces the whole run screen with an error paragraph. Back navigation, retry, and the last useful snapshot disappear. Also, `refresh()` catches its error internally, so `refresh(id).then(() => setView('run'))` changes view even when loading the requested run failed.

**Implement:** Separate initial-load errors, background refresh errors, and action errors. Retain a valid snapshot and show an inline error beside the failed operation. Give initial loading failures Back and Retry controls. Return success/failure from run loading or let the caller handle rejection; switch views only after the requested run loads. Clear a previous refresh error on a successful retry.

**Acceptance:** Failed start leaves the current run and controls visible; retry succeeds without reload. Failed navigation does not show the previous run as the newly selected run. Temporary refresh failure preserves existing data and identifies it as potentially stale.

### B04 — Apply the configured strategy cap to crossover output

**P2 · Code-confirmed · Small**

**Where:** `src/evolution/reflect.ts`, `reflect()` around line 75 versus `recombine()` around line 98; `src/evolution/recombine.ts`; `test/evolution/reflect.test.ts`.

Ordinary reflection applies `capStrategy(..., strategyCharCap)`. Recombination returns `recombineStrategies(...)` directly, allowing crossover to bypass the configured limit and expand subsequent prompts.

**Implement:** Apply the same cap at the common mutation boundary after recombination succeeds. Preserve the returned notes and the existing deterministic fallback behavior. Inspect whether manual/pasted strategies are intentionally uncapped before expanding this ticket to them.

**Acceptance:** A provider returning a 5,000-character strategy under a cap of 100 yields at most 100 strategy characters and preserves notes. Short output and malformed-response fallback retain their existing behavior.

### B05 — Do not call paid recombination after a budget breach

**P2 · Reproduced · Small**

**Where:** `src/engine/driver.ts`, REFLECT guard and `breed()` call around line 594; `src/evolution/breed.ts`; `test/engine/driver.test.ts`.

The driver skips ordinary reflection when `budgetBreach` is set but always passes a paid recombination callback to `breed()`. A mock reproduction with population 10, `hugeTokensFor: 0`, and `crossoverPct: 1` exceeded a 1,000,000-token round cap with 2,000,000 tokens, then made **two recombination calls**.

**Implement:** Supply the recombination callback only while within budget, allowing `breed()` to use its existing deterministic split/merge fallback after a breach. Preserve the completed round's scores, breach report, and viable next generation. This ticket does not redefine which already-running calls may finish or redesign whole-run accounting.

**Acceptance:** With crossover enabled and a triggered breach, no paid recombination or ordinary reflection is dispatched, population is maintained, and valid next-round genomes exist. An otherwise identical within-budget fixture still invokes recombination. Assert child content/lineage as well as call counts.

### B06 — Account for failed rounds' elapsed time and spend

**P2 · Code-confirmed · Small**

**Where:** `src/engine/driver.ts`, success path at line 597 and catch at line 607; `src/db/repos.ts`, `rounds.markEnded` and `submissions.totalCost`.

The success path records `endedAt` and submission cost. The failure path only changes status and emits an event. A judge failure after successful agent work therefore leaves completed spending out of the round's reported cost and leaves its end time unset.

**Implement:** On failure, persist the known submission cost and end timestamp while preserving the original failure. Avoid replacing the useful original error with a secondary cleanup/accounting error. Use the existing cost definition; do not invent unmeasured provider costs. See the separate accounting investigation below for judge/reflect overhead.

**Acceptance:** Force judging to fail after submissions are persisted. The round is failed, endedAt is at least startedAt, and cost equals the persisted submission sum. A failure before any submission records zero known submission cost.

### B07 — Preserve the active population after abort or early failure

**P1 · Reproduced · Moderate**

**Where:** `src/engine/driver.ts`, `runRound()` lines 165 and 182–185; `src/evolution/breed.ts`; `src/db/repos.ts`, genome queries; `test/engine/driver.test.ts`, cooperative abort test around lines 187–213.

`runRound()` advances `lastIdx + 1`, then prepares only agents with a genome exactly at that index. Breeding normally writes the next genomes. Abort or judge failure before breeding leaves none, so all active agents are silently filtered out next time. The observed second-round result was `{ active: 4, round: 2, submissions: 0, scores: 0, status: "complete" }`. Further rounds remain empty. The existing test only checks that the next round completes, which masks this failure.

**Implement:** Define recovery for each active agent before preparation. If no exact genome exists, carry forward its latest valid earlier genome into the new round, preserving strategy, notes, model, temperature, and parent linkage. Persist the new genome so submissions and historical views reference the correct round; do not merely reuse an old object in memory. Do not overwrite an already-created next-round genome after a partial evolution failure. An active agent with no usable history should cause a clear invariant error rather than disappear silently.

Inspect partial breeding failure carefully: some agents might already be retired or children created. A carry-forward fix repairs missing genomes for active agents; it is not automatically a transaction/rollback design for every partial DB write. Keep broader atomic evolution work separate unless the regression exposes a specific need.

**Acceptance:** Abort before judging and then run again: full active population submits and scores. Fail judging twice and verify round 3 still has the full population. Check each submission's genomeId and the persisted parentGenomeId chain. Verify existing next-round mutations are not overwritten. Strengthen the existing abort test rather than duplicating only its status assertion.

### B08 — Persist and return the initial custom goal

**P2 · Reproduced · Moderate; additive persistence change**

**Where:** `src/engine/driver.ts:createRun` (`void initialGoal`, line 114); `src/server/create-dashboard.ts` line 105; `src/server/state.ts:buildRunSnapshot`; `src/db/schema.ts`, `migrate.ts`, `repos.ts`; `web/src/App.tsx` RoundControls goal.

The engine discards `initialGoal`. The default dashboard callback also passes an empty string instead of the requested goal. Before any round exists, the snapshot returns null, and the UI substitutes “Produce the best possible answer.” A create→snapshot regression returned null for “Solve the travelling salesman problem.” The full-spec route also ultimately reaches the discarding engine method.

**Implement:** Add a nullable initial-goal field to the run row with an additive migration for old databases. Thread the value through both creation paths and the engine into persistence. Return the latest actual round goal when a round exists and otherwise the initial goal. Old rows with no recorded goal may retain the fallback. Keep initial goal separate from mutable current goal and do not claim old goals can be reconstructed.

**Acceptance:** Test both legacy name+goal and full-spec POST→GET. Close/reopen a file-backed DB before round 1 and verify the goal survives. Migrate a database created before the new column. After a later round uses another goal, the snapshot returns that latest goal. Update typed fixtures and export expectations where needed.

**Related UX decision:** Setup criteria are explicitly only in React `pendingCriteria` today and disappear on reload before round 1. Decide separately whether to persist initial criteria or label that limitation. Do not silently introduce global criteria that override later rounds.

### B09 — Make dashboard live state belong to one run and reconcile after reconnect

**P1 · Code-confirmed · Moderate**

**Where:** `web/src/useLiveRun.ts`, socket lifecycle around lines 114–145 and hydration around 150–160; `src/server/ws.ts:EventBroadcaster`; `web/src/App.tsx:refresh`; `test/web/live-run.test.ts`.

The server broadcasts every run's events to every socket. The hook dispatches every parsed event without checking runId. Run B can change run A's scores, busy state, and agent activity. Hook state also survives switching runs, and hydration skips empty scores, preserving the previous run's standings in a new unscored run.

Reconnection only sets a socket status; it does not fetch a snapshot. If the socket misses `round.complete`, `live.busy` stays true and App's completion refresh refuses to run. The comments mention polling, but there is no periodic authoritative snapshot refresh in this path.

**Implement:** Filter engine events against the selected run ID before reduction. Reset all run-specific state on run change, including empty scores, activity, breach/error, round status, and busy. Reconcile authoritative state on socket open/reconnect and round start/completion. A small controller seam or reducer actions are sufficient; avoid a new event framework.

Protect asynchronous ordering. A response for run A must not update run B. A snapshot requested before newer live progress must not erase that progress. A round-start response arriving after a round-complete response must not restore busy=true. Use request/run generations and a defined precedence rule; do not rely only on round index because status changes within a round. If a stale response is discarded, ensure a later reconciliation still refreshes authoritative data. Cancel or ignore callbacks after unmount/run change, and clean up reconnect timers.

**Acceptance:** Foreign-run events have no effect. Opening an unscored run clears previous scores. Simulate disconnect→server completes→reconnect and verify idle controls and results recover. Resolve HTTP promises out of order around preparing/scored/complete and verify no rollback. Resolve an old run's request after switching and verify the current run is unchanged. Exercise the actual subscription/controller integration, not just a helper that the hook never calls.

### B10 — Send abort/criteria actions to the active round

**P1 · Code-confirmed · Implement with B09**

**Where:** `web/src/App.tsx`, completion refresh effect around line 122, RoundControls callbacks around 234–262, and RoundDetail props; `web/src/components/RoundControls.tsx`.

App skips snapshot refresh while live.busy. Starting a round does not refresh the snapshot. Both abort and override send `snapshot.lastRoundIdx`, which is still the previous index. During round 1 it is zero, causing a 404; during later rounds it targets a completed row and gets 409. RoundDetail also receives the stale index.

**Implement:** Derive a current active round identity from run-scoped live state and the reconciled snapshot. Use the same identity for labels, round detail, abort, and criteria actions. Do not simply add one to lastRoundIdx: failed and unscored rows count too. Prevent duplicate starts while the POST itself is pending. B09 must prevent an event from another run supplying the active index.

**Acceptance:** With snapshot index 0 and live preparing round 1, both actions target `/rounds/1/...`. Repeat after a completed and after a failed round. A reconnect during a running round reconstructs the correct target. A stale HTTP response cannot revert it.

### B11 — Bind rejudge results to the initiating run and round

**P2 · Code-confirmed · Small/moderate**

**Where:** `web/src/components/RoundDetail.tsx:handleRejudge`, around line 117, and the round selection handler.

The normal detail fetch has an alive guard. The rejudge request has none. Start rejudging round A, select round B, and let A's result arrive: it appears under B's header. Delayed failure and finally callbacks can also change the current round's error/loading state.

**Implement:** Capture run/round/request identity and apply success, error, and completion only if still current. Clear or correctly reset state when switching run/round. Disabling round selection during rejudge is a simpler alternative, but still guard unmount/run changes; retaining navigation is preferable for a long paid operation. Label the result explicitly as a dry run for the selected round.

**Acceptance:** Deferred rejudge response and rejection after a selector change never render under the other round. Current-round results still work. Existing persisted scores remain unchanged.

### B12 — Plan Docker shards before each dashboard round

**P1 · Reproduced integration omission / code-confirmed Docker consequence · Moderate**

**Where:** `src/server/api.ts` per-run RunManager construction around line 274; `src/server/compose-run.ts:ComposedRun.planFor`; `src/runtime/docker/sandbox.ts:planFor` and `shardFor`; `src/cli.ts` per-round planning around line 568.

The CLI invokes planFor with the active agent IDs before every round. The dashboard never invokes it. DockerSandbox refuses provisioning any agent missing from its plan. A daemon-free dashboard regression using a sandbox that required its planning hook showed the hook was never called. Real Docker consequently cannot prepare its competitors correctly.

**Implement:** Run per-round planning as part of the manager's background task before engine preparation. The manager must report busy while planning, catch planning failures, and reject a second round during that interval. Use the current active population every round, including manual adds, retirements, and breeding. A small optional before-round callback is one possible implementation; an explicit sandbox preparation interface is another. Choose one shared contract and document who owns planning to avoid duplicate calls in CLI and dashboard.

Consider abort during asynchronous planning: a newly introduced pre-round await must not lose an abort when engine.runRound clears its flags. Define a pre-start cancellation path or refuse/complete that action consistently. Likewise, do not start a queued round after teardown has begun.

**Acceptance:** Two dashboard-driven rounds prepare and score all planned agents. Population identities change through breeding; the second plan reflects them. Add/retire between rounds and repeat. A deferred or failed planner has correct busy/error behavior. The test must fail if the call site is removed, not merely assert that the sandbox's standalone planFor method works.

### B13 — Deduplicate concurrent startup of a shared shard

**P1 · Code-confirmed · Moderate**

**Where:** `src/runtime/docker/sandbox.ts:provision`, around lines 130–142; `src/engine/driver.ts` PREPARE `runPool`; `test/runtime/docker/sandbox.test.ts`.

Provision checks `containers.get(shardIndex)`, awaits container startup, then stores the result. PREPARE is concurrent. Two agents assigned to one shard can both see no container and start the same container name simultaneously. This is a real caller path, not merely a hypothetical future concurrency change. One start may fail or resource tracking may become inconsistent.

**Implement:** Store/share a pending startup promise per shard before awaiting it. On failure, remove the failed pending entry so a controlled later retry is possible; all current waiters should see the same failure. Retain per-agent directory preparation and live bookkeeping. Ensure disposal cannot lose a container whose startup was pending when shutdown began.

**Acceptance:** With one shard and two concurrent provisions blocked behind a deferred starter, exactly one container starts and both successful handles use its endpoint. Different shards can still start concurrently. One failed start rejects both waiters, does not mark agents live, and does not permanently poison retries. Dispose stops each started resource once.

### B14 — Attach Docker activity bridges when shard servers actually exist

**P2 · Code-confirmed · Moderate; follows B12/B13**

**Where:** `src/server/api.ts` Docker bridge loop around lines 289–294; `src/server/compose-run.ts` initially empty shardServers array and startContainer callback; `test/server/real-modes.test.ts`.

The API iterates shardServers immediately after createRun. In real composition that array is empty; endpoints are appended only when preparation starts containers during a round. No later code attaches bridges. Existing tests inject pre-populated endpoints and therefore miss the real ordering.

**Implement:** Attach a bridge when a shard endpoint becomes available, with a run-scoped lifecycle callback or equivalent narrow hook. A post-PREPARE synchronization can work but misses activity before it runs; define that tradeoff. Deduplicate live endpoints, stop obsolete bridges if a server is replaced, and close all bridges during run disposal. Avoid polling an ever-growing array on every event without cleanup.

**Acceptance:** Create a composed run with no endpoints, make an endpoint appear during preparation, and observe exactly one subscription. A later round reusing the server does not duplicate it. New/replaced endpoints attach correctly and disposal closes every bridge. Use a fake event stream rather than real providers.

### B15 — Distinguish a returned request from a stopped remote agent

**P1 · Code-confirmed · Moderate/high; correctness before optimization**

**Where:** `src/runtime/opencode/agent-runner.ts:quiesce` lines 62–85, `abortAll` lines 96–100, `run` timeout/finally lines 132–195; `src/runtime/opencode/client.ts:request`; `src/engine/capture.ts`; corresponding runner/capture tests.

The runner races the prompt against a timer and unconditionally deletes tracking/resolves done when local run() returns. quiesce treats absent tracking as stopped. Timeout, transport rejection, or abort acknowledgement does not prove the remote tool process stopped writing. abortAll also deletes entries after an unconfirmed quiesce. This undermines the capture guard's stop evidence. A second problem is that the client's fetch deadline can win first with AbortError, while the runner recognizes only its private TimeoutError, reporting a generic error and bypassing its timeout abort path.

**Implement:** Track remote execution evidence separately from local request settlement. Keep uncertain sessions marked unconfirmed after timeout/transport errors. A confirmed terminal response or another documented terminal signal can clear the entry; rejection of the HTTP request cannot. Do not allow a new invocation to overwrite an unresolved session for the same agent/workspace. Normalize owned deadline expiration separately from user cancellation and unrelated network errors.

Bound the entire quiesce operation, including the abort request: today it awaits abort before starting its grace timer, so an unresponsive abort endpoint defeats the advertised bound. Avoid sequential N×grace shutdown where bounded concurrent handling is appropriate. Preserve the fail-closed capture outcome when termination cannot be proven. A status endpoint or other remote confirmation must be verified against the actual supported OpenCode contract before relying on it.

**Acceptance:** A never-completing prompt times out and quiesce remains unconfirmed despite abort acknowledgement. abortAll does not erase that uncertainty. A later confirmed prompt response permits stopped. A hung abort request cannot exceed the chosen grace policy. Test with the real OpenCodeClient and a fake fetch honoring AbortSignal so deadline ordering is exercised. Integrate with capture: uncertain execution must never gain a certified stopped state merely because run() returned.

### B16 — Prevent host file access through workspace symlinks

**P1 · Code-confirmed path-resolution gap; OS-specific reproduction pending · Higher effort**

**Where:** `src/runtime/docker/sandbox.ts:safeJoin/readFile/writeFile` lines 116–122 and 158–168; analogous `src/runtime/local-sandbox.ts` lines 28–34 and 57–67; seed/reset/capture callers.

safeJoin verifies lexical containment, then host filesystem calls follow links. An agent-controlled submission symlink can resolve outside the workspace. In Docker, a link containing an absolute host path need not resolve inside the container to become dangerous when the host follows it during capture. Ancestor-directory links also matter. The OS/container combinations have not been exercised in this review; do not claim a Windows container exploit was demonstrated.

**Implement:** Define a no-escape policy for both reads and writes, including final-component symlinks and ancestor links/junctions. Canonical path checks alone leave a check/use race while another process can mutate the tree. Prefer a snapshot/copy or handle-based approach whose safety is supported on the intended OS; if implementing a conservative no-symlink policy, verify every relevant component and clearly state residual race assumptions. Coordinate with B15 because proven quiescence reduces but does not automatically eliminate other writers. Do not assert that a shared shard is fully isolated.

**Acceptance:** Use harmless sibling fixture files outside the workspace. A linked SUBMISSION.md and a linked parent directory cannot expose or overwrite the sibling fixture. Cover read, write, and capture, not only listFiles, which already skips some links. Normal nested files still work. Add OS-specific coverage for Windows junctions and Linux container-created links only in the final validation batch. Do not read real credentials to demonstrate the bug.

### B17 — Stop owned Windows server process trees

**P2 · Code-confirmed; existing test acknowledges leak · OS-sensitive**

**Where:** `src/runtime/opencode/server.ts:startServer`, shell launch line 54 and child.kill calls around lines 61/92; `test/runtime/opencode/server.test.ts` lines 75–92.

On Windows, the launch uses a shell, and child.kill terminates the shell rather than reliably terminating its server grandchild. The existing startup-timeout test manually kills the surviving grandchild in test cleanup, masking the production leak.

**Implement:** Use a narrowly scoped owned-process-tree shutdown on Windows, or remove the shell layer where executable resolution safely permits it. Await termination with a bounded fallback. Apply the same cleanup to startup timeout and normal stop, make repeated stop safe, and preserve attachServer's no-op stop for a server owned by the user. Never kill by broad process name. Avoid launching visible helper windows.

**Acceptance:** A fixture process writes its own PID, and both normal stop and missing-banner timeout leave that PID no longer alive. Test cleanup is a backstop, not the operation satisfying the assertion. Attached servers stay alive. Account for the existing DEP0190 warning without replacing it with unsafe command-string construction.

### B18 — Parse startup banners across stream chunks

**P2 · Code-confirmed · Small/moderate**

**Where:** `src/runtime/opencode/server.ts:onData`, around line 66, and parseServerPort tests.

Each stdout/stderr chunk is parsed independently. A banner split before the port can be missed and time out; a split within port digits can resolve a truncated port. A stream chunk is not a line.

**Implement:** Buffer stdout and stderr separately, parse complete lines or another unambiguous delimiter, bound retained output, and handle an unterminated final line at stream end if supported. Do not concatenate unrelated halves from different streams. Keep IPv6 banner support and clean up startup listeners/timers appropriately.

**Acceptance:** Split before the host, before the port, and within port digits; all yield the full correct endpoint exactly once. Ignore unrelated log lines. Preserve exit-before-start and startup-timeout handling.

### B19 — Do not record criteria that were not used for scoring

**P2 · Code-confirmed race · Moderate**

**Where:** `src/server/api.ts`, criteria override route around lines 512–535; `src/engine/driver.ts`, resolveCriteria/score around lines 481–488.

The API accepts overrides until a round is complete/failed. Once judge.score is in flight, it already holds resolved criteria. An override can still change the persisted/displayed criteria, making historical evidence disagree with the actual judging prompt. The comment acknowledges this best-effort behavior; it is still a reporting integrity gap.

**Implement:** Establish an explicit freeze point for effective judging criteria. After it, reject overrides with 409 or store them separately as a next-round draft; do not overwrite the criteria associated with the current scores. If refusing all overrides once judging begins is the simpler reliable policy, reflect that restriction in UI copy. A check against a stale browser busy flag is insufficient; the server/engine owns the gate.

**Acceptance:** Pause the judge at a deferred call, submit an override, and verify recorded criteria still match the prompt used. An override before the permitted cutoff is used and recorded. A rejected override leaves the user's text available for the next round.

### B20 — Use comparable rounds in the summary fitness trend

**P2 · Code-confirmed · Small/moderate**

**Where:** `web/src/components/RunSummary.tsx:FitnessSpark` around line 15; `web/src/components/AnalyticsPanel.tsx`; `web/src/lib/sparkline.ts`; RoundStats goalMd/judgeMode/scoreScale fields.

The summary sparkline feeds every round mean into one trend even when goals or score scales change. The larger analytics view already recognizes these distinctions. A transition from judged values to rank-derived scores can look like evolution improved or worsened when the numbers are not comparable.

**Implement:** Share a small comparability rule with the larger chart. Show the latest contiguous comparable segment, visually break incompatible segments, or withhold the trend with a short explanation. Prefer existing stored scoreScale and goal data. Do not infer the historical judge model from current config. The summary's all-time best likewise needs an explicit scope when scores are mixed.

**Acceptance:** A constant-goal/scale fixture retains its trend. A goal change or judge→rank transition does not produce one cross-boundary improvement delta. A one-point final segment shows no trend. Tooltip/accessible label states the segment's scope.

## 3. Focused investigations and engineering improvements

These items are not all reproduced. Verify the trigger and intended contract before changing behavior.

| ID | Location and concern | Next bounded step / desired outcome |
| --- | --- | --- |
| I01 | `server/api.ts` legacy PATCH writes DB config; engine.runRound reads `this.d.config`. No reconfigure occurs on that branch. | Create a real legacy dashboard run, patch concurrency or token cap, then verify execution changes. Decide whether legacy runs support reconfiguration or should refuse it clearly. Do not call per-run reconfigure on a shared engine without checking cross-run effects. |
| I02 | Persisted runs after restart have no registry record or engine budget tracker. POST falls back to the default manager. The driver creates a round before checking for a tracker. | File-backed create/restart/start reproduction. Prefer an immediate, side-effect-free 409 if resume is unsupported. True resume needs explicit runtime reconstruction and cumulative budget recovery; schedule that larger feature last. Do not accidentally run a historical real run through the mock engine. |
| I03 | `RunManager.disposeAll()` iterates only inFlight runs; completed/idle runs may never reach engine.dispose. `createDashboard.shutdown()` does not close its DB and does not explicitly close upgraded WebSocket clients. | Use small local resource fixtures. Define owned run tracking and idempotent shutdown. Stop accepting new work, await selected in-flight work, release all owned resources, close sockets/server, then DB. Confirm outstanding writes finish before DB closure. |
| I04 | DELETE waits for the round before setting stopped/removing registry; a second start may arrive during teardown. | Deferred cleanup test with a concurrent start request. Add a stopping state/guard if reproduced. Preserve the documented graceful stop semantics rather than silently switching Stop into Abort. |
| I05 | `create-dashboard.ts` merges process-level workspace/auth defaults inside composeWith, after api.ts already called strict parseRunSpec. | POST real spec omitting values supplied on the server command line. Move default application before validation if fallback is intended, preserving explicit request precedence and absolute-path checks. Current server entry comments acknowledge the limitation. |
| I06 | `server/event-bridge.ts` parses only LF frame separators, treats each data line as a standalone frame, does not check res.ok, and never reconnects after stream loss. | Test actual supported SSE fixtures: CRLF, multiline data, HTTP error, clean EOF, network failure. Add bounded retry and reader cleanup only to the extent required; stop must cancel retries. Verify OpenCode event shapes before changing session lookup. |
| I07 | `server/api.ts` modelsCache is module-wide and success-only; simultaneous cache misses can each start a server. | Send two deferred concurrent requests and count owned server startups. Coalesce in-flight requests and keep failures retryable. Scope cache to the discovery configuration when multiple dashboards/configurations share a process. |
| I08 | `cli.ts:buildRealDeps` discards runIdHolder and composeRun uses pending timestamp container IDs on this path. Sweeps exclude IDs known only to one orchestrator. | Verify names generated for a CLI run and behavior with two dashboard/CLI owners. Thread stable live IDs consistently. Names alone are weak ownership evidence; labels plus instance ownership may be warranted. Do not broadly sweep another process's active containers. |
| I09 | `runtime/docker/capacity.ts` may use command output without checking exit status/finite numeric values. `stopOnce` records stopped before stop succeeds. | Add fixtures for daemon failure, malformed output, and failed container stop. Surface inability to establish capacity; define an explicit retry policy rather than permanently treating a failed removal as successful. |
| I10 | `runtime/opencode/provider.ts` and capability probes can leave sessions uncertain after HTTP failure. | Reuse the lifecycle policy established in B15. Track and clean up owned probe/provider sessions without conflating an abort response with proof of termination. Start with fake HTTP, defer real probes. |
| I11 | `judge/judge.ts` batched ranking handling may treat omitted entries differently from single-call validation and still assign positive rank-derived scores. | Feed missing, duplicate, and unknown ranking IDs through each path. Enforce a documented complete permutation or an explicit failure policy; do not silently reward malformed output. Avoid changing valid scoring semantics. |
| I12 | Reported cost is largely derived from worker submissions; judge/reflect/recombine providers return text rather than a full usage envelope. | Trace exactly which costs/budgets include orchestration calls and document the scope. First correct UI labels for known versus unpriced spend. Full end-to-end cost accounting requires a provider contract change and should be one of the last, higher-effort tasks. |
| I13 | `server/api.ts` roundStats, agentDetail, run list, and export repeatedly query agents/genomes/scores. | Use synthetic persisted runs to measure query counts/time before optimizing. Prefer a bounded batched repository query and lookup Maps if needed. Avoid introducing a second export representation or speculative caching. |
| I14 | `runtime/mock-provider.ts` extracts only the first line of some strategy text. `api.ts` and `export.ts` duplicate submission serialization. | Test a multiline strategy to decide whether mock behavior distorts experiments. If serialization changes, extract a shared leaf helper imported by both callers, avoiding the current circular-import concern. These are lower-priority maintenance changes. |

## 4. UX and UI changes

These are implementation directions based on source inspection. They are not a claim that the current palette, contrast, or responsive rendering failed a measured browser audit. Preserve the current compact telemetry style, typography, and CSS variables unless visual testing demonstrates a problem.

### U01 — Establish one visible run/round context

Keep run name, execution mode, active round, lifecycle status, and connection freshness together in the header/summary. Distinguish **running**, **reconnecting**, **failed**, **stopping**, and **stopped**; idle alone does not communicate all of these states. Persisted run status should drive reopened views. Work with B09/B10 and I02/I04 rather than inventing independent local booleans.

Acceptance: after navigation/reload/reconnect, the header, controls, grid, and round detail all refer to the same run and round. No stale agent drawer or setup criteria leak into a different run.

### U02 — Make controls explain their actual effect

Use clear labels such as **Run round 3**, **Abort current round**, and **Stop run after current round** when those match the server semantics. Place current-round actions near the status they affect. Show submitting/abort-requested/stopping states and prevent duplicate requests. Do not say “agents are stopped” immediately upon a 202; say the request was accepted and show the eventual outcome. Disable criteria override after B19's freeze point with a short reason and preserve draft text.

Acceptance: every confirmation/status sentence describes a state the backend can establish. Starting, aborting, and stopping are distinguishable without reading documentation.

### U03 — Put failures beside the data they qualify

Implement B03's inline errors with Retry where appropriate. Preserve last good data, but show when it may be stale. A failed unscored round should say **Round failed before scores were recorded**, not the existing generic **Scoring in progress** empty state in RoundDetail. Distinguish empty history, loading, failed fetch, and failed execution. Preserve typed goals and criteria after submission errors.

Acceptance: users can recover from a 409 or temporary network error without a page reload, and an unscored failure cannot appear to be perpetually judging.

### U04 — Improve setup through progressive disclosure

Keep name, goal, sandbox mode, and roster as the primary setup fields. Group pricing, selection percentages, concurrency, and reflection/judge overrides under an Advanced section. Show the effective population count and validation errors next to the relevant fields. Provide a concise creation summary with the selected goal, mode, population, and configured limits. Present resolved server defaults only after I05 defines their behavior.

This is optional product work after the correctness tickets. Do not hide required Docker workspace/auth settings, silently change defaults, or add a broad wizard for a form that can remain one page. Avoid real model discovery on each keystroke.

### U05 — Make comparison selection predictable and accessible

Fix B02 first. Prefer explicit Open controls inside semantic table rows. Keep a visible **Compare selected (0/2)** action with a brief instruction. At two selections, either prevent selecting a third or clearly expose replacement behavior; current silent FIFO replacement is surprising. Preserve selected identities while the list refreshes and show which two runs will be compared.

Acceptance: mouse and keyboard produce the same selection; selection never unexpectedly opens a run; zero scores and unavailable values remain distinct.

### U06 — Give important summaries a truthful scope

Apply B20 to both the sparkline and headline best score. Explain whether a value is for the latest comparable segment, latest round, or full run. Use **Known worker cost** or an **Unpriced** state until I12 establishes total costs. Keep detailed cache token rates in the relevant budget/pricing view, not sprinkled through the main flow. Label rejudge output as a preview that does not replace recorded results.

Acceptance: a user cannot reasonably mistake a changed scoring scale for fitness improvement, incomplete accounting for a free run, or rejudge output for saved scores.

### U07 — Improve information hierarchy without a full redesign

Retain the summary at the top, followed by the active-round controls and progress. Keep long submission prose collapsed behind existing details controls. Provide lightweight in-page navigation to Arena, Standings, Round detail, and Analytics if scrolling remains cumbersome in visual testing. Group operational warnings into a readable expandable list instead of a single joined paragraph. Keep model IDs available in full on focus/expansion when the grid truncates them.

Acceptance: the primary action and current failure are easy to locate at common desktop sizes; deep historical content does not drown out live status. Do not change component architecture solely for visual rearrangement.

### U08 — Verify accessibility and responsive behavior last, then make targeted changes

The CSS already has focus-visible rules, responsive breakpoints, horizontal table scrolling, a full-width mobile drawer, and reduced-motion handling. Preserve those. The final browser pass should check 360/768/1024/1440-pixel widths, 200% zoom, keyboard-only navigation, drawer focus restoration/Escape behavior, long model IDs, multiline errors, large populations, and empty/failed/stopped states. Measure contrast before changing colors. Avoid announcing every high-frequency token update through a live region; announce meaningful lifecycle changes.

Acceptance: primary actions remain reachable, focus stays visible, tables scroll without hiding controls, no horizontal page overflow obscures content, and a screen reader can distinguish status without relying on color. Do not commission screenshots for every state before the inexpensive logic fixes are complete.

## 5. Suggested regression fixtures and review discipline

- Use `test/helpers/mock-engine.ts` for abort, early failure, budget, and population preservation.
- Use `createDashboard()` for default dashboard behavior so tests exercise production wiring. Several old integration tests hand-build object graphs and can miss composition errors.
- For Docker planning/startup, inject only the daemon boundary. Keep the real manager/engine/sandbox logic where it is the subject of the test. Do not pre-populate shardServers in the only bridge test.
- Use deferred promises for lifecycle races. Explicitly control old snapshot/new snapshot, judge freeze, container startup, and delayed rejudge ordering instead of sleeps.
- Use fake timers for retry/deadline tests, restore globals and timers in finally, and avoid pending unhandled promises.
- For file containment and process tests, create harmless owned fixtures and clean them up with verified bounded paths. Never use real secrets or broad process termination.
- Do not retain the earlier unfinished regression files: they were removed with the reverted implementation. This document specifies behavior, not a requirement to recreate those exact test abstractions.
- Each fix should have a regression that demonstrably fails before the change and passes afterward. Assert population, persisted identity, state, and resource behavior rather than just return status or mock existence.
- Inspect existing tests that encode unsafe behavior before preserving them. In particular, “abortAll clears the map” and test-side cleanup of a leaked Windows grandchild are not sufficient correctness criteria.

## 6. Final validation, deliberately scheduled last

During implementation, run only the relevant test files and a typecheck when interface changes warrant it. After the selected tickets are integrated, run the repository's complete gate once:

```powershell
rtk npm test
rtk npm run typecheck
rtk npm run web:build
```

All three must pass before claiming implemented work is complete. The review baseline is 809 passing tests / 3 skips; new regressions should increase coverage without dropping existing tests. Check the actual current gated tests and document each skip rather than changing expectations to force a desired count. Do not update AGENTS.md's historical baseline without checking the integrated suite.

After those checks, do one focused browser walkthrough of the changed flows: two concurrently running mock runs; switch to a fresh run; first-round abort; reconnect after missed completion; recover from an API error; keyboard comparison; rejudge then change round; view a failed round and mixed-scale history.

Only then consider real local or Docker smoke tests, with the user's cost constraints respected. Start with the smallest population that covers the behavior. Use explicit opt-in for real provider spending; ordinary unit/integration tests must stay daemon-free. Real e2e is evidence for environment integration, not a substitute for deterministic race tests. Any broad performance benchmark, full visual redesign, provider usage-accounting overhaul, or true restart/resume feature belongs at the end as a separately scoped task.

## 7. Copyable instruction for Opus 5

> Read this handoff and the current AGENTS.md, verify the base revision/diff, and implement the confirmed fixes in the usage-conscious order above. Start with focused, inexpensive tasks and their regressions; preserve the repository's established semantics. Treat investigation items and optional UX changes as separate scopes requiring evidence, not as permission for a rewrite. Do not re-run a full repository review or start real provider tournaments as the first step. Report which ticket IDs are fixed, which are deliberately deferred, the exact tests run, and any limitations. Run the complete test/typecheck/build gate after integration, then perform the focused browser/optional real-mode checks last. Never claim an isolation or remote-termination guarantee from local request settlement alone.
