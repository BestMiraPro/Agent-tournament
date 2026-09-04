import { describe, expect, test } from 'vitest'
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
import { RunManager } from '../../src/server/run-manager.js'
import { EventBroadcaster } from '../../src/server/ws.js'

describe('dashboard end to end', () => {
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
})
