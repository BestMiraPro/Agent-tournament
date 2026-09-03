import { describe, expect, test } from 'vitest'
import { liveReducer, initialLiveState } from '../../web/src/useLiveRun.js'

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
