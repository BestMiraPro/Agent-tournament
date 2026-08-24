import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const setup = () => {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
  const round = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'g' })
  const agent = repos.agents.create({ runId: run.id, label: 'c1', parentAgentId: null, bornRound: 1 })
  const genome = repos.genomes.create({
    agentId: agent.id, roundIdx: 1, strategyMd: 's', notesMd: '',
    modelId: 'm/x', temperature: 0.7, parentGenomeId: null, origin: 'seed',
  })
  return { db, repos, run, round, agent, genome }
}

describe('submissions repo', () => {
  test('stores and reads back a submission with cache tokens and cost', () => {
    const { repos, round, agent, genome } = setup()
    repos.submissions.create({
      roundId: round.id, agentId: agent.id, genomeId: genome.id,
      submissionMd: 'my answer', fileManifest: [{ path: 'a.txt', bytes: 3 }],
      workspacePath: '/w/a1', status: 'ok', errorText: null,
      tokensIn: 60, tokensOut: 30, tokensCacheRead: 5, tokensCacheWrite: 1,
      costUsd: 0.25, durationMs: 1234,
    })
    const rows = repos.submissions.forRound(round.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.submissionMd).toBe('my answer')
    expect(rows[0]!.tokensCacheRead).toBe(5)
    expect(rows[0]!.costUsd).toBe(0.25)
    expect(rows[0]!.fileManifest).toEqual([{ path: 'a.txt', bytes: 3 }])
  })

  test('totals cost for a round', () => {
    const { repos, round, agent, genome } = setup()
    const base = {
      roundId: round.id, genomeId: genome.id, submissionMd: null, fileManifest: [],
      workspacePath: '/w', status: 'ok' as const, errorText: null,
      tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, durationMs: 0,
    }
    repos.submissions.create({ ...base, agentId: agent.id, costUsd: 0.25 })
    expect(repos.submissions.totalCost(round.id)).toBeCloseTo(0.25)
  })
})

describe('events repo', () => {
  test('appends and reads events in order', () => {
    const { repos, run, round } = setup()
    repos.events.append({ runId: run.id, roundId: round.id, agentId: null, type: 'round.status', payload: { status: 'running' } })
    repos.events.append({ runId: run.id, roundId: round.id, agentId: null, type: 'round.status', payload: { status: 'judging' } })
    const evts = repos.events.forRun(run.id)
    expect(evts).toHaveLength(2)
    expect(evts[0]!.payload).toEqual({ status: 'running' })
    expect(evts[1]!.type).toBe('round.status')
  })
})

describe('rounds repo timing', () => {
  test('records start, end and cost', () => {
    const { repos, round } = setup()
    repos.rounds.markStarted(round.id)
    repos.rounds.markEnded(round.id, 1.5)
    const r = repos.rounds.get(round.id)!
    expect(r.startedAt).toBeGreaterThan(0)
    expect(r.endedAt).toBeGreaterThan(0)
    expect(r.costUsd).toBeCloseTo(1.5)
  })

  test('records the judge mode actually used', () => {
    const { repos, round } = setup()
    repos.rounds.setJudgeMode(round.id, 'batched_finals')
    expect(repos.rounds.get(round.id)!.judgeMode).toBe('batched_finals')
  })
})
