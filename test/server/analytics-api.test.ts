import { describe, expect, test } from 'vitest'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry } from '../../src/server/runs.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

/**
 * A 3-round run with a 3-deep lineage (alpha <- beta <- gamma) plus delta,
 * born in round 2 on alpha's model: every agent gets a distinct genome and a
 * score in every round it is alive (delta: rounds 2-3 only, so modelShare
 * counts differ across rounds), plus submissions in rounds 1-2 — except
 * gamma's round 2 (an error submission) and round 3 (no submission at all,
 * which pins `submission: null`).
 */
function seed() {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'demo', config: DEFAULT_CONFIG, seedDir: null })
  const alpha = repos.agents.create({ runId: run.id, label: 'alpha', parentAgentId: null, bornRound: 1 })
  const beta = repos.agents.create({ runId: run.id, label: 'beta', parentAgentId: alpha.id, bornRound: 2 })
  const gamma = repos.agents.create({ runId: run.id, label: 'gamma', parentAgentId: beta.id, bornRound: 3 })
  const delta = repos.agents.create({ runId: run.id, label: 'delta', parentAgentId: alpha.id, bornRound: 2 })
  const origins = ['seed', 'mutation', 'elite'] as const
  const rounds = [1, 2, 3].map((idx) => {
    const r = repos.rounds.create({ runId: run.id, idx, goalMd: `goal ${idx}` })
    repos.rounds.setStatus(r.id, 'complete')
    return r
  })
  const roster = [
    { agent: alpha, ai: 0, modelId: 'model/1', fromRound: 1 },
    { agent: beta, ai: 1, modelId: 'model/2', fromRound: 1 },
    { agent: gamma, ai: 2, modelId: 'model/3', fromRound: 1 },
    { agent: delta, ai: 3, modelId: 'model/1', fromRound: 2 },
  ]
  roster.forEach(({ agent: a, ai, modelId, fromRound }) => {
    rounds.forEach((r, ri) => {
      if (r.idx < fromRound) return // not born yet: no genome/score for earlier rounds
      const genome = repos.genomes.create({
        agentId: a.id, roundIdx: r.idx,
        strategyMd: `strategy ${ai + 1} round ${r.idx}`, notesMd: `notes ${ai + 1} round ${r.idx}`,
        modelId, temperature: 0.5 * (ai + 1) + 0.25 * ri,
        parentGenomeId: null, origin: origins[ri]!,
      })
      const rank = ((ai + ri) % 3) + 1
      repos.scores.insertMany(r.id, [{
        roundId: r.id, agentId: a.id, rank, score: 100 - 30 * rank,
        rationaleMd: `why ${a.label} ranked ${rank} in round ${r.idx}`,
        band: rank === 1 ? 'elite' : rank === 2 ? 'top' : 'bottom',
      }])
      if (r.idx <= 2) {
        const error = r.idx === 2 && a.id === gamma.id
        repos.submissions.create({
          roundId: r.id, agentId: a.id, genomeId: genome.id,
          submissionMd: error ? 'partial work' : `submission ${a.label} round ${r.idx}`,
          fileManifest: error
            ? [{ path: 'partial.txt', bytes: 4 }]
            : [{ path: `out-${r.idx}.txt`, bytes: 10 * r.idx }],
          workspacePath: `/ws/${a.label}`, status: error ? 'error' : 'ok',
          errorText: error ? 'runner exploded' : null,
          tokensIn: 100 * r.idx, tokensOut: 50 * r.idx,
          tokensCacheRead: 5 * r.idx, tokensCacheWrite: 7 * r.idx,
          costUsd: 0.01 * r.idx, durationMs: 1000 + r.idx,
        })
      }
    })
  })
  return { repos, run, alpha, beta, gamma, delta }
}

const setup = () => {
  const seeded = seed()
  const app = buildApi({
    repos: seeded.repos,
    manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
    createRun: (name: string) => seeded.repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
    registry: new RunRegistry(),
  })
  return { ...seeded, app }
}

