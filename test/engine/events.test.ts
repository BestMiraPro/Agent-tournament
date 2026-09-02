import { describe, expect, test } from 'vitest'
import { collectEvents, type EngineEvent } from '../../src/engine/events.js'

describe('collectEvents', () => {
  test('captures events in order', () => {
    const { sink, events } = collectEvents()
    sink({ type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' })
    sink({ type: 'agent.status', runId: 'r', agentId: 'a', status: 'running' })
    expect(events.map((e) => e.type)).toEqual(['round.status', 'agent.status'])
  })

  test('a sink that throws never breaks the caller', () => {
    const bad = () => {
      throw new Error('subscriber exploded')
    }
    const { safe } = collectEvents()
    expect(() => safe(bad)({ type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' }))
      .not.toThrow()
  })

  test('every event carries a runId', () => {
    const samples: EngineEvent[] = [
      { type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' },
      { type: 'agent.status', runId: 'r', agentId: 'a', status: 'done' },
      { type: 'agent.session', runId: 'r', agentId: 'a', sessionId: 's' },
      { type: 'agent.activity', runId: 'r', agentId: 'a', kind: 'tool', detail: 'bash' },
      { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 1, tokensOut: 2, costUsd: 0 },
      { type: 'round.scored', runId: 'r', roundIdx: 1, scores: [] },
      { type: 'round.complete', runId: 'r', roundIdx: 1, budgetBreach: null },
    ]
    for (const s of samples) expect(s.runId).toBe('r')
  })
})
