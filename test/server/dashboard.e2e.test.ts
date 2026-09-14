import { describe, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import { buildApi } from '../../src/server/api.js'
import { composeRun } from '../../src/server/compose-run.js'
import { RunRegistry } from '../../src/server/runs.js'
import { RunManager } from '../../src/server/run-manager.js'
import { EventBroadcaster } from '../../src/server/ws.js'
import { createDashboard } from '../../src/server/create-dashboard.js'

describe('dashboard end to end', () => {
  test('criteria cannot change after judging starts, so the recorded criteria match scoring', async () => {
    const dashboard = createDashboard({ population: 2 })
    let releaseCriteria!: () => void
    const criteriaGate = new Promise<void>((resolve) => { releaseCriteria = resolve })
    let enteredJudging!: () => void
    const judgingStarted = new Promise<void>((resolve) => { enteredJudging = resolve })
    const resolveSpy = vi.spyOn(Judge.prototype, 'resolveCriteria').mockImplementation(async () => {
      enteredJudging()
      await criteriaGate
      return { criteriaMd: 'resolved scoring criteria', source: 'generated' }
    })
    const scoreSpy = vi.spyOn(Judge.prototype, 'score')

    try {
      const created = await dashboard.app.inject({
        method: 'POST', url: '/api/runs', payload: { name: 'criteria freeze', goal: 'g' },
      })
      const { runId } = JSON.parse(created.body) as { runId: string }
      const started = await dashboard.app.inject({
        method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' },
      })
      expect(started.statusCode).toBe(202)

      await judgingStarted
      const override = await dashboard.app.inject({
        method: 'POST', url: `/api/runs/${runId}/rounds/1/criteria`, payload: { criteriaMd: 'late criteria' },
      })
      expect(override.statusCode).toBe(409)

      releaseCriteria()
      await dashboard.manager.waitForIdle(runId)
      const round = dashboard.repos.rounds.listForRun(runId)[0]!
      expect(round.criteriaMd).toBe('resolved scoring criteria')
      expect(scoreSpy).toHaveBeenCalledWith('g', 'resolved scoring criteria', expect.anything(), 1)
    } finally {
      releaseCriteria?.()
      resolveSpy.mockRestore()
      scoreSpy.mockRestore()
      await dashboard.shutdown()
    }
  })

  test('creation criteria persist, show before round 1, apply to the round, and stay per run', async () => {
    // Setup criteria used to live only in a browser variable: the textbox showed nothing,
    // a reload lost them, and they could still be sent behind the operator's back.
    const CRITERIA = 'Calmar first\nOmega second'
    const dashboard = createDashboard({ population: 2 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const judging = new Promise<void>((resolve) => { entered = resolve })
    const original = Judge.prototype.resolveCriteria
    const resolveSpy = vi.spyOn(Judge.prototype, 'resolveCriteria').mockImplementation(
      async function (this: Judge, goalMd: string, criteriaMd: string | null) {
        entered()
        await gate
        return original.call(this, goalMd, criteriaMd)
      },
    )
    const snapshot = async (runId: string) =>
      JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body)

    try {
      const roster = [{ modelId: 'mock/model', count: 2, temperature: 0.7 }]
      const createdA = await dashboard.app.inject({
        method: 'POST', url: '/api/runs',
        payload: { name: 'A', goal: 'g', sandbox: 'mock', roster, criteria: CRITERIA },
      })
      expect(createdA.statusCode).toBe(201)
      const { runId: a } = JSON.parse(createdA.body) as { runId: string }
      const createdB = await dashboard.app.inject({
        method: 'POST', url: '/api/runs',
        payload: { name: 'B', goal: 'g', sandbox: 'mock', roster, criteria: null },
      })
      const { runId: b } = JSON.parse(createdB.body) as { runId: string }
      const createdLegacy = await dashboard.app.inject({
        method: 'POST', url: '/api/runs', payload: { name: 'L', goal: 'g', criteria: 'legacy rules' },
      })
      const { runId: legacy } = JSON.parse(createdLegacy.body) as { runId: string }

      expect((await snapshot(a)).initialCriteria).toBe(CRITERIA)
      expect((await snapshot(a)).lastRoundCriteria).toBeNull()
      expect((await snapshot(b)).initialCriteria).toBeNull()
      expect((await snapshot(legacy)).initialCriteria).toBe('legacy rules')

      const started = await dashboard.app.inject({
        method: 'POST', url: `/api/runs/${a}/rounds`, payload: { goalMd: 'g', criteriaMd: CRITERIA },
      })
      expect(started.statusCode).toBe(202)

      // Mid-round, before criteria resolve, a refresh still returns what was submitted.
      await judging
      expect((await snapshot(a)).lastRoundCriteria).toMatchObject({ roundIdx: 1, criteriaMd: CRITERIA, source: 'user' })
      expect((await snapshot(b)).lastRoundCriteria).toBeNull()

      release()
      await dashboard.registry.get(a)!.manager.waitForIdle(a)
      const round = dashboard.repos.rounds.listForRun(a)[0]!
      expect(round.criteriaMd).toBe(CRITERIA)
      expect(round.criteriaSource).toBe('user')
      expect((await snapshot(b)).initialCriteria).toBeNull()
    } finally {
      release?.()
      resolveSpy.mockRestore()
      await dashboard.shutdown()
    }
  })

  test('a browser client sees a round play out over the websocket', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }

    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const wss = new WebSocketServer({ server: app.server, path: '/ws' })
    broadcaster.attach(wss)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const received: EngineEvent[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((r) => socket.on('open', r))
    socket.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const created = await app.inject({
      method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' },
    })
    const { runId } = JSON.parse(created.body)

    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)

    await manager.waitForIdle(runId)
    await new Promise((r) => setTimeout(r, 200))

    const snapshot = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })

    socket.close()
    await app.close()

    const types = new Set(received.map((e) => e.type))
    expect(types.has('round.status')).toBe(true)
    expect(types.has('agent.status')).toBe(true)
    expect(types.has('round.scored')).toBe(true)
    expect(types.has('round.complete')).toBe(true)

    const scored = received.find((e) => e.type === 'round.scored')
    expect(scored && 'scores' in scored ? scored.scores : []).toHaveLength(population)

    expect(JSON.parse(snapshot.body).lastRoundIdx).toBe(1)
  }, 60_000)

  test('guards hold: unknown targets 404 and missing goal 400s', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 2
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const nopeRound = await app.inject({ method: 'POST', url: '/api/runs/nope/rounds', payload: { goalMd: 'g' } })
    expect(nopeRound.statusCode).toBe(404)

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' } })).body,
    )
    const noGoal = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload: {} })
    expect(noGoal.statusCode).toBe(400)

    const nopePatch = await app.inject({
      method: 'PATCH', url: '/api/runs/nope/config', payload: { budget: { maxAgentTokens: 10 } },
    })
    expect(nopePatch.statusCode).toBe(404)

    await app.close()
  }, 60_000)

  test('PATCH on a busy run returns 409', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const app = buildApi({
      repos,
      manager: { isBusy: () => true, lastError: () => null, startRound: () => {} } as never,
      createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
    })
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' } })).body,
    )
    const res = await app.inject({
      method: 'PATCH', url: `/api/runs/${created.runId}/config`, payload: { budget: { maxAgentTokens: 10 } },
    })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  test('analytics endpoints serve the mock run; legacy DELETE 409s and leaves the row', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)
    await manager.waitForIdle(runId)

    const snapshot = JSON.parse(
      (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body,
    )
    expect(snapshot.lastRoundIdx).toBe(1)
    const firstAgent = snapshot.agents[0] as { agentId: string; label: string }

    const detailRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/agents/${firstAgent.agentId}` })
    expect(detailRes.statusCode).toBe(200)
    const detail = JSON.parse(detailRes.body)
    expect(detail.agent.label).toBe(firstAgent.label)
    expect(detail.genomes.length).toBeGreaterThanOrEqual(1)
    expect(detail.history).toHaveLength(1)
    expect(detail.lineage.length).toBeGreaterThanOrEqual(1)
    // The seed agent has no parent: the lineage tail must resolve to one.
    const seedEntry = detail.lineage[detail.lineage.length - 1] as { agentId: string }
    const seedRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/agents/${seedEntry.agentId}` })
    expect(seedRes.statusCode).toBe(200)
    expect(JSON.parse(seedRes.body).agent.parentAgentId).toBeNull()

    const roundsRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds` })
    expect(roundsRes.statusCode).toBe(200)
    const rounds = JSON.parse(roundsRes.body)
    expect(rounds).toHaveLength(1)
    const [only] = rounds
    expect(typeof only.fitness.mean).toBe('number')
    expect(typeof only.fitness.min).toBe('number')
    expect(typeof only.fitness.max).toBe('number')
    expect(only.fitness.mean).toBeGreaterThanOrEqual(only.fitness.min)
    expect(only.fitness.mean).toBeLessThanOrEqual(only.fitness.max)
    expect(only.modelShare.length).toBeGreaterThanOrEqual(1)
    expect(only.modelShare.reduce((n: number, m: { count: number }) => n + m.count, 0)).toBe(population)
    expect(only.diversity).toBeGreaterThanOrEqual(0)
    expect(only.diversity).toBeLessThanOrEqual(1)

    // The e2e run is legacy (3-arg server, no registry record): DELETE pins 409,
    // and the row is untouched — the snapshot still serves.
    const stopped = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}` })
    expect(stopped.statusCode).toBe(409)
    expect(JSON.parse(stopped.body).error).toMatch('not stoppable')
    const after = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
    expect(after.statusCode).toBe(200)

    await app.close()
  }, 60_000)

  test('phase4d guards: population edits, criteria pin, abort pin, round fields', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)
    await manager.waitForIdle(runId)

    // Population edits: pasted add is deterministic (no LLM involved).
    const pasted = 'my pasted strategy for e2e'
    const added = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/agents`,
      payload: { modelId: 'mock/model', temperature: 0.7, strategy: { mode: 'pasted', strategyMd: pasted } },
    })
    expect(added.statusCode).toBe(201)
    const agentId: string = JSON.parse(added.body).agentId

    const fresh = await app.inject({ method: 'GET', url: `/api/runs/${runId}/agents/${agentId}` })
    expect(fresh.statusCode).toBe(200)
    expect(JSON.parse(fresh.body).genomes.map((g: { strategyMd: string }) => g.strategyMd)).toContain(pasted)

    const retired = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}/agents/${agentId}` })
    expect(retired.statusCode).toBe(200)
    const retiredAgain = await app.inject({ method: 'DELETE', url: `/api/runs/${runId}/agents/${agentId}` })
    expect(retiredAgain.statusCode).toBe(409)
    const afterRetire = await app.inject({ method: 'GET', url: `/api/runs/${runId}/agents/${agentId}` })
    expect(afterRetire.statusCode).toBe(200)
    expect(JSON.parse(afterRetire.body).agent.status).toBe('retired')

    // The mock round finished fast, so only the scored pin is deterministic here;
    // the success path is pinned by the Task 5 inject + driver tests.
    const override = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds/1/criteria`, payload: { criteriaMd: 'late text' },
    })
    expect(override.statusCode).toBe(409)

    // Idle mock run: nothing in flight.
    const abort = await app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds/1/abort` })
    expect(abort.statusCode).toBe(409)
    expect(JSON.parse(abort.body).error).toMatch('no round in flight')

    // GET-rounds §6 fields: presence + nullability, not exact text.
    const roundsRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds` })
    expect(roundsRes.statusCode).toBe(200)
    const [only] = JSON.parse(roundsRes.body)
    expect(only.criteriaMd).not.toBeNull()
    expect(['user', 'generated']).toContain(only.criteriaSource)
    expect('metaDigest' in only).toBe(true)

    await app.close()
  }, 60_000)

  test('phase4e guard: POST accepts the extended run spec; snapshot unaffected', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    // Mock sandbox composes with no daemon, so the extended spec flows through
    // the real runConfigFor derivation. Setup criteria rides to round 1 via the
    // client in production — pin 201 acceptance + snapshot shape, not that flow.
    const app = buildApi({
      repos,
      registry,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
      composeWith: (spec, opts) => composeRun(spec, {}, opts),
    })

    const created = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'e2e-extended', goal: 'g',
        sandbox: 'mock',
        roster: [{ modelId: 'mock/model', count: 4, temperature: 0.7 }],
        criteria: 'prefer short answers',
        selection: { eliteCount: 1, topPct: 0.5 },
        concurrency: 4,
        pricing: { 'mock/model': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0.5 } },
      },
    })
    expect(created.statusCode).toBe(201)
    const { runId }: { runId: string } = JSON.parse(created.body)

    // One derivation pin: the composed config (runConfigFor output) carries the knobs.
    const record = registry.get(runId)
    expect(record?.spec.criteria).toBe('prefer short answers')
    expect(record?.composed.config.concurrency).toBe(4)
    expect(record?.composed.config.selection.eliteCount).toBe(1)
    expect(record?.composed.config.selection.topPct).toBe(0.5)
    expect(record?.composed.config.pricing['mock/model']).toEqual(
      { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0.5 },
    )

    // A cache-less pricing entry is a schema 400 (the engine fail-closes without cache rates).
    const twoKey = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'e2e-2key', goal: 'g',
        sandbox: 'mock',
        roster: [{ modelId: 'mock/model', count: 4, temperature: 0.7 }],
        pricing: { 'mock/model': { inPerM: 1, outPerM: 2 } },
      },
    })
    expect(twoKey.statusCode).toBe(400)

    // Snapshot unaffected: fresh run, no rounds yet — the seed population stands.
    const snapshot = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
    expect(snapshot.statusCode).toBe(200)
    const body = JSON.parse(snapshot.body)
    expect(body.name).toBe('e2e-extended')
    expect(body.lastRoundIdx).toBe(0)
    expect(body.agents).toHaveLength(4)

    await app.close()
  }, 60_000)

  test('phase4f guard: diversityFloor rescues the most-distinct culled agent on mocks', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    // Keyword-spread seeds: fitness gaps dwarf the mock-judge jitter (<=0.5), so
    // ranks follow index order and the zero-keyword odd-one-out ranks last —
    // culled, but the most distinct strategy in the field.
    const seeds = [
      'verify test iterate concise structure evidence example',
      'verify test iterate alpha beta',
      'verify alpha beta gamma',
      'zebra quasar xenon fjord uncommon words entirely',
    ]
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
      // n=4: top band 1, 2 culled, 1 survivor — the floor rescues one culled agent
      // and bumps that single survivor, so the swap is fully pinned below.
      selection: { ...DEFAULT_CONFIG.selection, topPct: 0.25, bottomPct: 0.5, diversityFloor: true },
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => seeds[i]!,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e-floor', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    // The Task-2 PATCH path: the floor rides the stored run config. (In this legacy
    // wiring the engine reads its constructor config per round; only the registry
    // branch re-reads via the reconfigure swap — the PATCH pins the route stores it.)
    const patched = await app.inject({
      method: 'PATCH', url: `/api/runs/${runId}/config`, payload: { selection: { diversityFloor: true } },
    })
    expect(patched.statusCode).toBe(200)
    expect(repos.runs.get(runId)!.config.selection.diversityFloor).toBe(true)

    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)
    await manager.waitForIdle(runId)

    const active = repos.agents.listActive(runId)
    // Population invariant: 1 elite + 1 rescued survivor + 2 clone children.
    expect(active).toHaveLength(population)
    const idOfSeed = (text: string) =>
      repos.agents.listAll(runId).find((a) => repos.genomes.forRound(a.id, 1)?.strategyMd === text)!.id
    const rescuedId = idOfSeed(seeds[3]!)
    // The rescued odd-one-out survives with reflection output down the mutated
    // (survivor) path — culled agents get no next-round genome at all.
    expect(active.map((a) => a.id)).toContain(rescuedId)
    const next = repos.genomes.forRound(rescuedId, 2)
    expect(next).not.toBeNull()
    expect(next!.origin).toBe('mutation')
    expect(next!.notesMd).toContain('Adjusted after reviewing the leaders.')
    // The bumped lowest survivor and the other culled agent are gone instead.
    const activeIds = new Set(active.map((a) => a.id))
    expect(activeIds.has(idOfSeed(seeds[1]!))).toBe(false)
    expect(activeIds.has(idOfSeed(seeds[2]!))).toBe(false)

    await app.close()
  }, 60_000)

  test('phase4f guard: crossover children recombine via the mock provider on mocks', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const seeds = [
      'verify test iterate concise structure evidence example alpha',
      'verify test iterate beta',
      'verify gamma delta',
      'plain words with no signal here',
    ]
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
      // n=4: top band 2 (crossover needs 2+ parents), 2 culled, pct 1 → both
      // culled slots become crossovers, zero clones.
      selection: { ...DEFAULT_CONFIG.selection, topPct: 0.5, bottomPct: 0.5, crossoverPct: 1 },
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => seeds[i]!,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e-recombine', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)
    await manager.waitForIdle(runId)

    const children = repos.agents.listActive(runId).flatMap((a) => {
      const g = repos.genomes.forRound(a.id, 2)
      return g?.origin === 'crossover' ? [g] : []
    })
    expect(children).toHaveLength(2)
    for (const child of children) {
      // Mock-provider text, not the split fallback: the reflect-path marker is
      // present and the failure parenthetical is absent.
      expect(child.notesMd).toContain('Adjusted after reviewing the leaders.')
      expect(child.notesMd).not.toContain('(recombine failed, split merge)')
    }

    await app.close()
  }, 60_000)

  test('phase4g guard: round detail serves header + rank-ordered entries with rationales', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e-g', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)
    await manager.waitForIdle(runId)

    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/1` })
    expect(res.statusCode).toBe(200)
    const detail = JSON.parse(res.body)
    // Header presence, not exact text: the mock flow passes or generates criteria.
    expect(typeof detail.goalMd).toBe('string')
    expect(detail.criteriaMd).not.toBeNull()
    expect(['user', 'generated']).toContain(detail.criteriaSource)
    expect('metaDigest' in detail).toBe(true)
    expect(typeof detail.costUsd).toBe('number')
    expect(typeof detail.judgeMode).toBe('string')
    // Entries rank-ordered: array order matches the explicit rank sequence.
    expect(detail.entries).toHaveLength(population)
    const ranks = detail.entries.map((e: { rank: number }) => e.rank)
    expect(ranks).toEqual([1, 2, 3, 4])
    expect([...ranks].sort((a: number, b: number) => a - b)).toEqual(ranks)
    // At least one rationale non-empty (mock judge writes rationale text).
    expect(detail.entries.some(
      (e: { rationaleMd: string }) => typeof e.rationaleMd === 'string' && e.rationaleMd.length > 0,
    )).toBe(true)

    await app.close()
  }, 60_000)

  test('phase4g guard: POST accepts judge/reflect model fields', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    // Mock sandbox composes with no daemon — acceptance only (201, no 400);
    // derivation is pinned by Task 4's runConfigFor unit test, not here.
    const app = buildApi({
      repos,
      registry,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
      composeWith: (spec, opts) => composeRun(spec, {}, opts),
    })

    const created = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'e2e-models', goal: 'g',
        sandbox: 'mock',
        roster: [{ modelId: 'mock/model', count: 4, temperature: 0.7 }],
        judge: { modelId: 'mock/model', mode: 'auto' },
        reflect: { modelId: 'mock/model' },
      },
    })
    expect(created.statusCode).toBe(201)

    await app.close()
  }, 60_000)

  test('phase4h guard: 30-agent run returns snapshot with >24 agents (pagination precondition)', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 30
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }
    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'e2e-4h', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' } })
    await manager.waitForIdle(runId)

    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const snap = JSON.parse(res.body)
    expect(snap.agents).toHaveLength(30)
    expect(snap.agents.length).toBeGreaterThan(24)

    await app.close()
  }, 60_000)

  test('phase4j guard: export serves json + csv and 400s on unknown format', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
    })
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'export-run', goal: 'g' } })).body,
    )
    const runId: string = created.runId
    // Seed 2 agents + 1 scored round (no submissions needed for the guard).
    const a1 = repos.agents.create({ runId, label: 'a1', parentAgentId: null, bornRound: 1 })
    const a2 = repos.agents.create({ runId, label: 'a2', parentAgentId: null, bornRound: 1 })
    const r1 = repos.rounds.create({ runId, idx: 1, goalMd: 'goal' })
    for (const a of [a1, a2]) {
      repos.genomes.create({
        agentId: a.id, roundIdx: 1, strategyMd: 's', notesMd: '',
        modelId: 'mock/model', temperature: 0.7, parentGenomeId: null, origin: 'seed',
      })
    }
    repos.scores.insertMany(r1.id, [
      { roundId: r1.id, agentId: a1.id, rank: 1, score: 80, rationaleMd: 'r1', band: 'elite' },
      { roundId: r1.id, agentId: a2.id, rank: 2, score: 50, rationaleMd: 'r2', band: 'bottom' },
    ])

    const jsonRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=json` })
    expect(jsonRes.statusCode).toBe(200)
    expect(jsonRes.headers['content-type']).toContain('application/json')
    const jsonBody = JSON.parse(jsonRes.body)
    expect(Array.isArray(jsonBody.rounds)).toBe(true)

    const csvRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=csv` })
    expect(csvRes.statusCode).toBe(200)
    expect(csvRes.headers['content-type']).toContain('text/csv')
    expect(csvRes.body.startsWith('round,agentLabel')).toBe(true)

    const badRes = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=xml` })
    expect(badRes.statusCode).toBe(400)

    const noRunRes = await app.inject({ method: 'GET', url: '/api/runs/nope/export?format=json' })
    expect(noRunRes.statusCode).toBe(404)

    await app.close()
  }, 60_000)

  test('phase4j guard: GET /api/runs serves per-run summary (rounds, bestScore, costUsd)', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
    })

    // Run A: 1 agent, 1 scored round (cost 0.05), best score 80.
    const aId = repos.runs.create({ name: 'summary-a', config: DEFAULT_CONFIG, seedDir: null }).id
    const a1 = repos.agents.create({ runId: aId, label: 'a1', parentAgentId: null, bornRound: 1 })
    const r1 = repos.rounds.create({ runId: aId, idx: 1, goalMd: 'goal' })
    repos.genomes.create({
      agentId: a1.id, roundIdx: 1, strategyMd: 's', notesMd: '',
      modelId: 'mock/model', temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
    repos.scores.insertMany(r1.id, [
      { roundId: r1.id, agentId: a1.id, rank: 1, score: 80, rationaleMd: 'r', band: 'elite' },
    ])
    repos.rounds.markEnded(r1.id, 0.05)

    // Run B: no rounds.
    repos.runs.create({ name: 'summary-b', config: DEFAULT_CONFIG, seedDir: null })

    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(200)
    const { runs } = JSON.parse(res.body)
    expect(runs).toHaveLength(2)
    const a = runs.find((r: { name: string }) => r.name === 'summary-a')
    const b = runs.find((r: { name: string }) => r.name === 'summary-b')
    expect(a).toBeDefined()
    expect(a.rounds).toBe(1)
    expect(a.bestScore).toBe(80)
    expect(a.costUsd).toBeCloseTo(0.05)
    expect(b).toBeDefined()
    expect(b.rounds).toBe(0)
    expect(b.bestScore).toBeNull()
    expect(b.costUsd).toBe(0)

    await app.close()
  }, 60_000)

  test('phase4j guard: rejudge round with a different model (non-destructive dry-run)', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const population = 3
    // Mock sandbox composes with no daemon; the composed run registers a record
    // whose provider (MockProvider) the rejudge endpoint reuses — no seam needed.
    const app = buildApi({
      repos,
      registry,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
      composeWith: (spec, opts) => composeRun(spec, {}, opts),
    })

    const created = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'rejudge-run', goal: 'g',
        sandbox: 'mock',
        roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
      },
    })
    expect(created.statusCode).toBe(201)
    const { runId }: { runId: string } = JSON.parse(created.body)
    const record = registry.get(runId)
    expect(record).not.toBeNull()

    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)
    await record!.manager.waitForIdle(runId)

    const res = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds/1/rejudge`,
      payload: { judgeModelId: 'mock/model' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.entries).toHaveLength(population)
    for (const e of body.entries) {
      expect(typeof e.oldScore).toBe('number')
      expect(typeof e.newScore).toBe('number')
      expect(typeof e.oldRank).toBe('number')
      expect(typeof e.newRank).toBe('number')
      expect(typeof e.rankChanged).toBe('boolean')
    }
    expect(typeof body.metaDigest).toBe('string')
    expect(typeof body.mode).toBe('string')

    // 404 for a non-existent round idx.
    const nope = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds/99/rejudge`,
      payload: { judgeModelId: 'mock/model' },
    })
    expect(nope.statusCode).toBe(404)

    // 409 for a legacy run (no record → no live provider).
    const legacyId = repos.runs.create({ name: 'legacy', config: DEFAULT_CONFIG, seedDir: null }).id
    const lr = repos.rounds.create({ runId: legacyId, idx: 1, goalMd: 'goal' })
    repos.rounds.setStatus(lr.id, 'complete')
    const legacyRes = await app.inject({
      method: 'POST', url: `/api/runs/${legacyId}/rounds/1/rejudge`,
      payload: { judgeModelId: 'mock/model' },
    })
    expect(legacyRes.statusCode).toBe(409)
    expect(JSON.parse(legacyRes.body).error).toMatch('no live provider')

    await app.close()
  }, 60_000)
})
