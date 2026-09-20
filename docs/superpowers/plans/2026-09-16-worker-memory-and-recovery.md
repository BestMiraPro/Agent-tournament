# Implementation handoff: lower tournament RAM usage and recover safely after worker death
## 1. Objective, evidence, and boundaries

Implement two related improvements:

1. Prevent long, multi-round Docker tournaments from retaining unnecessary worker memory between rounds.
2. Allow another round to start after a worker dies, including when its agent has been retired or replaced with a clone.

Then benchmark the highest sustainable number of **simultaneously executing agents**, preserving protected isolation.

### Verified current behavior

- Docker currently exposes approximately **6.69 GiB RAM and 16 CPUs**.
- Other applications run in the same Docker environment and consume part of that memory.
- Worker `arena-8a646a97-fe1d-4994-970c-701a63c88dc3-3` exited with code 137 and Docker reports `OOMKilled=true`.
- A surviving worker’s recorded peak was approximately **796 MiB**.
- The live dashboard reports `busy=false` and the error:
  `previous round is still active or remote termination is unconfirmed`.
- Its active roster contains the manually cloned replacement, while the previous placement still contains the removed agent.
- `OpenCodeAgentRunner` retains invocations until local return and confirmed remote termination.
- OOM diagnosis currently changes the failure classification but does not confirm termination.
- The readiness guard executes before replanning, so a retained invocation can indefinitely prevent the updated roster from being provisioned.
- Worker containers currently survive between rounds.
- The existing sizing benchmark covers a short research workload, not sustained OpenCode conversations.

These facts strongly support the stale termination-state diagnosis. The regression test below must establish the precise failure and verify the fix.

### Constraints

- Preserve protected isolation and one worker container per protected agent.
- Preserve selection, scoring, clone lineage, budgets, and persisted tournament history.
- Accept additional startup time between rounds.
- Do not weaken capacity checks or silently enable shared isolation.
- Do not claim that reducing a memory ceiling reduces actual consumption.
- Do not change Docker Desktop settings or stop unrelated containers.
- Do not change the running tournament while implementing or testing.
- Preserve the existing uncommitted changes, particularly the grading, provider, engine, and API work.
- Use existing dependencies and test infrastructure.
- Do not introduce paid-provider benchmarks by default.

## 2. Task A — Confirm worker termination and unblock subsequent rounds

### Relevant implementation areas

- `OpenCodeAgentRunner`: invocation tracking, quiescence, OOM diagnosis, readiness checking.
- Docker sandbox/container helpers: ownership and authoritative container state.
- `TournamentEngine.runRound`: preflight ordering.
- Dashboard composition and CLI composition: connect Docker evidence to the runner.

### Reproduce before changing behavior

Add a regression using the existing fake-client and fake-Docker seams:

1. Start a round with protected agents.
2. Make one worker’s prompt reject as a transport failure.
3. Make its OpenCode status endpoint unavailable.
4. Report its original Docker container as exited and OOM-killed.
5. Finish the round’s local work.
6. Retire that agent and add a clone.
7. Attempt another round.

Before the fix, readiness should fail with the reported error. After the fix, the engine should plan and provision the current active roster.

Include a variant where the dead agent is culled through ordinary selection rather than manually retired.

### Track the original runtime identity

Add an optional immutable runtime identifier to `AgentHandle`; use the actual Docker container ID for Docker workers.

- Return and retain the container ID when starting a worker.
- Store a copy of the original handle in each tracked runner invocation.
- Resolve termination against that original container ID.
- Do not derive an old invocation’s ownership from the current shard plan, current agent roster, or a reusable container name.
- Keep mock and local handles compatible by making this field optional.

Container names remain useful in error messages; IDs establish execution ownership.

### Add authoritative termination evidence

Add an optional runner callback with this contract:

```ts
runtimeState?: (
  handle: AgentHandle
) => Promise<'running' | 'stopped' | 'unknown'>
```

The Docker implementation must return:

- `stopped`: the original container is confirmed exited, dead, or absent.
- `running`: the original container still exists in a state capable of retaining execution; paused/restarting must not count as stopped.
- `unknown`: Docker is unavailable, permission is denied, output is invalid, or absence cannot be distinguished from an inspection failure.

Use a bounded Docker request. Do not reuse a helper that treats every failed inspection as “absent.”

### Reconcile retained invocations

Change the runner interface to permit asynchronous readiness checking:

```ts
assertReadyForRound?(): void | Promise<void>
```

Update every caller to await it.

For retained invocations:

1. Preserve existing terminal-response and session-status evidence.
2. Consult the runtime-state callback when remote termination remains unconfirmed.
3. Confirm termination only when the callback returns `stopped`.
4. Remove the invocation only after both remote termination and local return are established.
5. Continue refusing when a local invocation is still pending or runtime state remains unresolved.

