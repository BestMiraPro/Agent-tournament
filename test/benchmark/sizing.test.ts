import { describe, expect, test } from 'vitest'
import {
  evaluateCandidate,
  recommendDefault,
  recommendSimultaneous,
  type CandidateEvidence,
} from '../../src/benchmark/sizing.js'

const MiB = 1024 ** 2

const worker = (over: Record<string, unknown> = {}) => ({
  worker: 'arena-bench-1-0',
  containerId: 'abc123',
  memoryLimitBytes: 1024 * MiB,
  peakBytes: 600 * MiB,
  currentBytes: 400 * MiB,
  anonBytes: 350 * MiB,
  tmpfsBytes: 10 * MiB,
  oomKills: 0,
  oomKilled: false,
  exitCode: null,
  running: true,
  readyMs: 8000,
  completed: true,
  submissionsExpected: 1,
  submissionsPresent: 1,
  cleanupMs: 1500,
  leftovers: [] as string[],
  toolTurns: 120,
  ...over,
})

const candidate = (over: Record<string, unknown> = {}): CandidateEvidence => ({
  lifecycle: 'recycled',
  memory: '1g',
  simultaneous: 2,
  minToolTurns: 100,
  rounds: 10,
  admittedWithoutHostChanges: true,
  repetitions: [
    { completedRounds: 10, workers: [worker(), worker({ worker: 'arena-bench-1-1' })], bookkeeping: [{ round: 1, endpoints: 2, sessions: 2 }, { round: 10, endpoints: 2, sessions: 2 }] },
    { completedRounds: 10, workers: [worker(), worker({ worker: 'arena-bench-1-1' })], bookkeeping: [{ round: 1, endpoints: 2, sessions: 2 }, { round: 10, endpoints: 2, sessions: 2 }] },
    { completedRounds: 10, workers: [worker(), worker({ worker: 'arena-bench-1-1' })], bookkeeping: [{ round: 1, endpoints: 2, sessions: 2 }, { round: 10, endpoints: 2, sessions: 2 }] },
  ],
  ...over,
})

describe('evaluateCandidate', () => {
  test('a clean candidate is eligible', () => {
    expect(evaluateCandidate(candidate())).toEqual({ eligible: true, failures: [] })
  })

  test('an incomplete round fails', () => {
    const c = candidate()
    c.repetitions[1] = { ...c.repetitions[1]!, completedRounds: 9, workers: c.repetitions[1]!.workers, bookkeeping: c.repetitions[1]!.bookkeeping }
    const r = evaluateCandidate(c)
    expect(r.eligible).toBe(false)
    expect(r.failures.join(' ')).toMatch(/complet/)
  })

  test('any OOM kill fails', () => {
    const c = candidate()
    c.repetitions[0]!.workers[0] = worker({ oomKills: 1, oomKilled: true, completed: false })
    const r = evaluateCandidate(c)
    expect(r.eligible).toBe(false)
    expect(r.failures.join(' ')).toMatch(/OOM/i)
  })

  test('a missing submission fails', () => {
    const c = candidate()
    c.repetitions[2]!.workers[1] = worker({ submissionsPresent: 0 })
    expect(evaluateCandidate(c).eligible).toBe(false)
  })

  test('a peak at or above 80% of the limit fails, just below passes', () => {
    expect(evaluateCandidate(candidate()).eligible).toBe(true)
    const over = candidate()
    over.repetitions[0]!.workers[0] = worker({ peakBytes: Math.ceil(0.8 * 1024 * MiB) })
    expect(evaluateCandidate(over).eligible).toBe(false)
  })

  test('leftover resources after cleanup fail', () => {
    const c = candidate()
    c.repetitions[0]!.workers[0] = worker({ leftovers: ['arena-bench-1-gw-0'] })
    const r = evaluateCandidate(c)
    expect(r.eligible).toBe(false)
    expect(r.failures.join(' ')).toMatch(/left resources behind|remaining/i)
  })

  test('growing endpoint/session bookkeeping fails', () => {
    const c = candidate()
    c.repetitions[0]!.bookkeeping = [{ round: 1, endpoints: 2, sessions: 2 }, { round: 10, endpoints: 4, sessions: 5 }]
    expect(evaluateCandidate(c).eligible).toBe(false)
  })

  test('fewer than the protocol tool turns fails the worker', () => {
    const c = candidate()
    c.repetitions[0]!.workers[0] = worker({ toolTurns: 99 })
    const r = evaluateCandidate(c)
    expect(r.eligible).toBe(false)
    expect(r.failures.join(' ')).toMatch(/tool/i)
  })

  test('unknown OOM or peak readings fail closed, never pass silently', () => {
    expect(evaluateCandidate(candidate({ repetitions: [{ completedRounds: 10, workers: [worker({ peakBytes: null })], bookkeeping: [{ round: 1, endpoints: 1, sessions: 1 }] }] })).eligible).toBe(false)
    expect(evaluateCandidate(candidate({ repetitions: [{ completedRounds: 10, workers: [worker({ oomKills: null })], bookkeeping: [{ round: 1, endpoints: 1, sessions: 1 }] }] })).eligible).toBe(false)
  })

  test('admission that needed host changes fails', () => {
    expect(evaluateCandidate(candidate({ admittedWithoutHostChanges: false })).eligible).toBe(false)
  })
})

describe('recommendSimultaneous', () => {
  test('picks the highest passing simultaneous count', () => {
    const at = (n: number, eligible: boolean) => ({ ...candidate({ simultaneous: n }), verdict: eligible })
    void at
    const results = [
      { evidence: candidate({ simultaneous: 1 }), verdict: evaluateCandidate(candidate({ simultaneous: 1 })) },
      { evidence: candidate({ simultaneous: 2 }), verdict: evaluateCandidate(candidate({ simultaneous: 2 })) },
      { evidence: candidate({ simultaneous: 3, repetitions: [] }), verdict: evaluateCandidate(candidate({ simultaneous: 3, repetitions: [] })) },
    ]
    expect(recommendSimultaneous(results)).toBe(2)
  })

  test('no passing candidate recommends zero', () => {
    const results = [{ evidence: candidate({ simultaneous: 1, admittedWithoutHostChanges: false }), verdict: evaluateCandidate(candidate({ simultaneous: 1, admittedWithoutHostChanges: false })) }]
    expect(recommendSimultaneous(results)).toBe(0)
  })
})

describe('recommendDefault', () => {
  test('768m becomes the default only when it passes', () => {
    expect(recommendDefault({ passing768m: true, ceiling768m: 3, ceiling1g: 2 })).toBe('768m')
    expect(recommendDefault({ passing768m: false, ceiling768m: 0, ceiling1g: 2 })).toBe('1g')
  })
})
