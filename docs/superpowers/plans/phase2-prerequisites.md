# Phase 2 Prerequisites

Findings from the Phase 1 final review that were deliberately **not** fixed in Phase 1, because they
only become reachable once real OpenCode agents, a real judge model, and Docker replace the mocks.

Each is verified, not theorized. Fix these before or during Phase 2, not after — several present as
"evolution doesn't work" rather than as an error, which is the most expensive kind of bug in this system.

## Blockers for real agents

**1. Container lifecycle contradicts the driver's shape.**
`src/engine/driver.ts` PREPARE calls `sandbox.provision()` for every agent every round and holds
handles in a function-local Map, so nothing survives the round (measured: 24 provisions for 3 rounds
× 8 agents). Spec §11 requires containers to persist for the life of the run, with PREPARE resetting
`/work` instead. A `DockerSandbox` written against the current contract must either make `provision`
secretly idempotent per agent, or pay full container startup 20× per round.
Decide this **before** `DockerSandbox` is written. Related: `maxContainers: 12` with
`populationSize: 20` is unsatisfiable, since PREPARE provisions the entire population before RUN and
nothing consults `maxContainers`.

**2. PREPARE has no failure isolation.**
It is a plain sequential loop. One `provision` throw at agent 5 of 20 aborts the round before any
agent runs, contradicting spec §15. `runPool` provides this for RUN but PREPARE does not use it.
Docker provisioning failures — port exhaustion, image pull, OOM — are the realistic case.

**3. `agentTimeoutMs` is enforced by nothing.**
The driver passes `timeoutMs` to the runner and trusts it; `MockAgentRunner` ignores it; `runPool` has
no timeout. `SubmissionStatus`'s `'timeout'` value is produced nowhere — an unreachable state.
A real OpenCode agent that hangs on a socket hangs its round forever. Enforce in the driver with
`Promise.race` so the guarantee holds regardless of which `AgentRunner` is installed.

**4. `sandbox.teardown` is never called.**
Harmless against `MockSandbox`; leaks a container per agent per run against Docker. At 512MB × 12
containers against a 7.18GB ceiling, this fails fast.

## Blockers for a real judge

**5. One malformed judge reply kills a multi-hour run.**
`Judge.score` implements only the population-size branch of mode selection. Spec §9 also requires
falling back to batched mode on single-call failure, and §15 requires two retries. Neither exists —
`scoreSingleCall` is called with no try/catch, and `parseWithRepair` allows exactly one repair. A real
judge summarizing 20 × 6000-char submissions gets two chances total before the round fails and the
run dies.

**6. Anonymization uses the same permutation every round.**
`makeRng(this.seed + inputs.length)` seeds only on population size, which is invariant by design.
Measured: three consecutive `score()` calls produce byte-identical prompts with identical ref→agent
maps. Spec §9 requires reshuffling each round, and §19 names fixed order as the *cause* of position
bias being "inherited as if it were fitness." Because `listActive` orders by label and labels are
stable, a given agent lands on the same ref every round — so a real judge's first-position preference
becomes a persistent per-agent fitness bonus that selection then amplifies.
Fix: thread the round index into the seed.

**7.** ~~Batched mode discards every rationale and silently changes the score scale.~~
~~Above 25 agents, `scoreBatched` keeps only `rank` and drops `rationale`, and keeps only the *first*~~
~~batch's `meta_digest`. Reflection then receives no critique at all — neither its own nor the leaders' —~~
~~at exactly the population size where the system is most interesting. Spec §10 defines rationales and~~
~~the digest as reflection's core inputs.~~
**Fixed:** `scoreBatched` now carries each agent's real `rationale` through instead of synthesizing
`"Placed N of M"`, and `metaDigest` prefers the finals-round digest (falling back to a batch digest
only when no finals round ran) instead of always keeping the first batch's. See
`test/judge/judge.test.ts` — `Judge.score — batched mode preserves rationales and finals digest`.
**Still open:** batched scores remain rank-derived (`((n-i)/n)*100`), not judge scores, so any fitness
chart still silently compares two different scales depending on which side of `singleCallMaxPopulation`
the population sits. That part of this finding was explicitly out of scope for the rationale/digest fix
and is not addressed here.

## Security — live the moment agents are real

**8. The reflection prompt has no escaping at all.**
`src/evolution/prompts.ts` interpolates `ownStrategy`, `ownNotes`, `topPerformers[].strategy`,
`.excerpt`, `.rationale` and `metaDigest` raw into a prompt structured by the markers
`YOUR STRATEGY:`, `TOP STRATEGY:`, `--- Rank N ---`, `WHY THEY WON:`. All of those fields are
agent-authored, and strategies can contain newlines.

