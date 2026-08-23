import { planSelection } from '../core/selection.js'
import type { Genome, RunConfig } from '../core/types.js'
import type { Repos } from '../db/repos.js'
import { breed } from '../evolution/breed.js'
import type { Reflector } from '../evolution/reflect.js'
import type { TopPerformer } from '../evolution/prompts.js'
import type { Judge, JudgeInput } from '../judge/judge.js'
import type { AgentRunner } from '../runtime/agent-runner.js'
import { runPool } from '../runtime/pool.js'
import type { Sandbox } from '../runtime/sandbox.js'

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

    try {
      // PREPARE
      repos.rounds.setStatus(round.id, 'preparing')
      const agents = repos.agents.listActive(runId)
      const prepared = agents.flatMap((a) => {
        const genome = repos.genomes.forRound(a.id, roundIdx)
        return genome ? [{ agent: a, genome }] : []
      })

      const handles = new Map<string, Awaited<ReturnType<Sandbox['provision']>>>()
      for (const p of prepared) {
        const h = await this.d.sandbox.provision(p.agent.id, {
          seedDir: config.seedDir ?? undefined,
        })
        await this.d.sandbox.reset(h, { seedDir: config.seedDir ?? undefined })
        await this.d.sandbox.writeFile(h, 'NOTES.md', p.genome.notesMd)
        await this.d.sandbox.writeFile(h, 'GOAL.md', input.goalMd)
        handles.set(p.agent.id, h)
      }

      // RUN
      repos.rounds.setStatus(round.id, 'running')
      const runResults = await runPool(prepared, config.concurrency, async (p) =>
        this.d.runner.run(handles.get(p.agent.id)!, {
          agentId: p.agent.id,
          genome: p.genome,
          goalMd: input.goalMd,
          timeoutMs: config.agentTimeoutMs,
        }),
      )

      // COLLECT
      repos.rounds.setStatus(round.id, 'collecting')
      const judgeInputs: JudgeInput[] = []
      for (const [i, p] of prepared.entries()) {
        const res = runResults[i]!
        const handle = handles.get(p.agent.id)!
        const submissionMd = res.ok ? await this.d.sandbox.readFile(handle, 'SUBMISSION.md') : null
        const files = res.ok ? await this.d.sandbox.listFiles(handle) : []
        judgeInputs.push({
          agentId: p.agent.id,
          submissionMd: submissionMd ?? '',
          files,
          status: !res.ok ? 'error' : submissionMd ? res.value.status : 'no_submission',
        })
      }

      // JUDGE
      repos.rounds.setStatus(round.id, 'judging')
      const { criteriaMd, source } = await this.d.judge.resolveCriteria(
        input.goalMd,
        input.criteriaMd,
      )
      repos.rounds.setCriteria(round.id, criteriaMd, source)
      const judged = await this.d.judge.score(input.goalMd, criteriaMd, judgeInputs)
      repos.rounds.setDigest(round.id, judged.metaDigest)

      // EVOLVE
      repos.rounds.setStatus(round.id, 'evolving')
      const plan = planSelection(
        judged.scores.map((s) => ({ agentId: s.agentId, rank: s.rank, score: s.score })),
        config.selection,
      )
      const bandOf = (agentId: string) =>
        plan.elite.includes(agentId) ? 'elite' as const
        : plan.culled.includes(agentId) ? 'bottom' as const
        : 'middle' as const
      repos.scores.insertMany(
        round.id,
        judged.scores.map((s) => ({
          roundId: round.id, agentId: s.agentId, rank: s.rank,
          score: s.score, rationaleMd: s.rationaleMd, band: bandOf(s.agentId),
        })),
      )

      // REFLECT
      repos.rounds.setStatus(round.id, 'reflecting')
      const byAgent = new Map(judged.scores.map((s) => [s.agentId, s]))
      const subByAgent = new Map(judgeInputs.map((j) => [j.agentId, j]))
      const topPerformers: TopPerformer[] = judged.scores
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
          topPerformers,
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

      repos.rounds.setStatus(round.id, 'complete')
      return { roundId: round.id, roundIdx, metaDigest: judged.metaDigest }
    } catch (e) {
      repos.rounds.setStatus(round.id, 'failed')
      throw e
    }
  }
}
