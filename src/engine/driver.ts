import { serializeGenome } from '../core/genome.js'
import { planSelection } from '../core/selection.js'
import type { Genome, RunConfig, SubmissionStatus } from '../core/types.js'
import type { Repos } from '../db/repos.js'
import { BudgetTracker, type BudgetBreach, type BudgetStatus } from './budget.js'
import { breed } from '../evolution/breed.js'
import type { EngineEvent, EventSink } from './events.js'
import {
  captureSubmission,
  checkQuota,
  quiesceAgent,
  verifyCapture,
  workspaceIsolated,
  type Capture,
  type QuiesceStatus,
} from './capture.js'
import type { Reflector } from '../evolution/reflect.js'
import type { TopPerformer } from '../evolution/prompts.js'
import type { Judge, JudgeInput } from '../judge/judge.js'
import type { AgentRunner, AgentRunResult } from '../runtime/agent-runner.js'
import { runPool } from '../runtime/pool.js'
import type { AgentHandle, Sandbox } from '../runtime/sandbox.js'

export interface EngineDeps {
  repos: Repos
  config: RunConfig
  sandbox: Sandbox
  runner: AgentRunner
  judge: Judge
  reflector: Reflector
  seedStrategy: (index: number) => string
  onEvent?: EventSink
  /** Optional per-round preparation for sandboxes that need the full live roster. */
  preparePopulation?: (agentIds: readonly string[]) => Promise<void>
}

export interface RoundResult {
  roundId: string
  roundIdx: number
  metaDigest: string
  /**
   * Null when the round finished within budget. Set the instant `startRound` +
   * every agent's `record` this round leaves the tracker over an aggregate cap.
   * REFLECT is skipped whenever this is non-null, so the caller (the CLI) should
   * stop the round loop rather than starting another round on an already-blown budget.
   */
  budgetBreach: BudgetBreach | null
}

export class TournamentEngine {
  /** One tracker per run, keyed by run id — `runRound` may be called many times for
   *  the same run, and run-level spend (unlike round-level) must survive across all of them. */
  private budgets = new Map<string, BudgetTracker>()
  /** Per-run abort flags for cooperative abort — set by `abortRound`, read by the
   *  pool `shouldStop` gates and the phase gates below. */
  private aborted = new Set<string>()

  constructor(private d: EngineDeps) {}

  private emit(event: EngineEvent): void {
    try {
      this.d.onEvent?.(event)
    } catch {
      /* a dashboard subscriber must never break a tournament */
    }
  }

  createRun(name: string, initialGoal: string) {
    const { repos, config } = this.d

    // The population is built purely from roster counts, so a roster that does not
    // sum to populationSize silently produces the wrong population size instead of
    // failing. Catch it before a single agent row exists.
    const rosterTotal = config.roster.reduce((sum, r) => sum + r.count, 0)
    if (rosterTotal !== config.populationSize) {
      throw new Error(
        `roster counts sum to ${rosterTotal} but populationSize is ${config.populationSize}`,
      )
    }

    // Constructed — and so validated — before the run row is persisted, the same way
    // the roster-sum check above fails before anything is written. `models` turns a
    // USD limit set without full roster pricing into a construction-time refusal
    // instead of a mid-run discovery once money is already being spent.
    const budget = new BudgetTracker({
      ...config.budget,
      pricing: config.pricing,
      models: config.roster.map((r) => r.modelId),
    })

    const run = repos.runs.create({ name, initialGoal, config, seedDir: config.seedDir })
    this.budgets.set(run.id, budget)

    let index = 0
    for (const entry of config.roster) {
      for (let i = 0; i < entry.count; i++) {
        const agent = repos.agents.create({
          runId: run.id,
          label: `competitor-${String(index + 1).padStart(2, '0')}`,
          parentAgentId: null,
          bornRound: 1,
        })
        repos.genomes.create({
          agentId: agent.id,
          roundIdx: 1,
          strategyMd: this.d.seedStrategy(index),
          notesMd: '',
          modelId: entry.modelId,
          temperature: entry.temperature,
          parentGenomeId: null,
          origin: 'seed',
        })
        index++
      }
    }
    void initialGoal
    return run
  }

