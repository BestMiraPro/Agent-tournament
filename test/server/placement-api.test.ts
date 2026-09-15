import { describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry } from '../../src/server/runs.js'

const idle = { isBusy: () => false, lastError: () => null, startRound: () => {} } as never

describe('GET /api/capacity', () => {
  test('reports Docker capacity and what this app has reserved, and no container names', async () => {
    const repos = makeRepos(openDb(':memory:'))
    const api = buildApi({
      repos, manager: idle, createRun: () => 'x',
      capacity: async () => ({
        host: { totalMemoryBytes: 8, usedMemoryBytes: 1, cpus: 16, containers: [{ name: 'someone-elses-db', usedBytes: 1 }] },
        reserved: { memoryBytes: 2, cpus: 3 },
      }),
    })
    const res = await api.inject({ method: 'GET', url: '/api/capacity' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalMemoryBytes: 8, usedMemoryBytes: 1, cpus: 16, reservedMemoryBytes: 2, reservedCpus: 3 })
    expect(res.body).not.toContain('someone-elses-db')
  })

  test('an unreadable Docker is a 503 with the reason, never invented numbers', async () => {
    const repos = makeRepos(openDb(':memory:'))
    const api = buildApi({
      repos, manager: idle, createRun: () => 'x',
      capacity: async () => { throw new Error('docker info failed (exit 1)') },
    })
    const res = await api.inject({ method: 'GET', url: '/api/capacity' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toMatch(/docker info failed/)
  })

  test('with no capacity reader the route says it is unavailable', async () => {
    const api = buildApi({ repos: makeRepos(openDb(':memory:')), manager: idle, createRun: () => 'x' })
    expect((await api.inject({ method: 'GET', url: '/api/capacity' })).statusCode).toBe(503)
  })
})

describe('run snapshot placement', () => {
  test('a composed docker run reports its current plan', async () => {
    const repos = makeRepos(openDb(':memory:'))
    const run = repos.runs.create({ name: 'p', config: { ...DEFAULT_CONFIG, sandbox: 'docker' }, seedDir: null })
    const registry = new RunRegistry()
    registry.set({
      runId: run.id, spec: {} as never, engine: {} as never, manager: idle, bridges: [], warnings: [], capacity: null,
      composed: { placement: () => [{ shardIndex: 0, agentIds: ['a1'], occupancy: 'single' }] } as never,
    })
    const api = buildApi({ repos, manager: idle, createRun: () => 'x', registry })
    const res = await api.inject({ method: 'GET', url: `/api/runs/${run.id}` })
    expect(res.json().placement).toEqual([{ shardIndex: 0, agentIds: ['a1'], occupancy: 'single' }])
  })

  test('a run with no live plan reports none', async () => {
    const repos = makeRepos(openDb(':memory:'))
    const run = repos.runs.create({ name: 'p', config: DEFAULT_CONFIG, seedDir: null })
    const api = buildApi({ repos, manager: idle, createRun: () => 'x' })
    expect((await api.inject({ method: 'GET', url: `/api/runs/${run.id}` })).json().placement).toBeNull()
  })
})
