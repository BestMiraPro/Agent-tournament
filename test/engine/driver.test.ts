import { describe, expect, test, vi } from 'vitest'
import { makeMockEngine, SABOTAGED_TEXT } from '../helpers/mock-engine.js'
import { parseGenome } from '../../src/core/genome.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import type { AgentHandle } from '../../src/runtime/sandbox.js'
import type { AgentRunContext, AgentRunner, AgentRunResult } from '../../src/runtime/agent-runner.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { RunManager } from '../../src/server/run-manager.js'

describe('TournamentEngine', () => {
  test('prepares the exact active population before every round', async () => {
    const plans: string[][] = []
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 6,
      preparePopulation: async (ids) => { plans.push([...ids]) },
    })
    const run = engine.createRun('test', 'goal')
    const originalIds = repos.agents.listActive(run.id).map((a) => a.id)

    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const beforeManualEdit = repos.agents.listActive(run.id)
    const retired = beforeManualEdit[0]!
    repos.agents.retire(retired.id, 2, 'retired')
    const added = repos.agents.create({
      runId: run.id,
      label: 'manual-add',
      parentAgentId: null,
      bornRound: 2,
    })
    repos.genomes.create({
      agentId: added.id,
      roundIdx: 2,
      strategyMd: 'manual strategy',
      notesMd: '',
      modelId: 'mock/model',
      temperature: 0.7,
      parentGenomeId: null,
      origin: 'seed',
    })
    const editedIds = repos.agents.listActive(run.id).map((a) => a.id)

    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(plans).toEqual([originalIds, editedIds])
    expect(plans[1]).toContain(added.id)
    expect(plans[1]).not.toContain(retired.id)
    expect(plans[1]).not.toEqual(plans[0])
  })

  test('a planning failure records a failed round and clears manager busy state', async () => {
    const { engine, repos, sandbox } = makeMockEngine({
      seed: 1,
      populationSize: 2,
      preparePopulation: async () => { throw new Error('planner exploded') },
    })
    const run = engine.createRun('test', 'goal')
    const provision = vi.spyOn(sandbox, 'provision')
    const manager = new RunManager(engine, () => {})

    manager.startRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(manager.isBusy(run.id)).toBe(true)
    await manager.waitForIdle(run.id)

    expect(manager.isBusy(run.id)).toBe(false)
    expect(manager.lastError(run.id)).toMatch(/planner exploded/)
    expect(repos.rounds.listForRun(run.id)).toHaveLength(1)
    expect(repos.rounds.listForRun(run.id)[0]!.status).toBe('failed')
    expect(provision).not.toHaveBeenCalled()
  })

  test('an abort during deferred planning prevents every agent from starting', async () => {
    let release!: () => void
    let entered!: () => void
    const planning = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const { engine, repos, sandbox } = makeMockEngine({
      seed: 1,
      populationSize: 2,
      preparePopulation: async () => {
        entered()
        await planning
      },
    })
    const run = engine.createRun('test', 'goal')
    const provision = vi.spyOn(sandbox, 'provision')
    const manager = new RunManager(engine, () => {})

    manager.startRound(run.id, { goalMd: 'goal', criteriaMd: null })
    await started
    expect(manager.abortRound(run.id)).toBe(true)
    release()
    await manager.waitForIdle(run.id)

    expect(provision).not.toHaveBeenCalled()
    expect(manager.lastError(run.id)).toMatch(/aborted/)
    expect(repos.rounds.listForRun(run.id)[0]!.status).toBe('failed')
  })

  test('seeds the population from the roster', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('test', 'write a good answer')
    expect(repos.agents.listActive(run.id)).toHaveLength(6)
  })

  test('a round produces one score per agent', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.scores.forRound(round.roundId)).toHaveLength(6)
  })

  test('a completed round is marked complete', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('population size is stable across rounds', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 10 })
    const run = engine.createRun('test', 'goal')
    for (let i = 0; i < 3; i++) await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.agents.listActive(run.id)).toHaveLength(10)
  })

  test('a failing agent does not abort the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 6, failFirst: true })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const scores = repos.scores.forRound(round.roundId)
    expect(scores).toHaveLength(6)
    expect(scores.some((s) => s.score === 0)).toBe(true)
  })

  test('writes the genome into the agent workspace so it can be read by an agent runner', async () => {
    const { engine, repos, sandbox } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const agent = repos.agents.listActive(run.id)[0]!
    const storedGenome = repos.genomes.forRound(agent.id, round.roundIdx)!

    const handle = { agentId: agent.id, workspacePath: '', baseUrl: '' }
    const written = await sandbox.readFile(handle, '.opencode/agents/competitor.md')
    expect(written).not.toBeNull()

    const parsed = parseGenome(written!)
    expect(parsed.strategyMd).toBe(storedGenome.strategyMd)
    expect(parsed.modelId).toBe(storedGenome.modelId)
    expect(parsed.temperature).toBe(storedGenome.temperature)
  })

  test('records the resolved criteria on the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('test', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: 'my rules' })
    const r = repos.rounds.get(round.roundId)!
    expect(r.criteriaMd).toBe('my rules')
    expect(r.criteriaSource).toBe('user')
  })

  test('a user criteria override before judging wins over the POST body', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('test', 'goal')
    // Simulate the override endpoint landing after the round row exists but before
    // judging begins: hook the preparing transition and write user criteria first.
    const setStatus = repos.rounds.setStatus.bind(repos.rounds)
    const hook = vi.spyOn(repos.rounds, 'setStatus').mockImplementation((id, status) => {
      setStatus(id, status)
      if (status === 'preparing') repos.rounds.setCriteria(id, 'row rules', 'user')
    })
    const scoreSpy = vi.spyOn(Judge.prototype, 'score')
    try {
      const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(scoreSpy).toHaveBeenCalled()
      expect(scoreSpy.mock.calls[0]![1]).toBe('row rules')
      const r = repos.rounds.get(round.roundId)!
      expect(r.criteriaMd).toBe('row rules')
      expect(r.criteriaSource).toBe('user')
    } finally {
      hook.mockRestore()
      scoreSpy.mockRestore()
    }
  })
})