  /**
   * Reconfigures a run between rounds — the engine-side half of a PATCH. The next
   * `runRound` reads `this.d.config`/`judge`/`reflector` fresh, so assigning them is
   * enough; the budget tracker is updated in place, keeping its accumulated spend.
   * Callers must guarantee no round is in flight (the API's busy guard does).
   */
  reconfigure(
    runId: string,
    d: { config: RunConfig; judge: Judge; reflector: Reflector },
  ): void {
    const budget = this.budgets.get(runId)
    if (!budget) {
      throw new Error(`no budget tracker registered for run ${runId} — call createRun first`)
    }
    // Updated before the deps are swapped: a rejected config (e.g. a cap the roster
    // pricing cannot support) must leave the engine on its old, working pieces.
    budget.updateConfig(
      { ...d.config.budget, pricing: d.config.pricing },
      d.config.roster.map((r) => r.modelId),
    )
    this.d.config = d.config
    this.d.judge = d.judge
    this.d.reflector = d.reflector
  }

  /**
   * Flags a run's in-flight round for cooperative abort: pools stop pulling NEW
   * items and the phase gates below fail the round. Every tracked agent session is
   * also aborted via the runner — queued work stops AND live sessions die, so only
   * an in-flight JUDGE call still finishes (no provider-level abort exists for it).
   * In-flight JUDGE/REFLECT/recombine LLM calls finish; aborts landing after the
   * EVOLVE gate complete the round. Async only for the session aborts; the flag itself is set synchronously, so a
   * caller that cannot await still stops all future dispatches the instant it calls.
   */
  async abortRound(runId: string): Promise<void> {
    this.aborted.add(runId)
    await this.d.runner.abortAll()
  }

  async runRound(
    runId: string,
    input: { goalMd: string; criteriaMd: string | null },
  ): Promise<RoundResult> {
    const { repos, config } = this.d
    // WHY clear here AND in `finally`: a stale flag (abort arriving with no round
    // in flight) must never kill the next round.
    this.aborted.delete(runId)
    // Before anything is written. Trackers live in memory, so a run persisted by an
    // earlier process has none — and creating the round row first left a started round
    // that recovery then marked failed, recording a spurious failure for a request that
    // should simply have been refused.
    const budget = this.budgets.get(runId)
    if (!budget) {
      throw new Error(`no budget tracker registered for run ${runId} — call createRun first`)
    }

    const roundIdx = repos.rounds.lastIdx(runId) + 1
    const round = repos.rounds.create({ runId, idx: roundIdx, goalMd: input.goalMd })
    repos.rounds.markStarted(round.id)

    try {
      // Round counters reset; run totals and any run-level breach deliberately survive.
      budget.startRound()

      // PREPARE
      repos.rounds.setStatus(round.id, 'preparing')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'preparing' })
      const agents = repos.agents.listActive(runId)
      // Prior writers can outlive culling and still reach a reused shared shard.
      // Check all retained owners before planning/provision/reset, once per round.
      this.d.runner.assertReadyForRound?.()
      await this.d.preparePopulation?.(agents.map((agent) => agent.id))
      // Planning may wait on capacity or container bookkeeping. Preserve an abort
      // that lands during that await and never enter the provisioning pool afterward.
      if (this.aborted.has(runId)) throw new Error('round aborted by user')
      const prepared = agents.map((agent) => {
        const exact = repos.genomes.forRound(agent.id, roundIdx)
        if (exact) return { agent, genome: exact }

        const source = repos.genomes.forAgent(agent.id)
          .filter((genome) => genome.roundIdx < roundIdx)
          .at(-1)
        if (!source) {
          throw new Error(`active agent ${agent.id} has no genome history before round ${roundIdx}`)
        }

        // A failed round has no evolution output for its successor. `clone` records a
        // byte-identical, persisted carry-forward while retaining the source lineage.
        // An exact genome above always wins, preserving any partial evolution output.
        const genome = repos.genomes.create({
          agentId: agent.id,
          roundIdx,
          strategyMd: source.strategyMd,
          notesMd: source.notesMd,
          modelId: source.modelId,
          temperature: source.temperature,
          parentGenomeId: source.id,
          origin: 'clone',
        })
        return { agent, genome }
      })

