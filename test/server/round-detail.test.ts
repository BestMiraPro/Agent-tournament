import { describe, expect, test } from 'vitest'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry } from '../../src/server/runs.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

/**
 * A 2-round run (round 1: user criteria + digest + batched_finals judge mode;
 * round 2: generated defaults) over a mixed 3-model roster, plus a created but
 * unscored round 3 (in-flight) and a foreign run owning idx 5 (round scoping).
 * Round-2 gamma has a score but NO submission row (pins `submission: null`).
 */
function seed() {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'demo', config: DEFAULT_CONFIG, seedDir: null })
  const alpha = repos.agents.create({ runId: run.id, label: 'alpha', parentAgentId: null, bornRound: 1 })
  const beta = repos.agents.create({ runId: run.id, label: 'beta', parentAgentId: null, bornRound: 1 })
  const gamma = repos.agents.create({ runId: run.id, label: 'gamma', parentAgentId: null, bornRound: 1 })
  const r1 = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'goal 1' })
  const r2 = repos.rounds.create({ runId: run.id, idx: 2, goalMd: 'goal 2' })
  repos.rounds.setCriteria(r1.id, 'user rules', 'user')
  repos.rounds.setDigest(r1.id, 'winners wrote tests')
  repos.rounds.setJudgeMode(r1.id, 'batched_finals')
  repos.rounds.setStatus(r1.id, 'complete')
  repos.rounds.markEnded(r1.id, 0.05)
  repos.rounds.setStatus(r2.id, 'complete')
  repos.rounds.markEnded(r2.id, 0.07)
  const r3 = repos.rounds.create({ runId: run.id, idx: 3, goalMd: 'goal 3' })
  const models = { [alpha.id]: 'model/1', [beta.id]: 'model/2', [gamma.id]: 'model/3' } as Record<string, string>
  for (const a of [alpha, beta, gamma]) {
    for (const idx of [1, 2, 3]) {
      repos.genomes.create({
        agentId: a.id, roundIdx: idx,
        strategyMd: `strategy ${a.label} round ${idx}`, notesMd: `notes ${a.label}`,
        modelId: models[a.id]!, temperature: 0.7,
        parentGenomeId: null, origin: 'seed',
      })
    }
  }
  const genomes1 = new Map(
    [alpha, beta, gamma].map((a) => [a.id, repos.genomes.forRound(a.id, 1)!]),
  )
  const genomes2 = new Map(
    [alpha, beta, gamma].map((a) => [a.id, repos.genomes.forRound(a.id, 2)!]),
  )
  repos.scores.insertMany(r1.id, [
    { roundId: r1.id, agentId: alpha.id, rank: 1, score: 90, rationaleMd: 'alpha best round 1', band: 'elite' },
    { roundId: r1.id, agentId: beta.id, rank: 2, score: 60, rationaleMd: 'beta second round 1', band: 'top' },
    { roundId: r1.id, agentId: gamma.id, rank: 3, score: 30, rationaleMd: 'gamma third round 1', band: 'bottom' },
  ])
  repos.scores.insertMany(r2.id, [
    { roundId: r2.id, agentId: beta.id, rank: 1, score: 95, rationaleMd: 'beta best round 2', band: 'elite' },
    { roundId: r2.id, agentId: gamma.id, rank: 2, score: 65, rationaleMd: 'gamma second round 2', band: 'top' },
    { roundId: r2.id, agentId: alpha.id, rank: 3, score: 35, rationaleMd: 'alpha third round 2', band: 'bottom' },
  ])
  const submit = (
    roundId: string, agentId: string, genomeId: string, idx: number, n: number,
  ) => repos.submissions.create({
    roundId, agentId, genomeId,
    submissionMd: `submission ${agentId.slice(0, 4)} round ${idx}`,
    fileManifest: [{ path: `out-${idx}.txt`, bytes: 10 * idx }],
    workspacePath: `/ws/${idx}`, status: 'ok', errorText: null,
    tokensIn: 100 * n, tokensOut: 50 * n,
    tokensCacheRead: 5 * n, tokensCacheWrite: 7 * n,
    costUsd: 0.01 * n, durationMs: 1000 + n,
  })
  for (const a of [alpha, beta, gamma]) submit(r1.id, a.id, genomes1.get(a.id)!.id, 1, 1)
  // Gamma scored in round 2 but never submitted: submission must read null.
  for (const a of [alpha, beta]) submit(r2.id, a.id, genomes2.get(a.id)!.id, 2, 2)
  const other = repos.runs.create({ name: 'other', config: DEFAULT_CONFIG, seedDir: null })
  repos.rounds.create({ runId: other.id, idx: 5, goalMd: 'foreign goal' })
  return { repos, run, alpha, beta, gamma, r3 }
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

