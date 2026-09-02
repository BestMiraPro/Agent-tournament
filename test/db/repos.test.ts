import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'test', config: DEFAULT_CONFIG, seedDir: null })
  return { db, repos, run }
}

describe('repos', () => {
  test('creates and reads back a run with its config', () => {
    const { repos, run } = setup()
    const loaded = repos.runs.get(run.id)
    expect(loaded?.name).toBe('test')
    expect(loaded?.config.populationSize).toBe(20)
  })

  test('creates agents and lists only active ones', () => {
    const { repos, run } = setup()
    const a = repos.agents.create({ runId: run.id, label: 'competitor-01', parentAgentId: null, bornRound: 1 })
    repos.agents.create({ runId: run.id, label: 'competitor-02', parentAgentId: null, bornRound: 1 })
    repos.agents.retire(a.id, 1, 'culled')
    const active = repos.agents.listActive(run.id)
    expect(active.map((x) => x.label)).toEqual(['competitor-02'])
  })

  test('stores a genome and fetches it by agent and round', () => {
    const { repos, run } = setup()
    const a = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
    const g = repos.genomes.create({
      agentId: a.id, roundIdx: 1, strategyMd: 'be concise', notesMd: '',
      modelId: 'opencode/big-pickle', temperature: 0.8, parentGenomeId: null, origin: 'seed',
    })
    const got = repos.genomes.forRound(a.id, 1)
    expect(got?.id).toBe(g.id)
    expect(got?.strategyMd).toBe('be concise')
    expect(got?.modelId).toBe('opencode/big-pickle')
  })

  test('scores round-trip with rank ordering preserved', () => {
    const { repos, run } = setup()
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'goal' })
    const a1 = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
    const a2 = repos.agents.create({ runId: run.id, label: 'c2', parentAgentId: null, bornRound: 1 })
    repos.scores.insertMany(round.id, [
      { roundId: round.id, agentId: a2.id, rank: 1, score: 90, rationaleMd: 'good', band: 'elite' },
      { roundId: round.id, agentId: a1.id, rank: 2, score: 40, rationaleMd: 'weak', band: 'bottom' },
    ])
    const got = repos.scores.forRound(round.id)
    expect(got.map((s) => s.rank)).toEqual([1, 2])
    expect(got[0]!.agentId).toBe(a2.id)
  })

  test('round status transitions persist', () => {
    const { repos, run } = setup()
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'goal' })
    repos.rounds.setStatus(round.id, 'judging')
    expect(repos.rounds.get(round.id)?.status).toBe('judging')
  })

  test('lists rounds for a run ordered by idx', () => {
    const { repos, run } = setup()
    repos.rounds.create({ runId: run.id, idx: 2, goalMd: 'second' })
    repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'first' })
    const rounds = repos.rounds.listForRun(run.id)
    expect(rounds.map((r) => r.idx)).toEqual([1, 2])
    expect(rounds.map((r) => r.goalMd)).toEqual(['first', 'second'])
  })
})

describe('config round-trip', () => {
  test('preserves Infinity budget limits through the database', () => {
    const { repos } = setup()
    const cfg = {
      ...DEFAULT_CONFIG,
      budget: { ...DEFAULT_CONFIG.budget, maxRunUsd: Infinity, maxRoundUsd: Infinity },
    }
    const run = repos.runs.create({ name: 'inf', config: cfg, seedDir: null })
    const back = repos.runs.get(run.id)!
    expect(back.config.budget.maxRunUsd).toBe(Infinity)
    expect(back.config.budget.maxRoundUsd).toBe(Infinity)
  })

  test('preserves finite budget limits unchanged', () => {
    const { repos } = setup()
    const cfg = {
      ...DEFAULT_CONFIG,
      budget: { ...DEFAULT_CONFIG.budget, maxRunTokens: 1234 },
    }
    const run = repos.runs.create({ name: 'fin', config: cfg, seedDir: null })
    expect(repos.runs.get(run.id)!.config.budget.maxRunTokens).toBe(1234)
  })
})