      // One provisioning failure (port exhaustion, image pull, OOM under Docker) must
      // not abort the round before any agent runs — isolate each agent's PREPARE work
      // through the pool rather than a plain sequential loop.
      const prepResults = await runPool(prepared, config.concurrency, async (p) => {
        const h = await this.d.sandbox.provision(p.agent.id, {
          seedDir: config.seedDir ?? undefined,
        })
        await this.d.sandbox.reset(h, { seedDir: config.seedDir ?? undefined })
        await this.d.sandbox.writeFile(h, 'NOTES.md', p.genome.notesMd)
        await this.d.sandbox.writeFile(h, 'GOAL.md', input.goalMd)
        await this.d.sandbox.writeFile(
          h,
          '.opencode/agents/competitor.md',
          serializeGenome(p.genome, { label: p.agent.label }),
        )
        return h
      }, {
        // Cooperative abort: queued agents stop; in-flight provisions run out.
        shouldStop: () => this.aborted.has(runId),
      })

      const handles = new Map<string, AgentHandle>()
      const prepFailed = new Map<string, string>()
      prepResults.forEach((r, i) => {
        const agentId = prepared[i]!.agent.id
        if (r.ok) handles.set(agentId, r.value)
        else prepFailed.set(agentId, String(r.error).slice(0, 500))
      })