describe('criteria persistence', () => {
  const CRITERIA = 'Calmar first\nOmega second'

  test('createRun stores the exact initial criteria, a blank as null, and legacy callers as null', () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 2 })
    expect(repos.runs.get(engine.createRun('a', 'goal', CRITERIA).id)!.initialCriteria).toBe(CRITERIA)
    expect(repos.runs.get(engine.createRun('b', 'goal', '  \n ').id)!.initialCriteria).toBeNull()
    expect(repos.runs.get(engine.createRun('c', 'goal').id)!.initialCriteria).toBeNull()
  })

  test('submitted criteria are on the round row before PREPARE, so a refresh during work shows them', async () => {
    // The row used to receive criteria only at the judging boundary, so for the whole of
    // PREPARE and WORK a reload showed the round as having no criteria at all.
    let inspect: () => void = () => {}
    const { engine, repos } = makeMockEngine({
      seed: 1, populationSize: 2,
      preparePopulation: async () => { inspect() },
    })
    const run = engine.createRun('r', 'goal')
    let duringPrepare: { criteriaMd: string | null; source: string } | null = null
    inspect = () => {
      const row = repos.rounds.listForRun(run.id).at(-1)!
      duringPrepare = { criteriaMd: row.criteriaMd, source: row.criteriaSource }
    }

    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: CRITERIA })
    expect(duringPrepare).toEqual({ criteriaMd: CRITERIA, source: 'user' })
    const row = repos.rounds.listForRun(run.id).at(-1)!
    expect(row.criteriaMd).toBe(CRITERIA)
    expect(row.criteriaSource).toBe('user')
  })

  test('without submitted criteria the row stays unset until judging generates them', async () => {
    let inspect: () => void = () => {}
    const { engine, repos } = makeMockEngine({
      seed: 1, populationSize: 2,
      preparePopulation: async () => { inspect() },
    })
    const run = engine.createRun('r', 'goal', 'creation default the round was not given')
    let duringPrepare: { criteriaMd: string | null; source: string } | null = null
    inspect = () => {
      const row = repos.rounds.listForRun(run.id).at(-1)!
      duringPrepare = { criteriaMd: row.criteriaMd, source: row.criteriaSource }
    }

    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    // Explicit null means generate: the creation default must not be applied behind it.
    expect(duringPrepare).toEqual({ criteriaMd: null, source: 'generated' })
    const row = repos.rounds.listForRun(run.id).at(-1)!
    expect(row.criteriaSource).toBe('generated')
    expect(row.criteriaMd).not.toBe('creation default the round was not given')
    expect(row.criteriaMd).not.toBeNull()
  })
})