describe('GET /api/runs/:runId/rounds/:idx', () => {
  test('200: full header + entries ASC by rank with submission join (user-criteria round)', async () => {
    const { app, run, alpha, beta, gamma } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/rounds/1` })
    expect(res.statusCode).toBe(200)
    const sub = (n: number) => ({
      status: 'ok', errorText: null,
      submissionMd: expect.stringContaining('round 1'),
      fileManifest: [{ path: 'out-1.txt', bytes: 10 }],
      costUsd: 0.01 * n, durationMs: 1000 + n,
      tokens: { in: 100 * n, out: 50 * n, cacheRead: 5 * n, cacheWrite: 7 * n },
      usageKnown: true,
    })
    expect(JSON.parse(res.body)).toEqual({
      idx: 1, goalMd: 'goal 1',
      criteriaMd: 'user rules', criteriaSource: 'user',
      metaDigest: 'winners wrote tests', costUsd: 0.05,
      status: 'complete', judgeMode: 'batched_finals',
      entries: [
        {
          agentId: alpha.id, label: 'alpha', modelId: 'model/1',
          score: 90, rank: 1, band: 'elite', rationaleMd: 'alpha best round 1',
          submission: sub(1),
        },
        {
          agentId: beta.id, label: 'beta', modelId: 'model/2',
          score: 60, rank: 2, band: 'top', rationaleMd: 'beta second round 1',
          submission: sub(1),
        },
        {
          agentId: gamma.id, label: 'gamma', modelId: 'model/3',
          score: 30, rank: 3, band: 'bottom', rationaleMd: 'gamma third round 1',
          submission: sub(1),
        },
      ],
    })
  })

  test('200: generated-source header + the null-submission entry (round 2)', async () => {
    const { app, run, alpha, beta, gamma } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/rounds/2` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({
      idx: 2, goalMd: 'goal 2',
      criteriaMd: null, criteriaSource: 'generated',
      metaDigest: null, costUsd: 0.07,
      status: 'complete', judgeMode: 'single_call',
    })
    expect(body.entries.map((e: { agentId: string }) => e.agentId)).toEqual([beta.id, gamma.id, alpha.id])
    const [first, second, third] = body.entries
    expect(first.submission).toMatchObject({
      status: 'ok', fileManifest: [{ path: 'out-2.txt', bytes: 20 }],
      tokens: { in: 200, out: 100, cacheRead: 10, cacheWrite: 14 },
    })
    expect(second).toMatchObject({
      agentId: gamma.id, label: 'gamma', modelId: 'model/3',
      score: 65, rank: 2, rationaleMd: 'gamma second round 2', submission: null,
    })
    expect(third.submission).not.toBeNull()
    expect(body).not.toHaveProperty('judgeModel')
  })

  test('404 no such run', async () => {
    const { app } = setup()
    const res = await app.inject({ method: 'GET', url: '/api/runs/nope/rounds/1' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such run' })
  })

  test('404 no such round — idx scoped to the run (idx 5 exists only in another run)', async () => {
    const { app, run } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/rounds/5` })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such round' })
  })

  test('200 with entries [] for a created-but-unscored round', async () => {
    const { app, run } = setup()
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/rounds/3` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      idx: 3, goalMd: 'goal 3',
      criteriaMd: null, criteriaSource: 'generated',
      metaDigest: null, costUsd: 0,
      status: 'pending', judgeMode: 'single_call',
      entries: [],
    })
  })
})
