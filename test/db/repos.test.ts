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

  test('lists runs newest first', () => {
    const { db, repos, run } = setup()
    const second = repos.runs.create({ name: 'second', config: DEFAULT_CONFIG, seedDir: null })
    // Force distinct timestamps so ordering is deterministic even when both runs are
    // created within the same millisecond.
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(run.createdAt - 1000, run.id)
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(run.createdAt + 1000, second.id)
    const runs = repos.runs.list()
    expect(runs.map((r) => r.id)).toEqual([second.id, run.id])
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

describe('agent-detail getters', () => {
  test('agents.listAll returns every agent of the run in insertion order, all statuses', () => {
    const { repos, run } = setup()
    const a1 = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
    const a2 = repos.agents.create({ runId: run.id, label: 'c2', parentAgentId: a1.id, bornRound: 2 })
    const other = repos.runs.create({ name: 'other', config: DEFAULT_CONFIG, seedDir: null })
    repos.agents.create({ runId: other.id, label: 'foreign', parentAgentId: null, bornRound: 1 })
    repos.agents.retire(a1.id, 2, 'culled')
    const all = repos.agents.listAll(run.id)
    expect(all.map((x) => x.id)).toEqual([a1.id, a2.id])
    expect(all[0]!.status).toBe('culled')
    expect(all[0]!.diedRound).toBe(2)
    expect(all[1]!.parentAgentId).toBe(a1.id)
    expect(repos.agents.listAll(other.id)).toHaveLength(1)
  })

  test('genomes.forAgent returns the agent\'s genomes ascending by round_idx', () => {
    const { repos, run } = setup()
    const a1 = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
    const a2 = repos.agents.create({ runId: run.id, label: 'c2', parentAgentId: null, bornRound: 1 })
    // Insert out of order, interleaved with another agent, to pin ASC + scoping.
    const g3 = repos.genomes.create({
      agentId: a1.id, roundIdx: 3, strategyMd: 's3', notesMd: 'n3',
      modelId: 'm/3', temperature: 0.9, parentGenomeId: null, origin: 'mutation',
    })
    repos.genomes.create({
      agentId: a2.id, roundIdx: 2, strategyMd: 'x2', notesMd: '',
      modelId: 'm/2', temperature: 0.5, parentGenomeId: null, origin: 'elite',
    })
    const g1 = repos.genomes.create({
      agentId: a1.id, roundIdx: 1, strategyMd: 's1', notesMd: 'n1',
      modelId: 'm/1', temperature: 0.3, parentGenomeId: null, origin: 'seed',
    })
    const g2 = repos.genomes.create({
      agentId: a1.id, roundIdx: 2, strategyMd: 's2', notesMd: 'n2',
      modelId: 'm/2', temperature: 0.6, parentGenomeId: null, origin: 'clone',
    })
    const got = repos.genomes.forAgent(a1.id)
    expect(got.map((g) => g.roundIdx)).toEqual([1, 2, 3])
    expect(got.map((g) => g.id)).toEqual([g1.id, g2.id, g3.id])
    expect(got[0]!.strategyMd).toBe('s1')
    expect(got[0]!.origin).toBe('seed')
    expect(got[2]!.modelId).toBe('m/3')
    expect(got[2]!.temperature).toBe(0.9)
    expect(repos.genomes.forAgent(a2.id).map((g) => g.roundIdx)).toEqual([2])
    expect(repos.genomes.forAgent('unknown-agent')).toEqual([])
  })

  test('scores.forAgent returns the agent\'s scores ascending by round idx, scoped to the run', () => {
    const { repos, run } = setup()
    const a1 = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
    const a2 = repos.agents.create({ runId: run.id, label: 'c2', parentAgentId: null, bornRound: 1 })
    const r1 = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g1' })
    const r2 = repos.rounds.create({ runId: run.id, idx: 2, goalMd: 'g2' })
    const other = repos.runs.create({ name: 'other', config: DEFAULT_CONFIG, seedDir: null })
    const ro = repos.rounds.create({ runId: other.id, idx: 1, goalMd: 'foreign' })
    // Score round 2 first so the ordering comes from the join, not write order.
    repos.scores.insertMany(r2.id, [
      { roundId: r2.id, agentId: a1.id, rank: 1, score: 90, rationaleMd: 'strong', band: 'elite' },
      { roundId: r2.id, agentId: a2.id, rank: 2, score: 50, rationaleMd: 'mid', band: 'middle' },
    ])
    repos.scores.insertMany(r1.id, [
      { roundId: r1.id, agentId: a1.id, rank: 2, score: 40, rationaleMd: 'weak', band: 'bottom' },
      { roundId: r1.id, agentId: a2.id, rank: 1, score: 80, rationaleMd: 'ok', band: 'top' },
    ])
    repos.scores.insertMany(ro.id, [
      { roundId: ro.id, agentId: a1.id, rank: 1, score: 99, rationaleMd: 'foreign', band: 'elite' },
    ])
    const got = repos.scores.forAgent(run.id, a1.id)
    expect(got.map((s) => s.roundIdx)).toEqual([1, 2])
    expect(got[0]!.roundId).toBe(r1.id)
    expect(got[0]!.rank).toBe(2)
    expect(got[0]!.score).toBe(40)
    expect(got[1]!.roundId).toBe(r2.id)
    expect(got[1]!.band).toBe('elite')
    expect(repos.scores.forAgent(run.id, a2.id).map((s) => [s.roundIdx, s.rank])).toEqual([[1, 1], [2, 2]])
    expect(repos.scores.forAgent(other.id, a1.id)).toHaveLength(1)
    expect(repos.scores.forAgent(run.id, 'unknown-agent')).toEqual([])
  })

  test('submissions.forAgent returns the single (round, agent) row or null', () => {
    const { repos, run } = setup()
    const a1 = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
    const g = repos.genomes.create({
      agentId: a1.id, roundIdx: 1, strategyMd: 's', notesMd: '',
      modelId: 'm', temperature: 0.7, parentGenomeId: null, origin: 'seed',
    })
    repos.submissions.create({
      roundId: round.id, agentId: a1.id, genomeId: g.id,
      submissionMd: 'did it', fileManifest: [{ path: 'answer.txt', bytes: 12 }],
      workspacePath: '/ws', status: 'error', errorText: 'boom',
      tokensIn: 100, tokensOut: 50, tokensCacheRead: 5, tokensCacheWrite: 7,
      costUsd: 0.01, durationMs: 1234,
    })
    const got = repos.submissions.forAgent(round.id, a1.id)
    expect(got).not.toBeNull()
    expect(got!.status).toBe('error')
    expect(got!.errorText).toBe('boom')
    expect(got!.fileManifestJson).toBe(JSON.stringify([{ path: 'answer.txt', bytes: 12 }]))
    expect(got!.tokensIn).toBe(100)
    expect(got!.costUsd).toBe(0.01)
    expect(got!.durationMs).toBe(1234)
    expect(repos.submissions.forAgent(round.id, 'unknown-agent')).toBeNull()
    expect(repos.submissions.forAgent('unknown-round', a1.id)).toBeNull()
  })

  test('submissions record whether their usage was observed', () => {
    const { repos, run } = setup()
    const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
    const write = (label: string, usageKnown?: boolean) => {
      const agent = repos.agents.create({ runId: run.id, label, parentAgentId: null, bornRound: 1 })
      const genome = repos.genomes.create({
        agentId: agent.id, roundIdx: 1, strategyMd: 's', notesMd: '',
        modelId: 'm', temperature: 0.7, parentGenomeId: null, origin: 'seed',
      })
      repos.submissions.create({
        roundId: round.id, agentId: agent.id, genomeId: genome.id,
        submissionMd: null, fileManifest: [], workspacePath: '/ws', status: 'error', errorText: 'x',
        tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, durationMs: 1,
        ...(usageKnown === undefined ? {} : { usageKnown }),
      })
      return agent.id
    }
    const observed = write('observed')
    const lost = write('lost', false)
    expect(repos.submissions.forAgent(round.id, observed)!.usageKnown).toBe(true)
    expect(repos.submissions.forAgent(round.id, lost)!.usageKnown).toBe(false)
    const byAgent = new Map(repos.submissions.forRound(round.id).map((s) => [s.agentId, s.usageKnown]))
    expect(byAgent.get(observed)).toBe(true)
    expect(byAgent.get(lost)).toBe(false)
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
