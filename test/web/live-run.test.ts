import { describe, expect, test } from 'vitest'
import { liveReducer, initialLiveState } from '../../web/src/useLiveRun.js'
import { nextDelay } from '../../web/src/useLiveRun.js'

describe('liveReducer', () => {
  test('marks an agent running', () => {
    const s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'running' })
    expect(s.agents['a']?.status).toBe('running')
  })

  test('records the latest activity for an agent', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.activity', runId: 'r', agentId: 'a', kind: 'tool', detail: 'bash' })
    s = liveReducer(s, { type: 'agent.activity', runId: 'r', agentId: 'a', kind: 'tool', detail: 'read' })
    expect(s.agents['a']?.activity).toBe('read')
  })

  test('accumulates usage', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 10, tokensOut: 5, costUsd: 0.1 })
    s = liveReducer(s, { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 20, tokensOut: 5, costUsd: 0.2 })
    expect(s.agents['a']?.tokensIn).toBe(30)
    expect(s.agents['a']?.costUsd).toBeCloseTo(0.3)
  })

  test('stores scores by rank', () => {
    const s = liveReducer(initialLiveState, {
      type: 'round.scored', runId: 'r', roundIdx: 1,
      scores: [{ agentId: 'b', rank: 1, score: 90 }, { agentId: 'a', rank: 2, score: 40 }],
    })
    expect(s.scores[0]!.agentId).toBe('b')
  })

  test('tracks round status', () => {
    const s = liveReducer(initialLiveState, { type: 'round.status', runId: 'r', roundIdx: 1, status: 'judging' })
    expect(s.roundStatus).toBe('judging')
  })

  test('round.complete clears the busy flag and records a breach', () => {
    const s = liveReducer(initialLiveState, { type: 'round.complete', runId: 'r', roundIdx: 1, budgetBreach: 'over budget' })
    expect(s.busy).toBe(false)
    expect(s.lastBreach).toBe('over budget')
  })

  test('a new round resets agent activity but keeps scores until rescored', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'done' })
    s = liveReducer(s, { type: 'round.status', runId: 'r', roundIdx: 2, status: 'preparing' })
    expect(s.agents['a']?.status).toBe('pending')
  })
})

describe('nextDelay', () => {
  test('attempt 0 waits 1s', () => {
    expect(nextDelay(0)).toBe(1000)
  })
  test('attempt 1 waits 2s', () => {
    expect(nextDelay(1)).toBe(2000)
  })
  test('attempt 4 waits 16s', () => {
    expect(nextDelay(4)).toBe(16000)
  })
  test('attempt 5+ caps at 30s', () => {
    expect(nextDelay(5)).toBe(30000)
    expect(nextDelay(100)).toBe(30000)
  })
  test('never returns 0 or negative', () => {
    for (let i = 0; i < 10; i++) {
      expect(nextDelay(i)).toBeGreaterThan(0)
    }
  })
})

test('ws.status updates wsStatus', () => {
  const s = liveReducer(initialLiveState, { type: 'ws.status', status: 'reconnecting' })
  expect(s.wsStatus).toBe('reconnecting')
  const s2 = liveReducer(s, { type: 'ws.status', status: 'connected' })
  expect(s2.wsStatus).toBe('connected')
})

describe('hydrate from snapshot', () => {
  test('fills standings that arrived over HTTP rather than the websocket', () => {
    // Reloading the page or opening an existing run previously showed a grid with
    // no ranks until another round ran, even though the server had every score.
    const s = liveReducer(initialLiveState, {
      type: 'hydrate',
      scores: [
        { agentId: 'b', rank: 2, score: 40 },
        { agentId: 'a', rank: 1, score: 90 },
      ],
      roundIdx: 6,
    })
    expect(s.scores.map((x) => x.agentId)).toEqual(['a', 'b'])
    expect(s.roundIdx).toBe(6)
  })

  test('a later round.scored still wins over hydrated scores', () => {
    let s = liveReducer(initialLiveState, {
      type: 'hydrate',
      scores: [{ agentId: 'a', rank: 1, score: 10 }],
      roundIdx: 1,
    })
    s = liveReducer(s, {
      type: 'round.scored', runId: 'r', roundIdx: 2,
      scores: [{ agentId: 'b', rank: 1, score: 99 }],
    })
    expect(s.scores).toEqual([{ agentId: 'b', rank: 1, score: 99 }])
  })

  test('hydrate leaves agent live state untouched', () => {
    let s = liveReducer(initialLiveState, {
      type: 'agent.status', runId: 'r', agentId: 'a', status: 'running',
    })
    s = liveReducer(s, { type: 'hydrate', scores: [{ agentId: 'a', rank: 1, score: 5 }], roundIdx: 1 })
    expect(s.agents['a']?.status).toBe('running')
  })
})
