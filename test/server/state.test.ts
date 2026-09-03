import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildRunSnapshot } from '../../src/server/state.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'demo', config: DEFAULT_CONFIG, seedDir: null })
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
    expect(buildRunSnapshot(repos, run.id)!.lastRoundIdx).toBe(0)
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
  })

  test('is JSON-serializable', () => {
    const { repos, run } = setup()
    expect(() => JSON.stringify(buildRunSnapshot(repos, run.id))).not.toThrow()
  })
})

test('snapshot carries sandbox and roster from run config', () => {
  const { repos, run } = setup()
  const s = buildRunSnapshot(repos, run.id, { sandbox: 'mock', roster: [], warnings: [], capacity: null } as never)!
  expect(s.sandbox).toBe('mock')
  expect(s.warnings).toEqual([])
})