describe('agent failure events', () => {
  // The September 13 incident: an OpenCode 500 whose ref maps to a model lookup failure.
  const FAILURE = {
    message: 'OpenCode returned HTTP 500 UnknownError (ref err_0672e772)',
    httpStatus: 500, code: 'UnknownError', ref: 'err_0672e772',
  }
  const isFirstAgent = (ctx: AgentRunContext) => ctx.genome.strategyMd.includes('variant 0,')
  const failingFirst = (make: (ctx: AgentRunContext) => Promise<AgentRunResult>) =>
    (inner: AgentRunner): AgentRunner => ({
      run: (handle, ctx) => (isFirstAgent(ctx) ? make(ctx) : inner.run(handle, ctx)),
      abortAll: () => inner.abortAll(),
      quiesce: (handle) => inner.quiesce!(handle),
    })
  const failedResult = async (): Promise<AgentRunResult> => ({
    status: 'error', errorText: 'OpenCode POST /session/ses_1/message failed: 500', failure: FAILURE, usageKnown: false,
    tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, durationMs: 5,
  })
  type StatusEvent = Extract<EngineEvent, { type: 'agent.status' }>

  test('a failed agent is reported with its failure and round as soon as its worker returns', async () => {
    const events: EngineEvent[] = []
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 2, onEvent: (e) => events.push(e), wrapRunner: failingFirst(failedResult),
    })
    const run = engine.createRun('r', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const failedIdx = events.findIndex((e) => e.type === 'agent.status' && e.status === 'failed')
    const failed = events[failedIdx] as StatusEvent
    expect(failed.failure).toEqual(FAILURE)
    expect(failed.roundIdx).toBe(1)
    // Immediately, not after collection or scoring finish.
    expect(failedIdx).toBeLessThan(events.findIndex((e) => e.type === 'round.status' && e.status === 'collecting'))

    // Usage the runner never learned is not published as a known zero.
    const usage = events.filter((e) => e.type === 'agent.usage') as Extract<EngineEvent, { type: 'agent.usage' }>[]
    expect(usage.map((u) => u.agentId)).not.toContain(failed.agentId)
    expect(usage).toHaveLength(1)
  })

  test('a runner that throws is still reported as failed at once, with its transport cause kept', async () => {
    // A thrown worker used to skip the failed emission entirely, so its card stayed on
    // "working" until the whole round ended — the path both Muse Spark agents took.
    const events: EngineEvent[] = []
    const { engine, repos } = makeMockEngine({
      seed: 1, populationSize: 2, onEvent: (e) => events.push(e),
      wrapRunner: failingFirst(async () => {
        throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
      }),
    })
    const run = engine.createRun('r', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const failed = events.find((e) => e.type === 'agent.status' && e.status === 'failed') as StatusEvent | undefined
    expect(failed?.failure?.code).toBe('UND_ERR_HEADERS_TIMEOUT')
    const submission = repos.submissions.forRound(round.roundId).find((s) => s.agentId === failed?.agentId)
    expect(submission?.errorText).toContain('UND_ERR_HEADERS_TIMEOUT')
  })

  test('a submission whose usage was never observed is stored as unknown, not as free', async () => {
    const lost = makeMockEngine({ seed: 1, populationSize: 2, wrapRunner: failingFirst(failedResult) })
    const lostRun = lost.engine.createRun('r', 'goal')
    const lostRound = await lost.engine.runRound(lostRun.id, { goalMd: 'goal', criteriaMd: null })
    const lostRows = lost.repos.submissions.forRound(lostRound.roundId)
    expect(lostRows.map((s) => s.usageKnown).sort()).toEqual([false, true])

    const thrown = makeMockEngine({
      seed: 1, populationSize: 2,
      wrapRunner: failingFirst(async () => { throw new TypeError('fetch failed') }),
    })
    const thrownRun = thrown.engine.createRun('r', 'goal')
    const thrownRound = await thrown.engine.runRound(thrownRun.id, { goalMd: 'goal', criteriaMd: null })
    expect(thrown.repos.submissions.forRound(thrownRound.roundId).map((s) => s.usageKnown).sort()).toEqual([false, true])
  })

  test('scores say which ranked agents had failed', async () => {
    const events: EngineEvent[] = []
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 2, onEvent: (e) => events.push(e), wrapRunner: failingFirst(failedResult),
    })
    const run = engine.createRun('r', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const failedId = (events.find((e) => e.type === 'agent.status' && e.status === 'failed') as StatusEvent).agentId
    const scored = events.find((e) => e.type === 'round.scored') as Extract<EngineEvent, { type: 'round.scored' }>
    expect(scored.scores.find((x) => x.agentId === failedId)?.failed).toBe(true)
    expect(scored.scores.find((x) => x.agentId !== failedId)?.failed).toBe(false)
  })
})