This is a **broadcast** channel, not a point attack: the top-K strategies are shown to every other
reflecting agent, so one winner writes directly into the mutation prompt of the entire rest of the
population. Verified against the mock — a strategy containing a newline followed by
`TOP STRATEGY: <keywords>` makes the victim's prompt contain two `TOP STRATEGY:` lines and the victim
gains keywords it should not have. Against a real reflection model the payload is instructions, not
keywords.

The judge prompt was hardened in Phase 1 (twice). This one was not, and it is the more dangerous of
the two because it is the mutation operator rather than the scorer. Agents are selected on score and
mutate toward whatever wins, so this is under continuous optimization pressure.

**9. `Reflector` rejects unknown models silently.**
An unrecognized `model_id` is dropped with no error and no log line, falling back to the current model.
Once model discovery is live and IDs come from the server, one formatting mismatch disables model
mutation invisibly — and model heritability is the mechanism that puts the provider roster under
selection pressure. Make the rejection observable.

## Data gaps that block Phase 2 cost tracking and Phase 4 UI

**10. `submissions` and `events` tables are created but never written to.**
Verified: 0 rows after 3 rounds. `makeRepos` has no repo for either, `SubmissionRow` is declared and
referenced nowhere, and `AgentRunResult`'s `tokensIn`/`tokensOut`/`durationMs` are returned by the
runner and discarded by the driver. Also never written: `rounds.judge_mode` (stays `single_call` even
when batched ran), `started_at`, `ended_at`, `cost_usd`.
This was a silent drop, not a scoping decision — the plan's out-of-scope list does not mention it.
Spec §12 cost tracking and the `pricing_missing` flag have nothing to attach to until this exists.

**11. `populationSize` is never validated against the roster, and never read.**
The driver builds the population purely from roster counts. Spec §12 requires the run to refuse to
start when they disagree. Verified: `populationSize: 20` with a roster summing to 3 creates 3 agents
silently. Invisible until Phase 4's config UI lets them diverge.

**12. `band: 'top'` is never assigned.** The driver maps everything non-elite/non-culled to `'middle'`.
Phase 4 will chart a band that does not exist.

**13. `topPerformers` includes the agent itself.** Spec §10 says the top-K *other* agents. For ranks
2–5 one leader slot is wasted on self-reinforcement.

**14. `Sandbox` dropped the spec's `endpoint()` method** in favour of a `baseUrl` field on
`AgentHandle`. Neither is read anywhere yet. For Docker the port is only known after `docker port` and
changes on restart, so an immutable handle field goes stale — restore `endpoint(handle)` before
Phase 3 writes against the current shape.

## Test suite repairs

Three Phase 1 tests did not discriminate and have been tightened (each verified by breaking the
guarded implementation, confirming the new assertion fails, then restoring it):

- ~~`test/db/open.test.ts` "is idempotent when reopened" opens a *fresh* `:memory:` db and asserts
  `SELECT 1` doesn't throw. It never reopens anything. Passes even with the `IF NOT EXISTS` guards
  removed.~~ **Fixed:** now uses a file-backed temp db (`mkdtemp`/`tmpdir`), inserts a row via
  `openDb`, closes, reopens the same path, and asserts both that reopening doesn't throw and that the
  row survives.
- ~~`test/evolution/reflect.test.ts` "produces a strategy at least as fit as the original" reduces to
  `>= 0`, which `trueFitness` cannot violate. Passes if `reflect` returns an empty string.~~ **Fixed:**
  now uses `toBeGreaterThan`; the fixture's mock genuinely adds a keyword, so the strict form holds.
- ~~`test/runtime/agent-runner.test.ts` asserts `durationMs >= 0`, unconditionally true for
  `Date.now() - started`.~~ **Fixed:** now bounds `durationMs` above by the wall-clock time the `run()`
  call actually took (measured around the call, with a small tolerance), in addition to being finite
  and non-negative.

Coverage hole: batched judge mode has exactly one test, asserting shape only. Nothing tests that
batched ranking tracks fitness, that rationales survive, or that judge-failure fallback works. It is
the least-tested and most-degraded path in the phase.
**Partially addressed:** rationale- and digest-survival across the batch/finals split are now covered
(see item 7 above). Whether batched *ranking* tracks fitness end-to-end is still untested.
