import { describe, expect, test } from 'vitest'
import { buildApi } from '../../src/server/api.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { parseRunSpec } from '../../src/server/run-spec.js'
import { runConfigFor } from '../../src/server/compose-run.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { RunRegistry } from '../../src/server/runs.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const started: { runId: string; goalMd: string; criteriaMd: string | null }[] = []
  const app = buildApi({
    repos,
    manager: {
      isBusy: () => false,
      lastError: () => null,
      startRound: (runId: string, input: { goalMd: string; criteriaMd?: string | null }) => {
        started.push({ runId, goalMd: input.goalMd, criteriaMd: input.criteriaMd ?? null })
      },
    } as never,
    createRun: (name: string, goal: string) => {
      const r = repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null })
      void goal
      return r.id
    },
  })
  return { app, repos, started }
}

describe('API', () => {
  test('POST /api/runs creates a run and returns its id', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).runId).toBeTruthy()
  })

  test('GET /api/runs lists runs', async () => {
    const { app } = setup()
    await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).runs.length).toBeGreaterThan(0)
  })

  test('GET /api/runs/:id returns a snapshot', async () => {
    const { app } = setup()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
    )
    const res = await app.inject({ method: 'GET', url: `/api/runs/${created.runId}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).name).toBe('demo')
  })

  test('GET /api/runs/:id is 404 for an unknown run', async () => {
    const { app } = setup()
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope' })).statusCode).toBe(404)
  })

  test('POST /api/runs/:id/rounds starts a round and returns 202', async () => {
    const { app, started } = setup()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
    )
    const res = await app.inject({
      method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload: { goalMd: 'new goal' },
    })
    expect(res.statusCode).toBe(202)
    expect(started).toHaveLength(1)
    expect(started[0]!.goalMd).toBe('new goal')
  })

  test('starting a round requires a goal', async () => {
    const { app } = setup()
    const created = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
    )
    const res = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  test('rejects starting a round on an unknown run', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/runs/nope/rounds', payload: { goalMd: 'g' } })
    expect(res.statusCode).toBe(404)
  })

  test('POST /api/runs accepts a local spec', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'real', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
        roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
      },
    })
    expect([201, 400]).toContain(res.statusCode)
  })

  test('POST /api/runs rejects docker without authFile', async () => {
    const { app } = setup()
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w',
        roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  test('POST /api/runs keeps the legacy name+goal shape', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })
    expect(res.statusCode).toBe(201)
  })

  test.each([
    ['name', { name: 42, goal: 'g' }],
    ['goal', { name: 'demo', goal: {} }],
    ['array body', []],
    ['null body', 'null'],
    ['blank name', { name: ' \n\t', goal: 'g' }],
    ['blank goal', { name: 'demo', goal: ' \n\t' }],
  ])('POST /api/runs rejects malformed %s without creating a run', async (_label, payload) => {
    const { app, repos } = setup()
    const before = repos.runs.list?.().length ?? 0
    const res = await app.inject({
      method: 'POST', url: '/api/runs', payload,
      headers: typeof payload === 'string' ? { 'content-type': 'application/json' } : undefined,
    })
    expect(res.statusCode).toBe(400)
    expect(repos.runs.list?.().length ?? 0).toBe(before)
  })

  test('POST /api/runs preserves multiline legacy values', async () => {
    const { app, repos } = setup()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { name: ' demo ', goal: 'line 1\n\nline 2 ' } })
    expect(res.statusCode).toBe(201)
    expect(repos.runs.list?.()[0]?.name).toBe(' demo ')
  })
})

describe('API round input validation', () => {
  test.each([
    ['number', { goalMd: 42 }],
    ['object', { goalMd: {} }],
    ['array', { goalMd: [] }],
    ['null', { goalMd: null }],
    ['missing', {}],
    ['whitespace', { goalMd: ' \n\t' }],
    ['criteria number', { goalMd: 'g', criteriaMd: 42 }],
    ['criteria object', { goalMd: 'g', criteriaMd: {} }],
    ['criteria array', { goalMd: 'g', criteriaMd: [] }],
  ])('rejects %s without scheduling work', async (_label, payload) => {
    const { app, started, repos } = setup()
    const created = JSON.parse((await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body)
    const before = repos.rounds.listForRun(created.runId).length
    const res = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload })
    expect(res.statusCode).toBe(400)
    expect(started).toHaveLength(0)
    expect(repos.rounds.listForRun(created.runId).length).toBe(before)
  })

  test.each([
    ['string', { goalMd: 'line 1\n\nline 2 ', criteriaMd: 'criteria\n' }],
    ['null criteria', { goalMd: 'g', criteriaMd: null }],
    ['omitted criteria', { goalMd: 'g' }],
  ])('accepts %s and preserves values', async (_label, payload) => {
    const { app, started } = setup()
    const created = JSON.parse((await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body)
    const res = await app.inject({ method: 'POST', url: `/api/runs/${created.runId}/rounds`, payload })
    expect(res.statusCode).toBe(202)
    expect(started[0]).toMatchObject({
      goalMd: payload.goalMd,
      criteriaMd: 'criteriaMd' in payload ? payload.criteriaMd ?? null : null,
    })
  })
})

test('PATCH /api/runs/:id/config rejects unknown runs', async () => {
  const { app } = setup()
  const res = await app.inject({ method: 'PATCH', url: '/api/runs/nope/config', payload: { budget: { maxAgentTokens: 10 } } })
  expect(res.statusCode).toBe(404)
})

test('PATCH /api/runs/:id/config carries selection.crossoverPct into the stored config', async () => {
  const { app, repos } = setup()
  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
  )
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`, payload: { selection: { crossoverPct: 0.5 } },
  })
  expect(res.statusCode).toBe(200)
  expect(repos.runs.get(created.runId)!.config.selection.crossoverPct).toBe(0.5)
  const bad = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`, payload: { selection: { crossoverPct: 1.5 } },
  })
  expect(bad.statusCode).toBe(400)
})

test('PATCH /api/runs/:id/config carries selection.diversityFloor into the stored config', async () => {
  const { app, repos } = setup()
  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
  )
  expect(repos.runs.get(created.runId)!.config.selection.diversityFloor).toBe(false)
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`, payload: { selection: { diversityFloor: true } },
  })
  expect(res.statusCode).toBe(200)
  expect(repos.runs.get(created.runId)!.config.selection.diversityFloor).toBe(true)
})
test('PATCH legacy branch default-fills selection for pre-4d rows without a selection key', async () => {
  const { app, repos } = setup()
  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
  )
  const cfg = repos.runs.get(created.runId)!.config as unknown as Record<string, unknown>
  delete cfg.selection
  repos.runs.updateConfig(created.runId, cfg as never)
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`, payload: { budget: { maxAgentTokens: 10 } },
  })
  expect(res.statusCode).toBe(200)
  expect(repos.runs.get(created.runId)!.config.selection.crossoverPct).toBe(0)
})

test('PATCH legacy branch rejects an eliteCount violating the cross-field rule', async () => {
  const { app } = setup()
  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
  )
  // DEFAULT config: pop 20, topPct 0.2 → top band 4; elite 999 exceeds it.
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`,
    payload: { selection: { eliteCount: 999 } },
  })
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body).error).toMatch(/top band size/)
})