Apply the same runtime check during quiescence so an OOM-killed worker does not depend on an unreachable OpenCode server eventually answering.

A late response from an old invocation must only update that invocation. It must never clear a newer invocation for the same agent.

### Preserve evidence semantics

- Keep `CONTAINER_OOM` as the original failure classification.
- Keep usage unknown when no terminal response supplied it.
- Do not manufacture successful submissions or zero-cost observations.
- Do not retroactively upgrade previously stored capture verification.
- Docker-confirmed termination proves that the worker cannot continue writing; it does not prove that its prior output was valid.

### Move preflight ahead of round creation

Before inserting a new round:

1. Confirm the run has its budget tracker.
2. Obtain the active population.
3. Reconcile prior execution.
4. Plan placement and verify capacity.
5. Recheck cancellation before provisioning.

Only after successful preflight should the engine create the round record and begin its audit.

No automatic host tuning, dynamic memory overcommit, or new shared-runtime architecture is part of this change.

### Improve the failure message

Report the blocking agent and runtime, with a concrete distinction:

- Previous invocation has not returned locally.
- Original container is still running.
- Docker could not establish whether the original container stopped.

Do not present adding a clone as the cause.

## 3. Task B — Recycle Docker workers between rounds

### Lifecycle design

Add a nonterminal cleanup operation to `DockerSandbox`, separate from `disposeAll()`.

Suggested contract:

```ts
releaseRound(): Promise<void>
```

Unlike terminal disposal, this operation must allow later `planFor()` and `provision()` calls.

Expose it through an optional engine dependency that composition can use to coordinate Docker resources, bridges, caches, and capacity:

```ts
releasePopulation?: () => Promise<void>
```

Mock and local execution need no implementation.

### Normal cleanup boundary

Release workers after:

1. The execution pool has settled.
2. Per-agent capture has completed.
3. Collection, verification, and submission persistence have completed.
4. The round’s audit has been frozen.

Then continue judging, reflection, and breeding using existing persisted/captured inputs and the host provider.

Do not tear down workers before collection: current sandbox file operations require live handles.

### Failure and abort paths

Invoke the same cleanup from the round’s `finally` path when normal cleanup has not already succeeded.

- Wait for local pool work that the engine owns to settle.
- Remove only the exact worker instances owned by this composition.
- Force-removing an owned worker is permitted at this cleanup boundary because the round has finished executing locally; it also terminates lingering child processes.
- Preserve workspace directories and all database records.
- Do not overwrite the original round error with a cleanup error.
- Report cleanup failure separately and retain ownership for retry.

Make repeated or concurrent cleanup calls join the same in-flight cleanup attempt.

### Verified removal

The existing warning-only removal helper must not be treated as proof of success.

Add a strict result or dedicated strict removal helper:

- Confirm removal of the original worker instance.
- Confirm removal of its gateway.
- Retain failed resources in ownership bookkeeping.
- Keep capacity reserved while any associated resource remains unresolved.
- Allow terminal disposal to retry failures.

Do not mark resources stopped merely because a removal command was attempted.

### Clear obsolete runtime state

When a worker is released:

- Stop its event bridge.
- Remove its published runtime endpoint.
- Remove its cached model catalogue.
- Evict cached clients for its retired endpoint.
- Remove obsolete session-to-agent mappings after their round evidence is frozen.
- Remove successfully released containers from bookkeeping used for future planning.

Extend runtime notifications to distinguish start and stop events. A replacement runtime must attach a fresh bridge even if Docker happens to reuse its previous host port.

Bound retained bookkeeping by current resources plus unresolved cleanup failures, rather than by total rounds completed.

### Preserve tournament data

Do not delete:

- Agent workspaces.
- Captured submissions or manifests.
- Genomes and notes.
- Clone lineage.
- Scores, judge records, or audit events.
- Read-only context material.

The next round continues the existing behavior: provision/reset the active agent’s workspace and seed the persisted genome and notes. OpenCode session history is not the tournament’s cross-round memory.

### Capacity lifecycle

- Release a run’s capacity reservation only after all corresponding workers and gateways are confirmed removed.
- Re-admit the full active population before each later round, even when its size is unchanged.
- Include gateway memory and CPU.
- Preserve reservations for unresolved resources.
- Avoid double-counting the observed memory of containers already covered by reservations.
- Handle manual clones through the freshly read active population.

If a clone exceeds the configured protected container limit, return the specific placement/capacity refusal. Do not silently share containers or ignore the clone.

## 4. Task C — Measure and expose sustainable simultaneous capacity

### Extend the existing benchmark

