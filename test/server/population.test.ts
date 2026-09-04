import { describe, expect, test } from 'vitest'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry } from '../../src/server/runs.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos, type Repos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

/** A run with 2 agents (each with one genome at round 1) and one round row, so bornRound pins to 2. */
function seed() {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'pop', config: DEFAULT_CONFIG, seedDir: null })
  const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'goal 1' })
  const mk = (label: string, modelId: string) => {
    const agent = repos.agents.create({ runId: run.id, label, parentAgentId: null, bornRound: 1 })
    const genome = repos.genomes.create({
      agentId: agent.id, roundIdx: 1, strategyMd: `strategy ${label}`, notesMd: `notes ${label}`,
      modelId, temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
    return { agent, genome }
  }
  const a = mk('alpha', 'mock/model')
  const b = mk('beta', 'mock/model')
  return { repos, run, round, a, b }
}

const idle = () => ({ isBusy: () => false, lastError: () => null, startRound: () => {} }) as never
const busy = () => ({ isBusy: () => true, lastError: () => null, startRound: () => {} }) as never

function appFor(repos: Repos, manager: never, registry = new RunRegistry()) {
  return buildApi({
    repos,
    manager,
    createRun: (name: string) => repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
    registry,
  })
}

describe('POST /api/runs/:runId/agents', () => {
  test('blank → 201, empty strategy, origin manual, null parents, bornRound = lastIdx+1', async () => {
    const { repos, run } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'mock/model', temperature: 0.7, strategy: { mode: 'blank' } },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { agentId: string; label: string }
    expect(body.label).toBe('competitor-r2-manual-3')
    const genomes = repos.genomes.forAgent(body.agentId)
    expect(genomes).toHaveLength(1)
    expect(genomes[0]).toMatchObject({
      roundIdx: 2, strategyMd: '', notesMd: '', modelId: 'mock/model', origin: 'manual', parentGenomeId: null,
    })
    const agent = repos.agents.listAll(run.id).find((x) => x.id === body.agentId)!
    expect(agent).toMatchObject({ bornRound: 2, parentAgentId: null, status: 'active' })
  })

  test('pasted → text through verbatim', async () => {
    const { repos, run } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'mock/model', temperature: 0, strategy: { mode: 'pasted', strategyMd: '# my plan' } },
    })
    expect(res.statusCode).toBe(201)
    const { agentId } = JSON.parse(res.body) as { agentId: string }
    const genomes = repos.genomes.forAgent(agentId)
    expect(genomes[0]).toMatchObject({ strategyMd: '# my plan', notesMd: '', origin: 'manual' })
  })

  test('clone → strategy+notes copied, parentage set', async () => {
    const { repos, run, a } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'mock/model', temperature: 1, strategy: { mode: 'clone', agentId: a.agent.id } },
    })
    expect(res.statusCode).toBe(201)
    const { agentId } = JSON.parse(res.body) as { agentId: string }
    const genomes = repos.genomes.forAgent(agentId)
    expect(genomes[0]).toMatchObject({
      strategyMd: 'strategy alpha', notesMd: 'notes alpha',
      origin: 'manual', parentGenomeId: a.genome.id,
    })
    const agent = repos.agents.listAll(run.id).find((x) => x.id === agentId)!
    expect(agent.parentAgentId).toBe(a.agent.id)
  })

  test.each([
    ['temperature 3', { modelId: 'm', temperature: 3, strategy: { mode: 'blank' } }],
    ['empty pasted text', { modelId: 'm', temperature: 0.5, strategy: { mode: 'pasted', strategyMd: '' } }],
  ])('400: %s', async (_name, payload) => {
    const { repos, run } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({ method: 'POST', url: `/api/runs/${run.id}/agents`, payload })
    expect(res.statusCode).toBe(400)
  })

  test('400: clone source with no genome', async () => {
    const { repos, run } = seed()
    const bare = repos.agents.create({ runId: run.id, label: 'bare', parentAgentId: null, bornRound: 2 })
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'm', temperature: 0.5, strategy: { mode: 'clone', agentId: bare.id } },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'clone source has no genome yet' })
  })

  test('404: unknown run', async () => {
    const { repos } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: '/api/runs/nope/agents',
      payload: { modelId: 'm', temperature: 0.5, strategy: { mode: 'blank' } },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such run' })
  })

  test('404: clone source unknown', async () => {
    const { repos, run } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'm', temperature: 0.5, strategy: { mode: 'clone', agentId: 'nope' } },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such agent' })
  })

  test('404: clone source from another run', async () => {
    const { repos, run } = seed()
    const other = repos.runs.create({ name: 'other', config: DEFAULT_CONFIG, seedDir: null })
    const foreign = repos.agents.create({ runId: other.id, label: 'foreign', parentAgentId: null, bornRound: 1 })
    repos.genomes.create({
      agentId: foreign.id, roundIdx: 1, strategyMd: 's', notesMd: 'n',
      modelId: 'm', temperature: 0.5, parentGenomeId: null, origin: 'seed',
    })
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'm', temperature: 0.5, strategy: { mode: 'clone', agentId: foreign.id } },
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such agent' })
  })

  test('400: missing pricing on a USD-capped run', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({
      name: 'capped',
      config: { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, maxRunUsd: 10 } },
      seedDir: null,
    })
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'unpriced/model', temperature: 0.5, strategy: { mode: 'blank' } },
    })
    expect(res.statusCode).toBe(400)
    // Mirrors the driver preflight wording (budget.ts): same sentence shape, one model.
    expect(JSON.parse(res.body).error).toMatch(/no pricing entry.*unpriced\/model/)
  })

  test('409: busy', async () => {
    const { repos, run } = seed()
    const api = appFor(repos, busy())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'm', temperature: 0.5, strategy: { mode: 'blank' } },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'run is busy' })
  })

  test('409: stopped', async () => {
    const { repos, run } = seed()
    repos.runs.setStatus(run.id, 'stopped')
    const api = appFor(repos, idle())
    const res = await api.inject({
      method: 'POST', url: `/api/runs/${run.id}/agents`,
      payload: { modelId: 'm', temperature: 0.5, strategy: { mode: 'blank' } },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'run is stopped' })
  })
})