test('PATCH legacy branch carries the new setup knobs into the stored config', async () => {
  const { app, repos } = setup()
  const created = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/runs', payload: { name: 'demo', goal: 'g' } })).body,
  )
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${created.runId}/config`,
    payload: {
      selection: { eliteCount: 2, topPct: 0.3, bottomPct: 0.1 },
      concurrency: 4,
      pricing: { 'm/m': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0.5 } },
    },
  })
  expect(res.statusCode).toBe(200)
  const cfg = repos.runs.get(created.runId)!.config
  expect(cfg.selection.eliteCount).toBe(2)
  expect(cfg.selection.topPct).toBe(0.3)
  expect(cfg.selection.bottomPct).toBe(0.1)
  expect(cfg.concurrency).toBe(4)
  expect(cfg.pricing['m/m']).toEqual({ inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0.5 })
})

// Composed-run setup: the record branch re-validates via merge→parseRunSpec,
// so the cross-field rule arrives free. Roster sums to 20 = DEFAULT populationSize.
const setupComposed = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const registry = new RunRegistry()
  const app = buildApi({
    repos,
    registry,
    manager: {
      isBusy: () => false,
      lastError: () => null,
      startRound: () => {},
    } as never,
    createRun: (name: string) => {
      const r = repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null })
      return r.id
    },
  })
  return { app, repos, registry }
}

// Composed-run setup with a REAL engine: the record branch re-validates via
// merge→parseRunSpec (cross-field free) and reconfigures the engine — a fake
// reconfigure would hide both. Roster sums to 20 = DEFAULT populationSize.
const seedRecord = (repos: ReturnType<typeof makeRepos>, registry: RunRegistry) => {
  const spec = parseRunSpec({
    name: 'composed', goal: 'g', sandbox: 'mock',
    roster: [{ modelId: 'm/m', count: 20, temperature: 0.7 }],
  })
  const config = runConfigFor(spec)
  const provider = new MockProvider(42)
  const sandbox = new MockSandbox()
  const engine = new TournamentEngine({
    repos, config, sandbox,
    runner: new MockAgentRunner(sandbox, 42),
    judge: new Judge(provider, config.judge, 42),
    reflector: new Reflector(provider, config.reflect, config.roster.map((r) => r.modelId)),
    seedStrategy: () => 's',
    onEvent: () => {},
  })
  const runId = engine.createRun('composed', 'g').id
  registry.set({
    runId, spec, engine,
    manager: { isBusy: () => false } as never,
    composed: { config, provider, warnings: [], cleanup: async () => {} } as never,
    bridges: [], warnings: [], capacity: null,
  })
  return runId
}

test('PATCH record branch stores selection/concurrency via reconfigure', async () => {
  const { app, repos, registry } = setupComposed()
  const runId = seedRecord(repos, registry)
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${runId}/config`,
    payload: { selection: { eliteCount: 2, topPct: 0.3 }, concurrency: 4 },
  })
  expect(res.statusCode).toBe(200)
  const cfg = repos.runs.get(runId)!.config
  expect(cfg.selection.eliteCount).toBe(2)
  expect(cfg.selection.topPct).toBe(0.3)
  expect(cfg.concurrency).toBe(4)
})