Extend `scripts/benchmark-toolchain.ts`; reuse the existing fake-provider and protected-runtime test patterns.

Use real OpenCode processes and production worker/gateway launch arguments, with synthetic credentials and a local deterministic provider.

The workload must include:

- Repeated model/tool exchanges.
- Substantial tool output.
- The existing pandas/DuckDB/matplotlib research workload.
- Multiple rounds with normal capture and cleanup.
- A population change between rounds.
- Controlled worker death in a separate recovery scenario.

A loop around the existing Python workload alone is insufficient: it does not exercise OpenCode conversation growth.

### Fixed benchmark protocol

Compare:

1. Current retained-worker lifecycle.
2. New recycled-worker lifecycle.

For each lifecycle:

- Test 1 GiB and 768 MiB worker limits.
- Use the same CPU allocation, toolchain image, workload, and deterministic responses.
- Run ten rounds.
- Exercise at least 100 tool-response turns per worker per round.
- Repeat passing candidates three times.
- Increase simultaneous agents one at a time within the existing admission budget.
- Stop increasing after capacity refusal or a failed trial.

Do not benchmark 512 MiB as a proposed default; the existing research workload already produced OOM kills there.

### Measurements

Record per worker and per round:

- Container ID and configured limits.
- Current and peak cgroup memory.
- Anonymous memory and tmpfs usage.
- OOM counters and Docker exit state.
- OpenCode readiness time.
- Workload completion and submission status.
- Cleanup duration and remaining resources.

Also record total Docker capacity, unrelated container usage, gateway usage, and host orchestration-process memory where available.

Separate worker memory from host provider memory so recycling workers cannot conceal growth elsewhere.

### Acceptance rule for sizing

A candidate is eligible for recommendation only when:

- Every repetition completes.
- There are no OOM kills.
- Every expected submission is present.
- Worker peaks remain below 80% of the configured limit.
- Cleanup leaves no worker/gateway resources.
- Repeated rounds do not accumulate endpoint/session bookkeeping.
- Admission succeeds without changing host settings or stopping unrelated applications.

Recommend the highest simultaneous count that passes.

Change the default to 768 MiB only if it passes this protocol. Otherwise retain 1 GiB and report the measured ceiling and remaining limitation. Do not claim increased parallel capacity unless it was demonstrated.

These results qualify the measured workload, not arbitrary future tasks.

### Dashboard changes

- Keep population size and maximum parallel agents separate.
- Explain that worker runtimes restart between rounds.
- Show protected worker and gateway costs together.
- Reuse server capacity arithmetic for setup estimates instead of maintaining divergent calculations.
- Ensure existing reservations are counted consistently with admission.
- Keep actual concurrency user-controlled; do not silently reduce it and describe the result as simultaneous execution.
- Label recommendations with the workload and benchmark scope.

No automatic host tuning, dynamic memory overcommit, or new shared-runtime architecture is part of this change.

## 5. Delivery order and verification

Implement in this order:

1. Failing OOM/clone regression and authoritative termination recovery.
2. Verified, reusable round cleanup.
3. Bridge/cache/capacity lifecycle integration.
4. Long-run benchmark.
5. Evidence-supported defaults and dashboard guidance.

Each task should have focused tests and an independently reviewable commit.

### Required regression scenarios

- OOM-killed worker → retired agent → manual clone → next round.
- OOM-killed worker culled through normal evolution.
- Confirmed worker exit without an OOM flag.
- Unreachable Docker remains unknown.
- Running/restarting/paused worker remains unresolved.
- Old container name reused by a different container ID.
- Late response from an old invocation.
- Partial provisioning failure.
- Abort during provisioning and during execution.
- Failed worker or gateway removal, followed by successful retry.
- Successful round releases workers before grading completes.
- Cleanup failure preserves the original result and capacity reservation.
- Multiple rounds recreate workers and preserve history.
- Replacement runtime reconnects activity correctly.
- Manual population growth is checked before a round row is inserted.
- Local and mock execution retain their existing behavior.

### Required gates

Run focused tests first, then:

```powershell
npm test
npm run typecheck
npm run web:build
```

The inspected focused baseline was **77 passing tests** across remote execution evidence, Docker sandbox lifecycle, and capacity accounting. Establish the current full-suite baseline before implementation; do not assume the historical test count still matches this modified checkout.

Run provider-free Docker integration and benchmarks after the cheap gates. Keep paid-provider validation explicitly separate.

### Final handoff from the implementing agent

Report:

- Changes made and their commit identifiers.
- Regression and full-gate results.
- Before/after memory measurements.
- Demonstrated simultaneous-agent count.
- Whether the default changed and why.
- Remaining workload-dependent limitations.
- Any validation not completed.

**Begin with the failing OOM → clone → next-round regression.**
