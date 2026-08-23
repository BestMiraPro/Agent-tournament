import { describe, expect, test } from 'vitest'
import { Judge } from '../../src/judge/judge.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'

const cfg = DEFAULT_CONFIG.judge
const judge = () => new Judge(new MockProvider(1), cfg, 42)

const sub = (agentId: string, fitness: number, status: 'ok' | 'error' = 'ok') => ({
  agentId,
  submissionMd: `work product FITNESS=${fitness}`,
  files: [],
  status,
})

describe('Judge.resolveCriteria', () => {
  test('uses user criteria verbatim when supplied', async () => {
    const r = await judge().resolveCriteria('goal', 'my criteria')
    expect(r).toEqual({ criteriaMd: 'my criteria', source: 'user' })
  })

  test('generates criteria when none are supplied', async () => {
    const r = await judge().resolveCriteria('goal', null)
    expect(r.source).toBe('generated')
    expect(r.criteriaMd).toContain('correctness')
  })
})

describe('Judge.score', () => {
  test('ranks higher-fitness submissions first', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90)])
    expect(res.scores[0]!.agentId).toBe('b')
    expect(res.scores[0]!.rank).toBe(1)
  })

  test('assigns contiguous ranks starting at 1', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90), sub('c', 50)])
    expect(res.scores.map((s) => s.rank)).toEqual([1, 2, 3])
  })

  test('excludes failed submissions from judging and ranks them last with score 0', async () => {
    const res = await judge().score('goal', 'criteria', [
      sub('a', 90), sub('bad', 0, 'error'), sub('b', 50),
    ])
    const failed = res.scores.find((s) => s.agentId === 'bad')!
    expect(failed.score).toBe(0)
    expect(failed.rank).toBe(3)
  })

  test('returns a meta digest', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90)])
    expect(res.metaDigest.length).toBeGreaterThan(0)
  })

  test('all-failed population produces zero scores without calling the model', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 0, 'error'), sub('b', 0, 'error')])
    expect(res.scores.every((s) => s.score === 0)).toBe(true)
    expect(res.scores).toHaveLength(2)
  })

  test('selects batched mode above the single-call population threshold', async () => {
    const many = Array.from({ length: 30 }, (_, i) => sub(`a${i}`, i))
    const res = await judge().score('goal', 'criteria', many)
    expect(res.mode).toBe('batched_finals')
    expect(res.scores).toHaveLength(30)
    expect(new Set(res.scores.map((s) => s.rank)).size).toBe(30)
  })

  test('uses single-call mode at or below the threshold', async () => {
    const res = await judge().score('goal', 'criteria', [sub('a', 10), sub('b', 90)])
    expect(res.mode).toBe('single_call')
  })
})