describe('DELETE /api/runs/:runId/agents/:agentId', () => {
  test('happy path: status retired + diedRound === lastRoundIdx', async () => {
    const { repos, run, a } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${a.agent.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ retired: true })
    const row = repos.agents.listAll(run.id).find((x) => x.id === a.agent.id)!
    expect(row.status).toBe('retired')
    expect(row.diedRound).toBe(1)
  })

  test('404: unknown run', async () => {
    const { repos, a } = seed()
    const api = appFor(repos, idle())
    const res = await api.inject({ method: 'DELETE', url: `/api/runs/nope/agents/${a.agent.id}` })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such run' })
  })

  test('404: unknown agent + foreign agent', async () => {
    const { repos, run } = seed()
    const other = repos.runs.create({ name: 'other', config: DEFAULT_CONFIG, seedDir: null })
    const foreign = repos.agents.create({ runId: other.id, label: 'foreign', parentAgentId: null, bornRound: 1 })
    const api = appFor(repos, idle())
    for (const id of ['nope', foreign.id]) {
      const res = await api.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${id}` })
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body)).toEqual({ error: 'no such agent' })
    }
  })

  test('409: busy and stopped', async () => {
    const { repos, run, a, b } = seed()
    const busyApi = appFor(repos, busy())
    const busyRes = await busyApi.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${a.agent.id}` })
    expect(busyRes.statusCode).toBe(409)
    expect(JSON.parse(busyRes.body)).toEqual({ error: 'run is busy' })
    expect(b.agent.id).toBeDefined()
    repos.runs.setStatus(run.id, 'stopped')
    const idleApi = appFor(repos, idle())
    const stoppedRes = await idleApi.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${a.agent.id}` })
    expect(stoppedRes.statusCode).toBe(409)
    expect(JSON.parse(stoppedRes.body)).toEqual({ error: 'run is stopped' })
  })

  test('409: double retire', async () => {
    const { repos, run, a } = seed()
    const api = appFor(repos, idle())
    expect((await api.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${a.agent.id}` })).statusCode).toBe(200)
    const again = await api.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${a.agent.id}` })
    expect(again.statusCode).toBe(409)
    expect(JSON.parse(again.body)).toEqual({ error: 'agent is not active' })
  })

  test('409: last active agent', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({ name: 'solo', config: DEFAULT_CONFIG, seedDir: null })
    const solo = repos.agents.create({ runId: run.id, label: 'solo', parentAgentId: null, bornRound: 1 })
    const api = appFor(repos, idle())
    const res = await api.inject({ method: 'DELETE', url: `/api/runs/${run.id}/agents/${solo.id}` })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'cannot retire the last active agent' })
  })
})