describe('cooperative abort', () => {
  test('abort during PREPARE: queued agents stop, runner and judge never called', async () => {
    const { engine, repos, sandbox } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    // Flip the flag inside the first provision call — i.e. after runRound's
    // start-clear has run, so the abort genuinely lands mid-round. Everything
    // after that call is synchronous pool setup, so exactly one provision runs.
    const origProvision = sandbox.provision.bind(sandbox)
    let provisions = 0
    const provisionSpy = vi
      .spyOn(sandbox, 'provision')
      .mockImplementation(async (agentId, opts) => {
        provisions++
        engine.abortRound(run.id)
        return origProvision(agentId, opts)
      })
    const runSpy = vi.spyOn(MockAgentRunner.prototype, 'run')
    const scoreSpy = vi.spyOn(Judge.prototype, 'score')
    try {
      await expect(
        engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }),
      ).rejects.toThrow(/round aborted/)
      expect(provisions).toBe(1)
      expect(runSpy).not.toHaveBeenCalled()
      expect(scoreSpy).not.toHaveBeenCalled()
      const failed = repos.rounds.listForRun(run.id)[0]!
      expect(failed.status).toBe('failed')
      expect(failed.endedAt).not.toBeNull()
      expect(failed.endedAt!).toBeGreaterThanOrEqual(failed.startedAt!)
      expect(failed.costUsd).toBe(0)
    } finally {
      provisionSpy.mockRestore()
      runSpy.mockRestore()
      scoreSpy.mockRestore()
    }
  })

  test('a stale flag with no round in flight never kills the next round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    // No round running: the manager refuses this, but a direct call must still
    // be harmless — runRound's start-clear drops it.
    engine.abortRound(run.id)
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('abort mid-RUN: runner sessions are aborted, round fails, judge never called', async () => {
    // Same concurrency-1 shape as the neighbouring test, but the abort is awaited so the
    // session abort has landed before the round settles — making "sessions aborted"
    // a fact rather than a race with the round's own failure.
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const orig = MockAgentRunner.prototype.run
    let calls = 0
    let inner: MockAgentRunner | undefined
    const runSpy = vi
      .spyOn(MockAgentRunner.prototype, 'run')
      .mockImplementation(async function (this: unknown, handle: AgentHandle, ctx: AgentRunContext) {
        calls++
        inner = this as MockAgentRunner
        if (calls === 1) {
          // Start the real run FIRST so this agent is genuinely in flight when the
          // abort lands — aborting before it starts would record nothing and prove
          // nothing. The mock tracks itself synchronously on entry, so no race.
          const running = orig.call(this, handle, ctx)
          await engine.abortRound(run.id)
          return running
        }
        return orig.call(this, handle, ctx)
      })
    const abortSpy = vi.spyOn(MockAgentRunner.prototype, 'abortAll')
    const scoreSpy = vi.spyOn(Judge.prototype, 'score')
    try {
      await expect(
        engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }),
      ).rejects.toThrow(/round aborted/)
      expect(calls).toBe(1)
      // The session abort ran to completion inside the abort above, through the
      // HugeTokensRunner wrapper down to the mock, which recorded the live agent.
      expect(abortSpy).toHaveBeenCalledTimes(1)
      expect(inner!.abortedIds).toHaveLength(1)
      expect(scoreSpy).not.toHaveBeenCalled()
      expect(repos.rounds.listForRun(run.id)[0]!.status).toBe('failed')
    } finally {
      runSpy.mockRestore()
      abortSpy.mockRestore()
      scoreSpy.mockRestore()
    }
  })

  test('abort mid-RUN: queued agents stop while the in-flight one completes', async () => {
    // hugeTokensFor forces concurrency 1, so flipping the flag inside the first
    // runner call guarantees agents 2-4 are still queued — a fact, not a race.
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const orig = MockAgentRunner.prototype.run
    let calls = 0
    const runSpy = vi
      .spyOn(MockAgentRunner.prototype, 'run')
      .mockImplementation(async function (this: unknown, handle: AgentHandle, ctx: AgentRunContext) {
        calls++
        if (calls === 1) engine.abortRound(run.id)
        return orig.call(this, handle, ctx)
      })
    const scoreSpy = vi.spyOn(Judge.prototype, 'score')
    try {
      await expect(
        engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }),
      ).rejects.toThrow(/round aborted/)
      expect(calls).toBe(1)
      expect(scoreSpy).not.toHaveBeenCalled()
      expect(repos.rounds.listForRun(run.id)[0]!.status).toBe('failed')
      // The next round starts clean — the abort flag did not linger.
      const next = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(repos.rounds.get(next.roundId)?.status).toBe('complete')
      expect(repos.submissions.forRound(next.roundId)).toHaveLength(4)
      expect(repos.scores.forRound(next.roundId)).toHaveLength(4)
    } finally {
      runSpy.mockRestore()
      scoreSpy.mockRestore()
    }
  })
})

describe('driver hardening', () => {
  test('persists one submission row per agent', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.submissions.forRound(round.roundId)).toHaveLength(4)
  })

  test('records round start, end and judge mode', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const r = repos.rounds.get(round.roundId)!
    expect(r.startedAt).toBeGreaterThan(0)
    expect(r.endedAt).toBeGreaterThan(0)
    expect(r.judgeMode).toBe('single_call')
  })

  test('assigns the top band to high performers', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 10 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const bands = new Set(repos.scores.forRound(round.roundId).map((s) => s.band))
    expect(bands.has('top')).toBe(true)
  })

  test('enforces the agent timeout even when the runner ignores it', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, hangingRunner: true })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const subs = repos.submissions.forRound(round.roundId)
    expect(subs.every((s) => s.status === 'timeout')).toBe(true)
  })

  test('rejects a roster whose counts do not sum to populationSize', () => {
    const { engine } = makeMockEngine({ seed: 1, populationSize: 4, rosterMismatch: true })
    expect(() => engine.createRun('t', 'goal')).toThrow(/populationSize/i)
  })

  test('an agent is excluded from its own top performers list', async () => {
    const { engine, reflector } = makeMockEngine({ seed: 1, populationSize: 6 })
    const run = engine.createRun('t', 'goal')

    // Spy on the actual calls the driver makes to Reflector.reflect, so the
    // assertion is about what reflection was actually shown rather than a
    // downstream side effect that could hold for unrelated reasons.
    const reflectSpy = vi.spyOn(reflector, 'reflect')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    // Sanity check the spy actually observed calls — otherwise the assertion
    // below would vacuously pass with zero iterations.
    expect(reflectSpy).toHaveBeenCalled()

for (const [req] of reflectSpy.mock.calls) {
      // TopPerformer carries rank/strategy/excerpt/rationale but no agent id.
      // Ranks are unique within a round, so a call whose own rank shows up
      // inside its own topPerformers list was handed itself as a leader to
      // imitate. Key on rank, not strategy text: clone agents legitimately
      // share identical strategy text, and a text comparison would
      // produce false positives (or mask a real self-inclusion bug).
      const selfRank = req.ownRank
      const sawSelf = req.topPerformers.some((tp) => tp.rank === selfRank)
      expect(sawSelf).toBe(false)
    }
  })

  test('reconfigure swaps in the new judge and new caps for the next round', async () => {
    const { engine, config } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('t', 'goal')

    // A different provider/judge plus a run-token cap a single round will blow.
    const newProvider = new MockProvider(7)
    const newConfig = {
      ...config,
      judge: { ...config.judge, modelId: 'new/judge' },
      budget: { ...config.budget, maxRunTokens: 1000 },
    }
    const newJudge = new Judge(newProvider, newConfig.judge, 1)
    const judgeSpy = vi.spyOn(newProvider, 'complete')
    engine.reconfigure(run.id, {
      config: newConfig,
      judge: newJudge,
      reflector: new Reflector(newProvider, config.reflect, ['mock/model']),
    })

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    // The new judge is the one that ran (the old provider would never be spied).
    expect(judgeSpy).toHaveBeenCalled()
    // The new cap is what the budget enforced.
    expect(round.budgetBreach).not.toBeNull()
    expect(round.budgetBreach!.reason).toMatch(/run token/i)
  })

  test('reconfigure rejects a run that was never created', () => {
    const { engine, config } = makeMockEngine({ seed: 1, populationSize: 2 })
    expect(() =>
      engine.reconfigure('nope', { config, judge: {} as never, reflector: {} as never }),
    ).toThrow(/createRun first/)
  })
})