      // RUN
      repos.rounds.setStatus(round.id, 'running')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'running' })
      // Output is captured inside the pool worker, the instant its agent stops, rather
      // than in COLLECT: a rival sharing the container is still executing until the pool
      // drains, and anything it destroys before then would be destroyed for good.
      const captures = new Map<string, Capture>()
      const quiesced = new Map<string, QuiesceStatus>()
      // The timeout is enforced here, not delegated to the runner: a runner that
      // ignores or mishandles `timeoutMs` would otherwise hang the whole round.
      const runResults = await runPool(prepared, config.concurrency, async (p) => {
        // Emitted once, as this agent's worker is dispatched, regardless of how it
        // eventually ends — matched by exactly one done/failed emission via `finish` below.
        this.emit({ type: 'agent.status', runId, agentId: p.agent.id, status: 'running' })
        const finish = (result: AgentRunResult): AgentRunResult => {
          this.emit({
            type: 'agent.status',
            runId,
            agentId: p.agent.id,
            status: result.status === 'ok' ? 'done' : 'failed',
          })
          this.emit({
            type: 'agent.usage',
            runId,
            agentId: p.agent.id,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            costUsd: result.costUsd,
          })
          return result
        }

        // An agent whose provisioning failed has no handle to run against; record it
        // as the error it already is instead of calling the runner with a missing
        // handle.
        const prepError = prepFailed.get(p.agent.id)
        if (prepError !== undefined) {
          const failed: AgentRunResult = {
            status: 'error',
            errorText: `provisioning failed: ${prepError}`,
            tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
            costUsd: 0, durationMs: 0,
          }
          return finish(failed)
        }

        // The dispatch gate: checked per agent as the pool pulls it off the queue, not
        // once for the whole phase, so an aggregate cap that trips mid-round stops
        // agents still waiting behind `concurrency` without touching ones already
        // dispatched — those are left to drain and are still scored, since that work is
        // paid for either way.
        if (budget.shouldStopDispatch()) {
          const skipped: AgentRunResult = {
            status: 'error',
            errorText: 'agent dispatch skipped: the run/round budget was already exhausted',
            tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
            costUsd: 0, durationMs: 0,
          }
          return finish(skipped)
        }

        const handle = handles.get(p.agent.id)!
        const started = Date.now()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const result = await Promise.race([
            this.d.runner.run(handle, {
              agentId: p.agent.id,
              genome: p.genome,
              goalMd: input.goalMd,
              timeoutMs: config.agentTimeoutMs,
            }),
            new Promise<never>((_r, reject) => {
              timer = setTimeout(() => reject(new DriverTimeout()), config.agentTimeoutMs)
            }),
          ])
          // Folded in the instant the run returns, so a concurrent sibling still
          // queued behind `shouldStopDispatch` above sees this spend immediately.
          budget.record({
            agentId: p.agent.id,
            modelId: p.genome.modelId,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            tokensCacheRead: result.tokensCacheRead,
            tokensCacheWrite: result.tokensCacheWrite,
            costUsd: result.costUsd,
          })
          return finish(result)
        } catch (e) {
          if (e instanceof DriverTimeout) {
            const timedOut: AgentRunResult = {
              status: 'timeout',
              errorText: `driver timeout after ${config.agentTimeoutMs}ms`,
              tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
              costUsd: 0, durationMs: Date.now() - started,
            }
            return finish(timedOut)
          }
          throw e
        } finally {
          // Without this the loser of the race keeps a timer alive for the full
          // agentTimeoutMs after every round, holding the process open.
          clearTimeout(timer)

          // Capturing here rather than after the pool is deliberate, and so is the order:
          // the run promise settling only means the driver stopped waiting — on the
          // timeout path the agent's own session is still live and still writing into the
          // directory about to be hashed. Stop it first, then read; otherwise the hash
          // certifies a file its author kept editing. Runs in `finally` so a runner that
          // threw still has whatever it produced preserved.
          const stopped = await quiesceAgent(this.d.runner, handle)
          quiesced.set(p.agent.id, stopped)
          try {
            captures.set(
              p.agent.id,
              await captureSubmission(this.d.sandbox, handle, {
                // Sealed only if BOTH writers are excluded: this agent, which quiesce
                // just stopped, and any co-tenant sharing its workspace. When agents
                // share a container the second is false and the capture is honestly
                // marked uncertifiable — a rival could have substituted the file in the
                // gap between this agent stopping and this read, and no amount of
                // re-reading later can tell that apart from the agent's own work.
                executionStopped:
                  stopped === 'stopped' && workspaceIsolated(this.d.sandbox, handle),
                hashBudget: {
                  maxFiles: config.maxWorkspaceFiles,
                  maxBytes: config.maxWorkspaceBytes,
                },
              }),
            )
          } catch {
            // A workspace that cannot be read is handled in COLLECT as a missing capture.
          }
        }
      }, {
        // Cooperative abort: queued agents stop; in-flight sessions are aborted via the runner (mocks run out);
        shouldStop: () => this.aborted.has(runId),
      })

      // `record` only happens during RUN above, so nothing after this point changes
      // spend — this snapshot is valid for the rest of the round. A breach here still
      // lets COLLECT/JUDGE run so whatever already completed gets scored (it is paid
      // for either way); only REFLECT is skipped, below.
      const budgetBreach = budget.check()

      // COLLECT
      repos.rounds.setStatus(round.id, 'collecting')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'collecting' })
      // `runPool` has drained, and every worker quiesced its own agent before returning,
      // so no agent in this round is still executing. That barrier — not the capture's
      // timing — is what makes "unchanged since capture" a claim worth recording. One
      // agent that could not be confirmed stopped invalidates it for everybody, because
      // any co-tenant left running could be the one doing the writing.
      const executionStopped = prepared.every(
        (p) => !handles.has(p.agent.id) || quiesced.get(p.agent.id) === 'stopped',
      )
      const judgeInputs: JudgeInput[] = []
      for (const [i, p] of prepared.entries()) {
        const res = runResults[i]!
        // No handle exists when this agent's own provisioning failed: there is no
        // workspace to read a submission from.
        const handle = handles.get(p.agent.id)
        const capture = captures.get(p.agent.id)
        // The captured text is the judged artifact, not a fresh read: a rival that
        // overwrote this file after the capture must not get its substitute judged.
        const submissionMd = res.ok && capture ? capture.submissionMd : null
        const files = res.ok && capture ? capture.files : []

        if (handle && capture) {
          const verdict = await verifyCapture(this.d.sandbox, handle, capture, {
            executionStopped,
          })
          // Recorded for every agent, not only the tampered ones. A score is only as
          // trustworthy as the artifact behind it, and "no tamper event" conflates
          // "checked and clean" with "could not be checked at all" — the second is what
          // a shared container always yields, and it must not read as a clean bill.
          repos.events.append({
            runId,
            roundId: round.id,
            agentId: p.agent.id,
            type: 'submission.captured',
            payload: {
              sealed: capture.sealed,
              verified: verdict.verified,
              tampered: verdict.tampered,
              hashesComplete: capture.hashesComplete,
              capturedAt: capture.capturedAt,
              quiesce: quiesced.get(p.agent.id) ?? 'unsupported',
            },
          })
          if (verdict.tampered) {
            // The agent keeps the submission it earned; the interference is recorded.
            repos.events.append({
              runId,
              roundId: round.id,
              agentId: p.agent.id,
              type: 'submission.tampered',
              payload: {
                detail: verdict.detail,
                verified: verdict.verified,
                capturedAt: capture.capturedAt,
                quiesce: quiesced.get(p.agent.id) ?? 'unsupported',
              },
            })
          }
        }

        // The agent that filled the disk is the one penalised, so this is its own status
        // rather than a round-level failure.
        const quota = checkQuota(files, {
          maxBytes: config.maxWorkspaceBytes,
          maxFiles: config.maxWorkspaceFiles,
        })

        // A non-'ok' runner status is the actual reason there is nothing to judge and
        // must survive to the submission row. Deriving the status from the file alone
        // rewrote every 'timeout' as 'no_submission', which made the driver-enforced
        // timeout invisible in the database.
        const status: SubmissionStatus = !res.ok
          ? 'error'
          : !quota.ok
            // Deliberately outranks a 'timeout': exceeding the quota is the punishable
            // act, and naming it is what makes the zero score explicable.
            ? 'error'
            : res.value.status !== 'ok'
              ? res.value.status
              : submissionMd
                ? 'ok'
                : 'no_submission'

        judgeInputs.push({
          agentId: p.agent.id,
          submissionMd: submissionMd ?? '',
          files,
          status,
        })

        repos.submissions.create({
          roundId: round.id,
          agentId: p.agent.id,
          genomeId: p.genome.id,
          submissionMd,
          fileManifest: files,
          workspacePath: handle?.workspacePath ?? '',
          status,
          errorText: !res.ok
            ? String(res.error).slice(0, 500)
            : quota.ok
              ? res.value.errorText
              : quota.reason,
          tokensIn: res.ok ? res.value.tokensIn : 0,
          tokensOut: res.ok ? res.value.tokensOut : 0,
          tokensCacheRead: res.ok ? res.value.tokensCacheRead : 0,
          tokensCacheWrite: res.ok ? res.value.tokensCacheWrite : 0,
          costUsd: res.ok ? res.value.costUsd : 0,
          durationMs: res.ok ? res.value.durationMs : 0,
        })
      }

      // JUDGE
      if (this.aborted.has(runId)) throw new Error('round aborted by user')
      repos.rounds.setStatus(round.id, 'judging')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'judging' })
      // WHY re-read the row: an override that lands mid-round must win over the
      // POST body. A fresh row defaults to criteriaSource 'generated' (rounds.create),
      // so the fast path is byte-identical to today.
      const rowNow = repos.rounds.get(round.id)
      const effective = rowNow?.criteriaSource === 'user' ? rowNow.criteriaMd : input.criteriaMd
      const { criteriaMd, source } = await this.d.judge.resolveCriteria(
        input.goalMd,
        effective,
      )
      repos.rounds.setCriteria(round.id, criteriaMd, source)
      const judged = await this.d.judge.score(input.goalMd, criteriaMd, judgeInputs, roundIdx)
      repos.rounds.setDigest(round.id, judged.metaDigest)
      // The judge may fall back from single_call to batched_finals, so record what
      // actually ran rather than what was configured.
      repos.rounds.setJudgeMode(round.id, judged.mode)

      // EVOLVE
      if (this.aborted.has(runId)) throw new Error('round aborted by user')
      repos.rounds.setStatus(round.id, 'evolving')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'evolving' })
      const plan = planSelection(
        judged.scores.map((s) => ({ agentId: s.agentId, rank: s.rank, score: s.score })),
        config.selection,
        // Strategies thread through the prepared genomes (same round, same agents)
        // so the diversityFloor rescue can score culled agents — one arg, no shape change.
        new Map(prepared.map((p) => [p.agent.id, p.genome.strategyMd])),
      )
      // Everything non-elite and non-culled used to collapse to 'middle', so the
      // 'top' band defined by the schema and the spec was never assigned.
      const topCount = Math.max(
        config.selection.eliteCount,
        Math.floor(judged.scores.length * config.selection.topPct),
      )
      const bandOf = (agentId: string, rank: number) =>
        plan.elite.includes(agentId) ? 'elite' as const
        : plan.culled.includes(agentId) ? 'bottom' as const
        : rank <= topCount ? 'top' as const
        : 'middle' as const
      repos.scores.insertMany(
        round.id,
        judged.scores.map((s) => ({
          roundId: round.id, agentId: s.agentId, rank: s.rank,
          score: s.score, rationaleMd: s.rationaleMd, band: bandOf(s.agentId, s.rank),
        })),
      )
      this.emit({
        type: 'round.scored',
        runId,
        roundIdx,
        scores: judged.scores.map((s) => ({ agentId: s.agentId, rank: s.rank, score: s.score })),
      })

      // REFLECT
      if (this.aborted.has(runId)) throw new Error('round aborted by user')
      repos.rounds.setStatus(round.id, 'reflecting')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'reflecting' })
      const mutated = new Map<string, Genome>()
      // Reflection is the one thing a breach skips: it is pure extra spend on top of a
      // round that already blew its budget, and skipping it is what makes breed()
      // below carry every survivor's genome forward byte-identical (breed() falls back
      // to the previous round's genome for any agent absent from `mutated`).
      if (budgetBreach === null) {
        const byAgent = new Map(judged.scores.map((s) => [s.agentId, s]))
        const subByAgent = new Map(judgeInputs.map((j) => [j.agentId, j]))
        // The spec asks for the top-K *other* agents. A shared list handed ranks 2..K+1
        // their own strategy back as something to imitate, wasting a leader slot on
        // self-reinforcement. Pooling topK + 1 means every agent still sees a full topK
        // after its own entry is removed.
        const leaderPool = judged.scores.slice(0, config.reflect.topK + 1)
        const topPerformersFor = (agentId: string): TopPerformer[] =>
          leaderPool
            .filter((s) => s.agentId !== agentId)
            .slice(0, config.reflect.topK)
            .flatMap((s) => {
              const g = repos.genomes.forRound(s.agentId, roundIdx)
              return g ? [{
                rank: s.rank,
                strategy: g.strategyMd,
                excerpt: (subByAgent.get(s.agentId)?.submissionMd ?? '').slice(0, 400),
                rationale: s.rationaleMd,
              }] : []
            })

        // NOTE: the Reflector receives its allowed-model list via its constructor, not
        // from here, so this driver deliberately derives nothing from config.roster.
        // Task 21's CLI must pass `config.roster.map((r) => r.modelId)` when it builds
        // the Reflector — the mock helper hardcodes ['mock/model'], so a mistake there
        // would not be caught by these tests.
        const reflected = await runPool(plan.survivors, config.concurrency, async (agentId) => {
          const g = repos.genomes.forRound(agentId, roundIdx)!
          const s = byAgent.get(agentId)!
          return [agentId, await this.d.reflector.reflect({
            ownStrategy: g.strategyMd,
            ownNotes: g.notesMd,
            ownRank: s.rank,
            ownScore: s.score,
            ownRationale: s.rationaleMd,
            topPerformers: topPerformersFor(agentId),
            metaDigest: judged.metaDigest,
            nextGoal: input.goalMd,
            goalChanged: false,
            currentModelId: g.modelId,
            currentTemperature: g.temperature,
          })] as const
        })

        for (const r of reflected) if (r.ok) mutated.set(r.value[0], r.value[1])
      }

      // The recombine seam binds the round goal to the Reflector's
      // mutation-shaped call, so the model is the reflector's own
      // (config.reflect.modelId) by construction — the driver threads no model
      // id and no provider of its own, only this closure.
      await breed({
        repos, runId, nextRoundIdx: roundIdx + 1, plan, mutated,
        recombine: budgetBreach === null
          ? (a, b) => this.d.reflector.recombine(a, b, input.goalMd)
          : undefined,
      })

      repos.rounds.markEnded(round.id, repos.submissions.totalCost(round.id))
      repos.rounds.setStatus(round.id, 'complete')
      this.emit({ type: 'round.status', runId, roundIdx, status: 'complete' })
      this.emit({
        type: 'round.complete',
        runId,
        roundIdx,
        budgetBreach: budgetBreach?.reason ?? null,
      })
      return { roundId: round.id, roundIdx, metaDigest: judged.metaDigest, budgetBreach }
    } catch (e) {
      // The primary failure remains authoritative: a secondary persistence problem
      // must not replace it, but a failed round should still retain its known spend.
      try {
        repos.rounds.markEnded(round.id, repos.submissions.totalCost(round.id))
      } catch {
        // Preserve the original error below.
      }
      try {
        repos.rounds.setStatus(round.id, 'failed')
      } catch {
        // Preserve the original error below.
      }
      this.emit({ type: 'round.status', runId, roundIdx, status: 'failed' })
      throw e
    } finally {
      // WHY: a stale flag must never kill the next round.
      this.aborted.delete(runId)
    }
  }

  /**
   * Snapshot of this run's budget tracker — tokens/USD spent and remaining, and
   * whether USD is even known for the models actually used. Exists so a caller (the
   * CLI) can report what a breached run spent without reaching into engine internals.
   * Null only if `createRun` was never called for this run id.
   */
  budgetStatus(runId: string): BudgetStatus | null {
    return this.budgets.get(runId)?.status() ?? null
  }

  /** Releases sandbox resources. With Docker this stops the shard containers. */
  async dispose(runId: string): Promise<void> {
    const agents = this.d.repos.agents.listActive(runId)
    for (const a of agents) {
      await this.d.sandbox
        .teardown({ agentId: a.id, workspacePath: '', baseUrl: '' })
        .catch(() => {})
    }

    // Per-agent teardown depends on bookkeeping that can go wrong: a sibling whose
    // provisioning failed, a planned agent that was never provisioned, or a culled
    // agent no longer in the active population all fall outside the loop above.
    // Sandboxes that track every resource they ever started (DockerSandbox) expose
    // disposeAll() as an unconditional backstop; call it when the sandbox provides
    // one so nothing it started can outlive the run.
    const disposeAll = (this.d.sandbox as Partial<{ disposeAll: () => Promise<void> }>).disposeAll
    if (typeof disposeAll === 'function') {
      await disposeAll.call(this.d.sandbox).catch(() => {})
    }
  }
}

/** Marker for the driver's own timeout, so a runner's rejection is not mistaken for one. */
class DriverTimeout extends Error {
  constructor() {
    super('driver-enforced agent timeout')
  }
}
