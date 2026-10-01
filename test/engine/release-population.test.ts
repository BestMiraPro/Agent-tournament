import { describe, expect, test, vi } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import { AuditCollector } from '../../src/engine/audit.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import { MockAgentRunner, type AgentRunner } from '../../src/runtime/agent-runner.js'
import type { AgentHandle } from '../../src/runtime/sandbox.js'

function rig(opts: {
  releasePopulation?: () => Promise<void>
  runner?: AgentRunner
  audit?: AuditCollector
  populationSize?: number
  throwInJudge?: string
} = {}) {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: opts.populationSize ?? 2,
    sandbox: 'mock',
    concurrency: 2,
    roster: [{ modelId: 'mock/model', count: opts.populationSize ?? 2, temperature: 0.7 }],
  }
  const provider = new MockProvider(7)
  const sandbox = new MockSandbox()
  const audit = opts.audit ?? new AuditCollector(repos)
  const judge = new Judge(provider, config.judge, 7)
  if (opts.throwInJudge) {
    const message = opts.throwInJudge
    vi.spyOn(judge, 'score').mockRejectedValue(new Error(message))
  }
  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner: opts.runner ?? new MockAgentRunner(sandbox, 7),
    judge,
    reflector: new Reflector(provider, config.reflect, ['mock/model']),
    seedStrategy: () => 'strategy with alpha',
    ...(opts.releasePopulation ? { releasePopulation: opts.releasePopulation } : {}),
    audit,
  })
  return { db, repos, config, sandbox, audit, engine }
}

describe('engine releasePopulation boundary', () => {
  test('a successful round releases workers after the audit freeze and before grading', async () => {
    const order: string[] = []
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: 2,
      sandbox: 'mock',
      concurrency: 2,
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }
    const provider = new MockProvider(7)
    const sandbox = new MockSandbox()
    const audit = new AuditCollector(repos)
    const judge = new Judge(provider, config.judge, 7)
    const realFreeze = audit.freeze.bind(audit)
    vi.spyOn(audit, 'freeze').mockImplementation(((...args: Parameters<typeof realFreeze>) => {
      order.push('freeze')
      return realFreeze(...args)
    }) as typeof audit.freeze)
    const realScore = judge.score.bind(judge)
    vi.spyOn(judge, 'score').mockImplementation((async (...args: Parameters<typeof realScore>) => {
      order.push('score')
      return realScore(...args)
    }) as typeof judge.score)
    const engine = new TournamentEngine({
      repos,
      config,
      sandbox,
      runner: new MockAgentRunner(sandbox, 7),
      judge,
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: () => 'strategy with alpha',
      releasePopulation: async () => { order.push('release') },
      audit,
    })

    const run = engine.createRun('release-order', 'goal')
    const result = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(result.roundIdx).toBe(1)
    // The release ran between the freeze and the grading call.
    expect(order).toEqual(['freeze', 'release', 'score'])
    db.close()
  })

  test('a cleanup failure preserves the round result', async () => {
    const { engine, repos } = rig({
      releasePopulation: async () => { throw new Error('docker rm failed') },
    })
    const run = engine.createRun('release-fails', 'goal')
    const result = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(result.roundIdx).toBe(1)
    const round = repos.rounds.listForRun(run.id)[0]!
    expect(round.status).toBe('complete')
    expect(repos.scores.forRound(result.roundId)).toHaveLength(2)
  })

  test('the cleanup runs exactly once on success, not again from the finally path', async () => {
    const release = vi.fn(async () => {})
    const { engine } = rig({ releasePopulation: release })
    const run = engine.createRun('release-once', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('an aborted round still runs the cleanup without masking the abort', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let entered!: () => void
    const enteredGate = new Promise<void>((resolve) => { entered = resolve })
    const release = vi.fn(async () => {})
    const hanging = {
      async run(_handle: AgentHandle) {
        entered()
        await gate
        return {
          status: 'ok' as const, errorText: null,
          tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
          costUsd: 0, durationMs: 0,
        }
      },
      async abortAll() { releaseGate() },
    } satisfies AgentRunner
    const { engine, repos } = rig({ releasePopulation: release, runner: hanging, populationSize: 1 })
    const run = engine.createRun('release-abort', 'goal')

    const round = engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    // Abort mid-execution, after provisioning started a worker — not in preflight,
    // where nothing exists yet and there is nothing to clean.
    await enteredGate
    await engine.abortRound(run.id)
    await expect(round).rejects.toThrow(/aborted/)
    expect(release).toHaveBeenCalledTimes(1)
    const failed = repos.rounds.listForRun(run.id)[0]!
    expect(failed.status).toBe('failed')
  })

  test('a failing cleanup on a failed round keeps the original error', async () => {
    const { engine } = rig({
      releasePopulation: async () => { throw new Error('cleanup also failed') },
      throwInJudge: 'judge exploded',
      populationSize: 1,
    })
    const run = engine.createRun('release-masks-nothing', 'goal')
    await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }))
      .rejects.toThrow(/judge exploded/)
  })

  test('rounds without the dependency behave exactly as before', async () => {
    const { engine, repos } = rig()
    const run = engine.createRun('no-release', 'goal')
    const first = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const second = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(first.roundIdx).toBe(1)
    expect(second.roundIdx).toBe(2)
    expect(repos.rounds.listForRun(run.id)).toHaveLength(2)
  })
})