describe('driver sandbox lifecycle', () => {
  test('tears down every agent workspace when the run is disposed', async () => {
    const { engine, repos, sandbox } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    await engine.dispose(run.id)
    const agents = repos.agents.listActive(run.id)
    const h = { agentId: agents[0]!.id, workspacePath: '', baseUrl: '' }
    await expect(sandbox.readFile(h as never, 'GOAL.md')).rejects.toThrow(/torn down/i)
  })

  test('a provisioning failure does not abort the round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, failProvisionFor: 1 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const scores = repos.scores.forRound(round.roundId)
    expect(scores).toHaveLength(4)
    expect(scores.filter((s) => s.score === 0).length).toBeGreaterThanOrEqual(1)
  })
})

describe('driver capture guardrails', () => {
  test('an agent exceeding the workspace quota is scored zero', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const subs = repos.submissions.forRound(round.roundId)
    const flooded = subs.find((s) => s.status === 'error' && /limit/i.test(s.errorText ?? ''))
    expect(flooded).toBeDefined()

    const score = repos.scores.forRound(round.roundId).find((s) => s.agentId === flooded!.agentId)
    expect(score?.score).toBe(0)
  })

  test('the round completes despite a quota violation', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('an agent within the quota is judged normally', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, floodFilesFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const subs = repos.submissions.forRound(round.roundId)
    expect(subs.filter((s) => s.status === 'ok')).toHaveLength(2)
  })

  // The window this closes: a rival sharing the container overwrites a workspace after
  // its owner has finished. The substituted text must never become the judged artifact.
  test('a rival cannot get a substituted submission judged', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, sabotageBy: 1 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const sub = repos.submissions.forRound(round.roundId).find((s) => s.agentId === victim.id)!
    expect(sub.submissionMd).not.toBe(SABOTAGED_TEXT)
    expect(sub.submissionMd).toContain('Approach:')
  })

  test('the substitution is recorded as a tamper event against the victim', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, sabotageBy: 1 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const events = repos.events
      .forRun(run.id)
      .filter((e) => e.type === 'submission.tampered' && e.agentId === victim.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.payload.detail).toMatch(/modified/i)
    // Every agent was confirmed stopped before COLLECT re-read the workspace, so the
    // verdict is a finding rather than an observation that might already be stale.
    expect(events[0]!.payload.verified).toBe(true)
  })

  test('an untampered agent produces no tamper event', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3, sabotageBy: 1 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const saboteur = repos.agents.listActive(run.id)[1]!
    const events = repos.events
      .forRun(run.id)
      .filter((e) => e.type === 'submission.tampered' && e.agentId === saboteur.id)
    expect(events).toHaveLength(0)
  })

  // If any agent in the round could not be confirmed stopped, a co-tenant may still be
  // writing, so nothing captured that round can honestly be called verified.
  test('nothing is certified when an agent cannot be confirmed stopped', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 3,
      sabotageBy: 1,
      unstoppableSaboteur: true,
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const event = repos.events
      .forRun(run.id)
      .find((e) => e.type === 'submission.tampered' && e.agentId === victim.id)!
    expect(event.payload.detail).toMatch(/modified/i)
    expect(event.payload.verified).toBe(false)
  })

  // Amendment (A). The window the earlier design left open: the substitution lands
  // BEFORE the orchestrator's read, so the bytes on record are already the rival's and
  // every later re-read agrees with them. Nothing host-side can recover the victim's
  // text here — what must never happen is the system stamping the rival's file as the
  // victim's own verified work.
  test('a substitution during the capture read cannot be certified as intact', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 3,
      sabotageDuringCapture: true,
    })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const victim = repos.agents.listActive(run.id)[0]!
    const sub = repos.submissions.forRound(round.roundId).find((s) => s.agentId === victim.id)!
    // The rival's text did land — this is the irreducible part.
    expect(sub.submissionMd).toBe(SABOTAGED_TEXT)

    const event = repos.events
      .forRun(run.id)
      .find((e) => e.type === 'submission.captured' && e.agentId === victim.id)!
    // Every agent stopped and every file hashed, so the ONLY thing standing between the
    // rival's file and a clean bill of health is the capture being unsealed.
    expect(event.payload.tampered).toBe(false)
    expect(event.payload.sealed).toBe(false)
    expect(event.payload.verified).toBe(false)
  })

  test('a shared workspace is never sealed, however cleanly the round ran', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3 })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const captured = repos.events.forRun(run.id).filter((e) => e.type === 'submission.captured')
    expect(captured).toHaveLength(3)
    for (const e of captured) expect(e.payload.verified).toBe(false)
  })

  // The other side of the same rule: give an agent a workspace nobody else can reach and
  // the capture becomes certifiable, so the flag is a real distinction and not a
  // constant `false` dressed up as a safety property.
  test('an isolated workspace yields a sealed, verified-intact capture', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1,
      populationSize: 3,
      isolatedWorkspaces: true,
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const captured = repos.events.forRun(run.id).filter((e) => e.type === 'submission.captured')
    expect(captured).toHaveLength(3)
    for (const e of captured) {
      expect(e.payload.sealed).toBe(true)
      expect(e.payload.tampered).toBe(false)
      expect(e.payload.verified).toBe(true)
    }
  })
})

