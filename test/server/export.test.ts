import { describe, expect, test } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { buildCsvRows, buildJsonDump, csvEscape } from '../../src/server/export.js'

/** A 2-round x 2-agent run with submissions for all but alpha round 2, which
 * is scored with no submission row (pins `submission: null` / empty CSV
 * fields). Mirrors the round-detail test seed pattern. */
function seed() {
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const run = repos.runs.create({ name: 'export-demo', config: DEFAULT_CONFIG, seedDir: null })
  const alpha = repos.agents.create({ runId: run.id, label: 'alpha', parentAgentId: null, bornRound: 1 })
  const beta = repos.agents.create({ runId: run.id, label: 'beta', parentAgentId: null, bornRound: 1 })
  const r1 = repos.rounds.create({ runId: run.id, idx: 1, goalMd: 'goal 1' })
  const r2 = repos.rounds.create({ runId: run.id, idx: 2, goalMd: 'goal 2' })
  repos.rounds.setStatus(r1.id, 'complete')
  repos.rounds.setStatus(r2.id, 'complete')
  const models = { [alpha.id]: 'model/a', [beta.id]: 'model/b' } as Record<string, string>
  for (const a of [alpha, beta]) {
    for (const idx of [1, 2]) {
      repos.genomes.create({
        agentId: a.id, roundIdx: idx,
        strategyMd: `strategy ${a.label} round ${idx}`, notesMd: `notes ${a.label}`,
        modelId: models[a.id]!, temperature: 0.7,
        parentGenomeId: null, origin: 'seed',
      })
    }
  }
  const g1 = new Map([alpha, beta].map((a) => [a.id, repos.genomes.forRound(a.id, 1)!]))
  const g2 = new Map([alpha, beta].map((a) => [a.id, repos.genomes.forRound(a.id, 2)!]))
  repos.scores.insertMany(r1.id, [
    { roundId: r1.id, agentId: alpha.id, rank: 1, score: 90, rationaleMd: 'alpha r1', band: 'elite' },
    { roundId: r1.id, agentId: beta.id, rank: 2, score: 60, rationaleMd: 'beta r1', band: 'top' },
  ])
  repos.scores.insertMany(r2.id, [
    { roundId: r2.id, agentId: beta.id, rank: 1, score: 95, rationaleMd: 'beta r2', band: 'elite' },
    { roundId: r2.id, agentId: alpha.id, rank: 2, score: 35, rationaleMd: 'alpha r2', band: 'bottom' },
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
  submit(r1.id, alpha.id, g1.get(alpha.id)!.id, 1, 1)
  submit(r1.id, beta.id, g1.get(beta.id)!.id, 1, 1)
  submit(r2.id, beta.id, g2.get(beta.id)!.id, 2, 2)
  // alpha round 2: scored but never submitted — pins submission: null / empty CSV fields.
  return { repos, run, alpha, beta, r1, r2 }
}

describe('csvEscape', () => {
  test('plain has no quotes', () => {
    expect(csvEscape('hello')).toBe('hello')
  })
  test('comma is quoted', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
  })
  test('quote is doubled and quoted', () => {
    expect(csvEscape('a"b')).toBe('"a""b"')
  })
  test('newline is quoted', () => {
    expect(csvEscape('a\nb')).toBe('"a\nb"')
  })
  test('CRLF is quoted', () => {
    expect(csvEscape('a\r\nb')).toBe('"a\r\nb"')
  })
  test('empty string renders empty', () => {
    expect(csvEscape('')).toBe('')
  })
  test('null renders empty', () => {
    expect(csvEscape(null)).toBe('')
  })
  test('undefined renders empty', () => {
    expect(csvEscape(undefined)).toBe('')
  })
  test('number renders as its string form', () => {
    expect(csvEscape(42)).toBe('42')
  })
})

describe('buildCsvRows', () => {
  test('header + 4 data rows, CRLF endings, rank order within each round', () => {
    const { repos, run, alpha, beta } = seed()
    const csv = buildCsvRows(run.id, repos)
    // CRLF line endings throughout, with a trailing CRLF.
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.includes('\n')).toBe(true)
    expect(csv.includes('\r\n')).toBe(true)
    const lines = csv.split('\r\n')
    // trailing CRLF -> last split element is the empty string
    expect(lines[lines.length - 1]).toBe('')
    const rows = lines.slice(0, -1)
    expect(rows[0]).toBe('round,agentLabel,modelId,score,rank,band,tokensIn,tokensOut,costUsd,submissionStatus')
    expect(rows).toHaveLength(5) // header + 4 data rows (2 rounds x 2 agents)
    // Round 1: alpha rank 1, beta rank 2 (both submitted n=1).
    expect(rows[1]).toBe('1,alpha,model/a,90,1,elite,100,50,0.01,ok')
    expect(rows[2]).toBe('1,beta,model/b,60,2,top,100,50,0.01,ok')
    // Round 2: beta rank 1 (submitted n=2), alpha rank 2 (no submission).
    expect(rows[3]).toBe('2,beta,model/b,95,1,elite,200,100,0.02,ok')
    expect(rows[4]).toBe('2,alpha,model/a,35,2,bottom,,,,')
    // rank order within each round: ranks ascending per round block.
    expect(rows[1]).toMatch(/^1,alpha,.*,1,/)
    expect(rows[2]).toMatch(/^1,beta,.*,2,/)
    expect(rows[3]).toMatch(/^2,beta,.*,1,/)
    expect(rows[4]).toMatch(/^2,alpha,.*,2,/)
    void alpha
    void beta
  })
})

describe('buildJsonDump', () => {
  test('run + config + 2 rounds with entries + 2 agents + >=2 genomes', () => {
    const { repos, run, alpha, beta } = seed()
    const dump = buildJsonDump(run.id, repos)
    expect(dump).not.toBeNull()
    if (!dump) throw new Error('dump was null')
    expect(dump.run.id).toBe(run.id)
    expect(dump.config).toEqual(run.config)
    expect(dump.rounds).toHaveLength(2)
    // Each round carries its rank-ordered entries.
    const r0 = dump.rounds[0]!
    expect(r0.entries).toHaveLength(2)
    expect(r0.entries[0]).toMatchObject({
      agentId: alpha.id, label: 'alpha', modelId: 'model/a',
      score: 90, rank: 1, band: 'elite', rationaleMd: 'alpha r1',
    })
    expect(r0.entries[0]!.submission).toMatchObject({
      status: 'ok', tokens: { in: 100, out: 50 },
    })
    // alpha round 2 has a score but no submission row -> submission: null.
    const alphaR2 = dump.rounds[1]!.entries.find((e) => e.agentId === alpha.id)
    expect(alphaR2).toBeDefined()
    expect(alphaR2!.submission).toBeNull()
    expect(dump.agents).toHaveLength(2)
    expect(dump.agents.map((a) => a.id).sort()).toEqual([alpha.id, beta.id].sort())
    expect(dump.genomes.length).toBeGreaterThanOrEqual(2)
  })

  test('a round recorded before auditing exports as not recorded, never as an empty clean audit', () => {
    const { repos, run } = seed()
    const dump = buildJsonDump(run.id, repos)!
    expect(dump.rounds.map((r) => r.audit)).toEqual([
      { status: 'not_recorded', frozen: null, records: [], late: [], digestMatches: null },
      { status: 'not_recorded', frozen: null, records: [], late: [], digestMatches: null },
    ])
    expect(dump.rounds.map((r) => r.judging)).toEqual([[], []])
  })
})
