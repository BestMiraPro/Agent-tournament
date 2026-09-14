import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildRunSnapshot } from '../../src/server/state.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'demo', initialGoal: 'initial dashboard goal', config: DEFAULT_CONFIG, seedDir: null })
  const a1 = repos.agents.create({ runId: run.id, label: 'competitor-01', parentAgentId: null, bornRound: 1 })
  const a2 = repos.agents.create({ runId: run.id, label: 'competitor-02', parentAgentId: null, bornRound: 1 })
  for (const a of [a1, a2]) {
    repos.genomes.create({
      agentId: a.id, roundIdx: 1, strategyMd: `strategy for ${a.label}`, notesMd: '',
      modelId: 'opencode/big-pickle', temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
  }
  return { repos, run, a1, a2 }
}

describe('buildRunSnapshot', () => {
  test('returns null for an unknown run', () => {
    const { repos } = setup()
    expect(buildRunSnapshot(repos, 'nope')).toBeNull()
  })

  test('includes the run name and active agents', () => {
    const { repos, run } = setup()
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.name).toBe('demo')
    expect(s.agents).toHaveLength(2)
    expect(s.agents.map((a) => a.label).sort()).toEqual(['competitor-01', 'competitor-02'])
  })

  test('reports each agent model from its current genome', () => {
    const { repos, run } = setup()
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.agents.every((a) => a.modelId === 'opencode/big-pickle')).toBe(true)
  })

  test('reports round zero before any round has run', () => {
    const { repos, run } = setup()
    const snapshot = buildRunSnapshot(repos, run.id)!
    expect(snapshot.lastRoundIdx).toBe(0)
    expect(snapshot.goalMd).toBe('initial dashboard goal')
  })

  test('includes scores from the latest completed round', () => {
    const { repos, run, a1, a2 } = setup()
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
    repos.scores.insertMany(round.id, [
      { roundId: round.id, agentId: a2.id, rank: 1, score: 90, rationaleMd: 'strong', band: 'elite' },
      { roundId: round.id, agentId: a1.id, rank: 2, score: 40, rationaleMd: 'weak', band: 'bottom' },
    ])
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.lastRoundIdx).toBe(1)
    expect(s.scores[0]!.rank).toBe(1)
    expect(s.scores[0]!.agentId).toBe(a2.id)
    expect(s.goalMd).toBe('g')
  })

  test('is JSON-serializable', () => {
    const { repos, run } = setup()
    expect(() => JSON.stringify(buildRunSnapshot(repos, run.id))).not.toThrow()
  })
})

describe('buildRunSnapshot criteria', () => {
  const CRITERIA = 'Calmar first\nOmega second'

  test('carries the exact creation criteria before round 1', () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({
      name: 'with criteria', initialGoal: 'g', initialCriteria: CRITERIA, config: DEFAULT_CONFIG, seedDir: null,
    })
    const s = buildRunSnapshot(repos, run.id)!
    expect(s.initialCriteria).toBe(CRITERIA)
    // Nothing has been applied yet: creation criteria are a draft default, not a round's.
    expect(s.lastRoundCriteria).toBeNull()
  })

  test('a run created without criteria reports null rather than another run\'s', () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    repos.runs.create({ name: 'A', initialCriteria: CRITERIA, config: DEFAULT_CONFIG, seedDir: null })
    const b = repos.runs.create({ name: 'B', config: DEFAULT_CONFIG, seedDir: null })
    expect(buildRunSnapshot(repos, b.id)!.initialCriteria).toBeNull()
  })

  test('reports the criteria applied to the round in flight, so a refresh during work keeps them', () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({ name: 'r', initialCriteria: 'creation text', config: DEFAULT_CONFIG, seedDir: null })
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
    repos.rounds.setCriteria(round.id, CRITERIA, 'user')
    repos.rounds.setStatus(round.id, 'running')
    expect(buildRunSnapshot(repos, run.id)!.lastRoundCriteria).toEqual({
      roundIdx: 1, criteriaMd: CRITERIA, source: 'user', status: 'running',
    })
  })

  test('a round still waiting for generated criteria reports none, not the creation default', () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({ name: 'r', initialCriteria: 'creation text', config: DEFAULT_CONFIG, seedDir: null })
    repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
    expect(buildRunSnapshot(repos, run.id)!.lastRoundCriteria).toEqual({
      roundIdx: 1, criteriaMd: null, source: 'generated', status: 'pending',
    })
  })
})

test('snapshot carries sandbox and roster from run config', () => {
  const { repos, run } = setup()
  const s = buildRunSnapshot(repos, run.id, { sandbox: 'mock', roster: [], warnings: [], capacity: null } as never)!
  expect(s.sandbox).toBe('mock')
  expect(s.warnings).toEqual([])
})

test('snapshot scores say which ranked agents had failed, so a reload keeps that visible', () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
  const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
  const ok = repos.agents.create({ runId: run.id, label: 'ok', parentAgentId: null, bornRound: 1 })
  const bad = repos.agents.create({ runId: run.id, label: 'bad', parentAgentId: null, bornRound: 1 })
  const entries: [typeof ok, 'ok' | 'error'][] = [[ok, 'ok'], [bad, 'error']]
  for (const [agent, status] of entries) {
    const genome = repos.genomes.create({
      agentId: agent.id, roundIdx: 1, strategyMd: 's', notesMd: '',
      modelId: 'm/x', temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
    repos.submissions.create({
      roundId: round.id, agentId: agent.id, genomeId: genome.id, submissionMd: null, fileManifest: [],
      workspacePath: '', status, errorText: null,
      tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, durationMs: 0,
    })
  }
  // A failed zero-score agent can still be persisted at rank 1.
  repos.scores.insertMany(round.id, [
    { roundId: round.id, agentId: bad.id, rank: 1, score: 0, rationaleMd: '', band: null },
    { roundId: round.id, agentId: ok.id, rank: 2, score: 0, rationaleMd: '', band: null },
  ])
  const s = buildRunSnapshot(repos, run.id)!
  expect(s.scores.find((x) => x.agentId === bad.id)?.failed).toBe(true)
  expect(s.scores.find((x) => x.agentId === ok.id)?.failed).toBe(false)
})