describe('driver budget enforcement', () => {
  test('a round that breaches the budget still completes, and the breach is reported', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
    expect(round.budgetBreach).not.toBeNull()
    expect(round.budgetBreach?.reason).toMatch(/token/i)

    // The rest of the round still ran: every agent was scored, including the one that
    // blew the budget — that work is paid for either way.
    expect(repos.scores.forRound(round.roundId)).toHaveLength(4)
  })

  test('reflection is skipped once the round breaches budget, so survivor genomes carry forward unchanged', async () => {
    const { engine, repos, reflector } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const reflectSpy = vi.spyOn(reflector, 'reflect')

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(round.budgetBreach).not.toBeNull()
    expect(reflectSpy).not.toHaveBeenCalled()

    // Rank 2 is a survivor (population 4: 1 elite, 0 culled at these selection
    // defaults), so under normal operation reflection would be free to mutate it.
    const survivor = repos.scores.forRound(round.roundId).find((s) => s.rank === 2)!
    const before = repos.genomes.forRound(survivor.agentId, round.roundIdx)!
    const after = repos.genomes.forRound(survivor.agentId, round.roundIdx + 1)!
    expect(after.strategyMd).toBe(before.strategyMd)
    expect(after.notesMd).toBe(before.notesMd)
    expect(after.modelId).toBe(before.modelId)
    expect(after.temperature).toBe(before.temperature)
  })

  test('a budget breach skips paid crossover recombination and still persists a full next population', async () => {
    const { engine, repos, reflector, config } = makeMockEngine({
      seed: 1,
      populationSize: 4,
      hugeTokensFor: 0,
    })
    config.selection = { ...config.selection, eliteCount: 1, topPct: 0.5, bottomPct: 0.5, crossoverPct: 1 }
    const run = engine.createRun('t', 'goal')
    const reflectSpy = vi.spyOn(reflector, 'reflect')
    const recombineSpy = vi.spyOn(reflector, 'recombine')

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(round.budgetBreach).not.toBeNull()
    expect(reflectSpy).not.toHaveBeenCalled()
    expect(recombineSpy).not.toHaveBeenCalled()
    const active = repos.agents.listActive(run.id)
    expect(active).toHaveLength(4)
    for (const agent of active) {
      expect(repos.genomes.forRound(agent.id, round.roundIdx + 1)).not.toBeNull()
    }
  })

  test('a within-budget crossover uses paid recombination', async () => {
    const { engine, reflector, config } = makeMockEngine({ seed: 1, populationSize: 4 })
    config.selection = { ...config.selection, eliteCount: 1, topPct: 0.5, bottomPct: 0.5, crossoverPct: 1 }
    const run = engine.createRun('t', 'goal')
    const recombineSpy = vi.spyOn(reflector, 'recombine')

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(round.budgetBreach).toBeNull()
    expect(recombineSpy).toHaveBeenCalledTimes(2)
  })

  test('two judge failures recover a full population in the third round', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const originalAgents = repos.agents.listActive(run.id)
    const originalRun = MockAgentRunner.prototype.run
    const runnerSpy = vi.spyOn(MockAgentRunner.prototype, 'run').mockImplementation(async function (this: MockAgentRunner, handle, ctx) {
      const result = await originalRun.call(this, handle, ctx)
      return { ...result, costUsd: 0.25 }
    })
    const judgeSpy = vi.spyOn(Judge.prototype, 'score')
      .mockRejectedValueOnce(new Error('first judge failure'))
      .mockRejectedValueOnce(new Error('second judge failure'))
    try {
      await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }))
        .rejects.toThrow('first judge failure')
      const failed = repos.rounds.listForRun(run.id)[0]!
      expect(failed.status).toBe('failed')
      expect(failed.endedAt).not.toBeNull()
      expect(failed.endedAt!).toBeGreaterThanOrEqual(failed.startedAt!)
      expect(failed.costUsd).toBe(1)

      await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }))
        .rejects.toThrow('second judge failure')
      const third = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(repos.submissions.forRound(third.roundId)).toHaveLength(4)
      expect(repos.scores.forRound(third.roundId)).toHaveLength(4)
      for (const agent of originalAgents) {
        const recovered = repos.genomes.forRound(agent.id, third.roundIdx)!
        const previous = repos.genomes.forRound(agent.id, third.roundIdx - 1)!
        expect(recovered.parentGenomeId).toBe(previous.id)
        expect(repos.submissions.forRound(third.roundId)
          .find((submission) => submission.agentId === agent.id)?.genomeId).toBe(recovered.id)
      }
    } finally {
      runnerSpy.mockRestore()
      judgeSpy.mockRestore()
    }
  })

  test('PREPARE preserves an exact next-round genome during recovery', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('t', 'goal')
    const judgeSpy = vi.spyOn(Judge.prototype, 'score').mockRejectedValueOnce(new Error('judge failed'))
    try {
      await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })).rejects.toThrow('judge failed')
      const agent = repos.agents.listActive(run.id)[0]!
      const seed = repos.genomes.forRound(agent.id, 1)!
      const exact = repos.genomes.create({
        agentId: agent.id,
        roundIdx: 2,
        strategyMd: 'already evolved strategy',
        notesMd: 'already evolved notes',
        modelId: seed.modelId,
        temperature: seed.temperature,
        parentGenomeId: seed.id,
        origin: 'mutation',
      })

      const recovered = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(repos.genomes.forRound(agent.id, recovered.roundIdx)).toEqual(exact)
      expect(repos.submissions.forRound(recovered.roundId)
        .find((submission) => submission.agentId === agent.id)?.genomeId).toBe(exact.id)
    } finally {
      judgeSpy.mockRestore()
    }
  })

  test('PREPARE fails clearly for an active agent without genome history', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('t', 'goal')
    const orphan = repos.agents.create({
      runId: run.id,
      label: 'orphan',
      parentAgentId: null,
      bornRound: 1,
    })

    await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }))
      .rejects.toThrow(`active agent ${orphan.id} has no genome history`)
  })

  test('failed-round end bookkeeping cannot mask the original judge error', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('t', 'goal')
    const judgeSpy = vi.spyOn(Judge.prototype, 'score').mockRejectedValueOnce(new Error('judge failed'))
    const endSpy = vi.spyOn(repos.rounds, 'markEnded').mockImplementation(() => {
      throw new Error('end bookkeeping failed')
    })
    try {
      await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })).rejects.toThrow('judge failed')
      expect(repos.rounds.listForRun(run.id)[0]!.status).toBe('failed')
    } finally {
      endSpy.mockRestore()
      judgeSpy.mockRestore()
    }
  })

  test('failed-round status bookkeeping cannot mask the original judge error', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('t', 'goal')
    const judgeSpy = vi.spyOn(Judge.prototype, 'score').mockRejectedValueOnce(new Error('judge failed'))
    const setStatus = repos.rounds.setStatus.bind(repos.rounds)
    const statusSpy = vi.spyOn(repos.rounds, 'setStatus').mockImplementation((id, status) => {
      if (status === 'failed') throw new Error('failed-status bookkeeping failed')
      setStatus(id, status)
    })
    try {
      await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })).rejects.toThrow('judge failed')
    } finally {
      statusSpy.mockRestore()
      judgeSpy.mockRestore()
    }
  })

  test('a run under budget behaves exactly as before', async () => {
    const { engine, repos, reflector } = makeMockEngine({ seed: 1, populationSize: 4 })
    const run = engine.createRun('t', 'goal')
    const reflectSpy = vi.spyOn(reflector, 'reflect')

    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    expect(round.budgetBreach).toBeNull()
    expect(reflectSpy).toHaveBeenCalled()
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
    expect(repos.scores.forRound(round.roundId)).toHaveLength(4)
  })

  // makeMockEngine forces concurrency to 1 whenever hugeTokensFor is set, so agent 0
  // (the one carrying the marker) is guaranteed to run and record BEFORE the pool ever
  // pulls agents 1-3 off the queue — making "later agents were never dispatched" a fact
  // instead of a race. This is the guardrail the isolation tests warn a project like
  // this one can ship plumbed but mute: `shouldStopDispatch` exists and is called, but
  // nothing proves it ever actually stops a dispatch without a test shaped like this one.
  test('shouldStopDispatch stops agents still queued once an earlier one blows the budget', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 4, hugeTokensFor: 0 })
    const run = engine.createRun('t', 'goal')
    const agents = repos.agents.listActive(run.id)
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

    const subs = repos.submissions.forRound(round.roundId)
    const byAgent = new Map(subs.map((s) => [s.agentId, s]))

    // Agent 0 actually ran (it is the one that blew the budget, not a casualty of it).
    const first = byAgent.get(agents[0]!.id)!
    expect(first.status).toBe('ok')
    expect(first.tokensIn).toBe(2_000_000)

    // Agents 1-3 were still queued when agent 0's usage tripped the round cap, so the
    // pool must never have called the runner for them at all.
    for (const agent of agents.slice(1)) {
      const sub = byAgent.get(agent.id)!
      expect(sub.status).toBe('error')
      expect(sub.errorText).toMatch(/dispatch skipped/i)
      expect(sub.tokensIn).toBe(0)
    }
  })
})