describe('GET /api/runs/:runId/agents/:agentId', () => {
  test('200: agent, lineage self→seed, genomes asc, history with submission join', async () => {
    const { app, run, alpha, beta, gamma } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/agents/${gamma.id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)

    expect(body.agent).toEqual({
      agentId: gamma.id, label: 'gamma', bornRound: 3, diedRound: null,
      status: 'active', parentAgentId: beta.id,
    })

    expect(body.lineage).toEqual([
      { agentId: gamma.id, label: 'gamma', bornRound: 3 },
      { agentId: beta.id, label: 'beta', bornRound: 2 },
      { agentId: alpha.id, label: 'alpha', bornRound: 1 },
    ])

    expect(body.genomes).toEqual([
      { roundIdx: 1, strategyMd: 'strategy 3 round 1', notesMd: 'notes 3 round 1', modelId: 'model/3', temperature: 1.5, origin: 'seed' },
      { roundIdx: 2, strategyMd: 'strategy 3 round 2', notesMd: 'notes 3 round 2', modelId: 'model/3', temperature: 1.75, origin: 'mutation' },
      { roundIdx: 3, strategyMd: 'strategy 3 round 3', notesMd: 'notes 3 round 3', modelId: 'model/3', temperature: 2, origin: 'elite' },
    ])

    expect(body.history).toEqual([
      {
        roundIdx: 1, score: 10, rank: 3, band: 'bottom', rationaleMd: 'why gamma ranked 3 in round 1',
        submission: {
          status: 'ok', errorText: null, submissionMd: 'submission gamma round 1',
          fileManifest: [{ path: 'out-1.txt', bytes: 10 }], costUsd: 0.01, durationMs: 1001,
          tokens: { in: 100, out: 50, cacheRead: 5, cacheWrite: 7 },
        },
      },
      {
        roundIdx: 2, score: 70, rank: 1, band: 'elite', rationaleMd: 'why gamma ranked 1 in round 2',
        submission: {
          status: 'error', errorText: 'runner exploded', submissionMd: 'partial work',
          fileManifest: [{ path: 'partial.txt', bytes: 4 }], costUsd: 0.02, durationMs: 1002,
          tokens: { in: 200, out: 100, cacheRead: 10, cacheWrite: 14 },
        },
      },
      {
        roundIdx: 3, score: 40, rank: 2, band: 'top', rationaleMd: 'why gamma ranked 2 in round 3',
        submission: null,
      },
    ])
  })

  test('404 no such run', async () => {
    const { app, gamma } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/nope/agents/${gamma.id}` })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such run' })
  })

  test('404 no such agent', async () => {
    const { app, run } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/agents/nope` })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such agent' })
  })

  test('404 for a valid agent of a different run', async () => {
    const { app, repos, run } = setup()
    const other = repos.runs.create({ name: 'other', config: DEFAULT_CONFIG, seedDir: null })
    const foreign = repos.agents.create({ runId: other.id, label: 'foreign', parentAgentId: null, bornRound: 1 })
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/agents/${foreign.id}` })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such agent' })
  })
})

test('legacy 3-arg buildApi serves the agent-detail route on a repos-only run', async () => {
  const seeded = seed()
  const app = buildApi({
    repos: seeded.repos,
    manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
    createRun: (name: string) => seeded.repos.runs.create({ name, config: DEFAULT_CONFIG, seedDir: null }).id,
  })
  const res = await app.inject({ method: 'GET', url: `/api/runs/${seeded.run.id}/agents/${seeded.gamma.id}` })
  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.body).agent.agentId).toBe(seeded.gamma.id)
})

describe('GET /api/runs/:runId/rounds', () => {
  test('200: one entry per scored round, asc — fitness, modelShare, diversity, goalMd', async () => {
    const { app, run } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/rounds` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Array<{
      idx: number; goalMd: string; costUsd: number
      fitness: { mean: number; min: number; max: number }
      modelShare: { modelId: string; count: number }[]
      diversity: number
    }>
    // Round 1: only alpha/beta/gamma are alive; delta (born round 2, model/1) joins from round 2 on.
    expect(body.map((r) => r.idx)).toEqual([1, 2, 3])
    expect(body.map((r) => r.goalMd)).toEqual(['goal 1', 'goal 2', 'goal 3'])
    expect(body.every((r) => r.costUsd === 0)).toBe(true)
    // Hand-computed from the seed's score formula (100 − 30·rank):
    // r1: 70+40+10, r2: 40+10+70+40, r3: 10+70+40+10.
    expect(body.map((r) => r.fitness)).toEqual([
      { mean: 40, min: 10, max: 70 },
      { mean: 40, min: 10, max: 70 },
      { mean: 32.5, min: 10, max: 70 },
    ])
    // modelShare is sorted by modelId; delta doubles the model/1 count from round 2.
    expect(body.map((r) => r.modelShare)).toEqual([
      [{ modelId: 'model/1', count: 1 }, { modelId: 'model/2', count: 1 }, { modelId: 'model/3', count: 1 }],
      [{ modelId: 'model/1', count: 2 }, { modelId: 'model/2', count: 1 }, { modelId: 'model/3', count: 1 }],
      [{ modelId: 'model/1', count: 2 }, { modelId: 'model/2', count: 1 }, { modelId: 'model/3', count: 1 }],
    ])
    // Distinct strategy texts per round: some diversity, bounded by construction.
    for (const r of body) {
      expect(r.diversity).toBeGreaterThan(0)
      expect(r.diversity).toBeLessThanOrEqual(1)
    }
  })

  test('a round without score rows (in-flight) is excluded', async () => {
    const { app, repos, run } = setup()
    repos.rounds.create({ runId: run.id, idx: 4, goalMd: 'goal 4' })
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/rounds` })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.body) as Array<{ idx: number }>).map((r) => r.idx)).toEqual([1, 2, 3])
  })

  test('404 no such run', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope/rounds' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such run' })
  })
})
