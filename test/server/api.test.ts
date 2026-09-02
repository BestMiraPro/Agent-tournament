import { describe, expect, test } from 'vitest'
import { buildApi } from '../../src/server/api.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const started: { runId: string; goalMd: string }[] = []
  const app = buildApi({
    repos,
    manager: {
      isBusy: () => false,
      lastError: () => null,
      startRound: (runId: string, input: { goalMd: string }) => { started.push({ runId, goalMd: input.goalMd }) },
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
})