describe('driver event emission', () => {
  test('emits round status transitions in lifecycle order', async () => {
    const seen: string[] = []
    const { engine, } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => { if (e.type === 'round.status') seen.push(e.status) },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(seen).toContain('running')
    expect(seen).toContain('judging')
    expect(seen.at(-1)).toBe('complete')
  })

  test('emits a status per agent, ending in done or failed', async () => {
    const byAgent = new Map<string, string[]>()
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => {
        if (e.type === 'agent.status') {
          byAgent.set(e.agentId, [...(byAgent.get(e.agentId) ?? []), e.status])
        }
      },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(byAgent.size).toBe(4)
    for (const statuses of byAgent.values()) {
      expect(statuses).toContain('running')
      expect(['done', 'failed']).toContain(statuses.at(-1))
    }
  })

  test('emits scores once judging completes', async () => {
    let scored: { agentId: string; rank: number }[] = []
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 4,
      onEvent: (e) => { if (e.type === 'round.scored') scored = e.scores },
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(scored).toHaveLength(4)
    expect(scored.map((s) => s.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  test('a subscriber that throws does not fail the round', async () => {
    const { engine, repos } = makeMockEngine({
      seed: 1, populationSize: 3,
      onEvent: () => { throw new Error('subscriber exploded') },
    })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })

  test('emits nothing when no sink is provided', async () => {
    const { engine, repos } = makeMockEngine({ seed: 1, populationSize: 3 })
    const run = engine.createRun('t', 'goal')
    const round = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(repos.rounds.get(round.roundId)?.status).toBe('complete')
  })
})

describe('runRound on a run the engine does not know', () => {
  test('rejects without leaving a round behind', async () => {
    // The budget tracker lives in memory, so after a restart a persisted run has none.
    // The round row was created and marked started BEFORE that check, so a rejection
    // left a started round that recovery then marked failed — a spurious failure in the
    // run's history for a request that should have been refused cleanly.
    const base = makeMockEngine({ seed: 1, populationSize: 2 })
    try {
      // A run row in the database that was never registered with this engine — exactly
      // what a persisted run looks like to a freshly started process.
      const run = base.repos.runs.create({
        name: 'from a previous process', config: base.config, seedDir: null,
      })

      await expect(base.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null }))
        .rejects.toThrow(/budget tracker/i)
      expect(base.repos.rounds.listForRun(run.id)).toHaveLength(0)
    } finally {
      base.db.close()
    }
  })
})

describe('reconfigure is scoped to one run', () => {
  /**
   * The default dashboard engine is SHARED by every legacy run, so a reconfigure that
   * assigns engine-wide state changes the config of runs nobody touched. The budget
   * tracker was already per-run; `config`, `judge` and `reflector` were not.
   */
  test('reconfiguring one run leaves another run on the same engine alone', async () => {
    const base = makeMockEngine({ seed: 1, populationSize: 2 })
    try {
      const patched = base.engine.createRun('patched', 'goal')
      const untouched = base.engine.createRun('untouched', 'goal')

      // A quota of zero files is a config value read per round, so its effect is visible
      // in the submission rows rather than only in a getter.
      base.engine.reconfigure(patched.id, {
        config: { ...base.config, maxWorkspaceFiles: 0 },
        judge: base.judge,
        reflector: base.reflector,
      })

      const patchedRound = await base.engine.runRound(patched.id, { goalMd: 'g', criteriaMd: null })
      const untouchedRound = await base.engine.runRound(untouched.id, { goalMd: 'g', criteriaMd: null })

      const statusesFor = (roundId: string) =>
        base.repos.submissions.forRound(roundId).map((s) => s.status)
      expect(statusesFor(patchedRound.roundId).every((s) => s === 'error')).toBe(true)
      expect(statusesFor(untouchedRound.roundId).some((s) => s === 'error')).toBe(false)
    } finally {
      base.db.close()
    }
  })

  test('a reconfigured run uses the new config on its next round', async () => {
    const base = makeMockEngine({ seed: 1, populationSize: 2 })
    try {
      const run = base.engine.createRun('r', 'goal')
      const before = await base.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
      expect(base.repos.submissions.forRound(before.roundId).some((s) => s.status === 'error')).toBe(false)

      base.engine.reconfigure(run.id, {
        config: { ...base.config, maxWorkspaceFiles: 0 },
        judge: base.judge,
        reflector: base.reflector,
      })

      const after = await base.engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
      expect(base.repos.submissions.forRound(after.roundId).every((s) => s.status === 'error')).toBe(true)
    } finally {
      base.db.close()
    }
  })
})
