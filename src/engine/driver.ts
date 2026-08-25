import { serializeGenome } from '../core/genome.js'
import { planSelection } from '../core/selection.js'
import type { Genome, RunConfig, SubmissionStatus } from '../core/types.js'
import type { Repos } from '../db/repos.js'
import { breed } from '../evolution/breed.js'
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
}

export interface RoundResult {
  roundId: string
  roundIdx: number
  metaDigest: string
}

export class TournamentEngine {
  constructor(private d: EngineDeps) {}

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

    const run = repos.runs.create({ name, config, seedDir: config.seedDir })

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

  async runRound(
    runId: string,
    input: { goalMd: string; criteriaMd: string | null },
  ): Promise<RoundResult> {
    const { repos, config } = this.d
    const roundIdx = repos.rounds.lastIdx(runId) + 1
    const round = repos.rounds.create({ runId, idx: roundIdx, goalMd: input.goalMd })
    repos.rounds.markStarted(round.id)

    try {
      // PREPARE
      repos.rounds.setStatus(round.id, 'preparing')
      const agents = repos.agents.listActive(runId)
      const prepared = agents.flatMap((a) => {
        const genome = repos.genomes.forRound(a.id, roundIdx)
        return genome ? [{ agent: a, genome }] : []
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
      // The timeout is enforced here, not delegated to the runner: a runner that
      // ignores or mishandles `timeoutMs` would otherwise hang the whole round.
      const runResults = await runPool(prepared, config.concurrency, async (p) => {
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
          return failed
        }

        const started = Date.now()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            this.d.runner.run(handles.get(p.agent.id)!, {
              agentId: p.agent.id,
              genome: p.genome,
              goalMd: input.goalMd,
              timeoutMs: config.agentTimeoutMs,
            }),
            new Promise<never>((_r, reject) => {
              timer = setTimeout(() => reject(new DriverTimeout()), config.agentTimeoutMs)
            }),
          ])
        } catch (e) {
          if (e instanceof DriverTimeout) {
            const timedOut: AgentRunResult = {
              status: 'timeout',
              errorText: `driver timeout after ${config.agentTimeoutMs}ms`,
              tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
              costUsd: 0, durationMs: Date.now() - started,
            }
            return timedOut
          }
          throw e
        } finally {
          // Without this the loser of the race keeps a timer alive for the full
          // agentTimeoutMs after every round, holding the process open.
          clearTimeout(timer)
        }
      })

      // COLLECT
      repos.rounds.setStatus(round.id, 'collecting')
      const judgeInputs: JudgeInput[] = []
      for (const [i, p] of prepared.entries()) {
        const res = runResults[i]!
        // No handle exists when this agent's own provisioning failed: there is no
        // workspace to read a submission from.
        const handle = handles.get(p.agent.id)
        const submissionMd = res.ok && handle ? await this.d.sandbox.readFile(handle, 'SUBMISSION.md') : null
        const files = res.ok && handle ? await this.d.sandbox.listFiles(handle) : []

        // A non-'ok' runner status is the actual reason there is nothing to judge and
        // must survive to the submission row. Deriving the status from the file alone
        // rewrote every 'timeout' as 'no_submission', which made the driver-enforced
        // timeout invisible in the database.
        const status: SubmissionStatus = !res.ok
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
          errorText: res.ok ? res.value.errorText : String(res.error).slice(0, 500),
          tokensIn: res.ok ? res.value.tokensIn : 0,
          tokensOut: res.ok ? res.value.tokensOut : 0,
          tokensCacheRead: res.ok ? res.value.tokensCacheRead : 0,
          tokensCacheWrite: res.ok ? res.value.tokensCacheWrite : 0,
          costUsd: res.ok ? res.value.costUsd : 0,
          durationMs: res.ok ? res.value.durationMs : 0,
        })
      }

      // JUDGE
      repos.rounds.setStatus(round.id, 'judging')
      const { criteriaMd, source } = await this.d.judge.resolveCriteria(
        input.goalMd,
        input.criteriaMd,
      )
      repos.rounds.setCriteria(round.id, criteriaMd, source)
      const judged = await this.d.judge.score(input.goalMd, criteriaMd, judgeInputs, roundIdx)
      repos.rounds.setDigest(round.id, judged.metaDigest)
      // The judge may fall back from single_call to batched_finals, so record what
      // actually ran rather than what was configured.
      repos.rounds.setJudgeMode(round.id, judged.mode)

      // EVOLVE
      repos.rounds.setStatus(round.id, 'evolving')
      const plan = planSelection(
        judged.scores.map((s) => ({ agentId: s.agentId, rank: s.rank, score: s.score })),
        config.selection,
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

      // REFLECT
      repos.rounds.setStatus(round.id, 'reflecting')
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

      const mutated = new Map<string, Genome>()
      for (const r of reflected) if (r.ok) mutated.set(r.value[0], r.value[1])

      await breed({ repos, runId, nextRoundIdx: roundIdx + 1, plan, mutated })

      repos.rounds.markEnded(round.id, repos.submissions.totalCost(round.id))
      repos.rounds.setStatus(round.id, 'complete')
      return { roundId: round.id, roundIdx, metaDigest: judged.metaDigest }
    } catch (e) {
      repos.rounds.setStatus(round.id, 'failed')
      throw e
    }
  }

  /** Releases sandbox resources. With Docker this stops the shard containers. */
  async dispose(runId: string): Promise<void> {
    const agents = this.d.repos.agents.listActive(runId)
    for (const a of agents) {
      await this.d.sandbox
        .teardown({ agentId: a.id, workspacePath: '', baseUrl: '' })
        .catch(() => {})
    }
  }
}

/** Marker for the driver's own timeout, so a runner's rejection is not mistaken for one. */
class DriverTimeout extends Error {
  constructor() {
    super('driver-enforced agent timeout')
  }
}