test('PATCH record branch rejects 2-key pricing at the schema, stores 4-key', async () => {
  const { app, repos, registry } = setupComposed()
  const runId = seedRecord(repos, registry)
  // Cache rates are required (the engine fail-closes without them), so the schema
  // demands all four keys — a 2-key entry 400s here with a zod message, not at the engine.
  const bad = await app.inject({
    method: 'PATCH', url: `/api/runs/${runId}/config`,
    payload: { pricing: { 'm/m': { inPerM: 1, outPerM: 2 } } },
  })
  expect(bad.statusCode).toBe(400)
  expect(JSON.parse(bad.body).error).toMatch(/cacheReadPerM/)
  const good = await app.inject({
    method: 'PATCH', url: `/api/runs/${runId}/config`,
    payload: { pricing: { 'm/m': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0.5 } } },
  })
  expect(good.statusCode).toBe(200)
  expect(repos.runs.get(runId)!.config.pricing['m/m']).toEqual(
    { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0.5 },
  )
})

test('PATCH record branch rejects an eliteCount violating the cross-field rule', async () => {
  const { app, repos, registry } = setupComposed()
  const runId = seedRecord(repos, registry)
  // pop 20, topPct 0.2 → top band 4; elite 5 exceeds it.
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${runId}/config`,
    payload: { selection: { eliteCount: 5, topPct: 0.2 } },
  })
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(res.body).error).toMatch(/top band size/)
})

test('PATCH record branch rejects concurrency 65', async () => {
  const { app, repos, registry } = setupComposed()
  const runId = seedRecord(repos, registry)
  const res = await app.inject({
    method: 'PATCH', url: `/api/runs/${runId}/config`, payload: { concurrency: 65 },
  })
  expect(res.statusCode).toBe(400)
})
