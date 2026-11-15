import { describe, expect, test } from 'vitest'
import type { ActivityItemInput, EngineEvent } from '../../src/engine/events.js'
import { ActivityCache, DEFAULT_ACTIVITY_LIMITS } from '../../src/server/activity.js'

const activity = (agentId: string, item: Partial<ActivityItemInput> & { id: string }): EngineEvent => ({
  type: 'agent.activity', runId: 'r', agentId, kind: item.kind ?? 'tool', detail: item.summary ?? '',
  item: { sessionId: 'ses_a', kind: 'tool', summary: 'bash: node backtest.mjs', observedAt: 1_000, ...item },
})
const preparing = (roundIdx = 1): EngineEvent => ({ type: 'round.status', runId: 'r', roundIdx, status: 'preparing' })

describe('ActivityCache', () => {
  test('uses the plan limits by default', () => {
    expect(DEFAULT_ACTIVITY_LIMITS).toEqual({
      maxItemsPerAgent: 100, maxItemBytes: 8 * 1024, maxAgentBytes: 256 * 1024, maxRunBytes: 4 * 1024 * 1024,
    })
  })

  test('a tool call updates in place from running to completed, stamped with round and revision', () => {
    const cache = new ActivityCache()
    cache.record(preparing(3))
    const running = cache.record(activity('a', { id: 'call_1', status: 'running' }))
    const done = cache.record(activity('a', { id: 'call_1', status: 'completed', output: 'sharpe=1.41\n', observedAt: 2_000 }))
    expect(running?.type === 'agent.activity' && running.item).toMatchObject({ id: 'call_1', status: 'running', roundIdx: 3, agentId: 'a', runId: 'r' })
    const items = cache.snapshot().agents.a!.items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'completed', output: 'sharpe=1.41\n', observedAt: 2_000 })
    expect(done?.type === 'agent.activity' && done.item!.revision).toBeGreaterThan(running?.type === 'agent.activity' ? running.item!.revision! : 0)
    expect(cache.snapshot().agents.a!.lastObservedAt).toBe(2_000)
  })

  test('text deltas append once and a full part update reconciles without duplicating', () => {
    const cache = new ActivityCache()
    cache.record(activity('a', { id: 'prt_text', kind: 'text', summary: 'Planning the backtest' }))
    const appended = cache.record(activity('a', { id: 'prt_text', kind: 'text', summary: ' next', append: true }))
    expect(cache.snapshot().agents.a!.items[0]!.summary).toBe('Planning the backtest next')
    // The broadcast carries the reconciled item, never the raw fragment.
    expect(appended?.type === 'agent.activity' && appended.item!.summary).toBe('Planning the backtest next')
    cache.record(activity('a', { id: 'prt_text', kind: 'text', summary: 'Planning the backtest next steps' }))
    expect(cache.snapshot().agents.a!.items.map((i) => i.summary)).toEqual(['Planning the backtest next steps'])
  })

  test('a delta for a part it never saw is dropped, so reasoning streams never surface', () => {
    const cache = new ActivityCache()
    expect(cache.record(activity('a', { id: 'prt_reason', kind: 'text', summary: 'private thought', append: true }))).toBeNull()
    expect(cache.snapshot().agents.a?.items ?? []).toEqual([])
  })

  test('events from a session the agent no longer runs are ignored', () => {
    const current: Record<string, string> = { a: 'ses_new' }
    const cache = new ActivityCache({ currentSession: (agentId) => current[agentId] ?? null })
    expect(cache.record(activity('a', { id: 'call_old', sessionId: 'ses_old' }))).toBeNull()
    expect(cache.record(activity('a', { id: 'call_new', sessionId: 'ses_new' }))).not.toBeNull()
    expect(cache.snapshot().agents.a!.items.map((i) => i.id)).toEqual(['call_new'])
  })

  test('a new round starts with no carried-over activity', () => {
    const cache = new ActivityCache()
    cache.record(preparing(1))
    cache.record(activity('a', { id: 'call_1' }))
    cache.record(preparing(2))
    expect(cache.snapshot().agents).toEqual({})
    expect(cache.snapshot().roundIdx).toBe(2)
  })

  test('large output is capped and marked truncated', () => {
    const cache = new ActivityCache({ limits: { maxItemBytes: 100 } })
    cache.record(activity('a', { id: 'call_1', status: 'completed', summary: 'bash: cat big.log', output: 'x'.repeat(5_000) }))
    const item = cache.snapshot().agents.a!.items[0]!
    expect(Buffer.byteLength(item.summary) + Buffer.byteLength(item.output ?? '')).toBeLessThanOrEqual(100)
    expect(item.truncated).toBe(true)
    expect(item.summary).toBe('bash: cat big.log')
  })

  test('per-agent item and byte limits evict the oldest details and say so', () => {
    const cache = new ActivityCache({ limits: { maxItemsPerAgent: 3, maxAgentBytes: 1_000 } })
    for (let i = 0; i < 5; i++) cache.record(activity('a', { id: `call_${i}`, summary: `step ${i}` }))
    expect(cache.snapshot().agents.a!.items.map((i) => i.id)).toEqual(['call_2', 'call_3', 'call_4'])
    expect(cache.snapshot().agents.a!.truncated).toBe(true)

    const bytes = new ActivityCache({ limits: { maxAgentBytes: 250, maxItemBytes: 200 } })
    for (let i = 0; i < 4; i++) bytes.record(activity('b', { id: `c${i}`, summary: 'y'.repeat(100) }))
    const kept = bytes.snapshot().agents.b!
    expect(kept.items.reduce((n, i) => n + Buffer.byteLength(i.summary), 0)).toBeLessThanOrEqual(250)
    expect(kept.items.at(-1)!.id).toBe('c3')
    expect(kept.truncated).toBe(true)
  })

  test('the run-wide byte limit evicts the oldest details across agents', () => {
    const cache = new ActivityCache({ limits: { maxRunBytes: 300, maxItemBytes: 200 } })
    cache.record(activity('a', { id: 'a1', summary: 'a'.repeat(120), observedAt: 1 }))
    cache.record(activity('b', { id: 'b1', summary: 'b'.repeat(120), observedAt: 2 }))
    cache.record(activity('c', { id: 'c1', summary: 'c'.repeat(120), observedAt: 3 }))
    const snap = cache.snapshot()
    const total = Object.values(snap.agents).flatMap((a) => a.items).reduce((n, i) => n + Buffer.byteLength(i.summary), 0)
    expect(total).toBeLessThanOrEqual(300)
    expect(snap.agents.a?.items ?? []).toEqual([])
    expect(snap.agents.c!.items[0]!.id).toBe('c1')
  })

  test('permission requests become waiting items that resolve in place', () => {
    const cache = new ActivityCache()
    cache.record({ type: 'agent.permission', runId: 'r', agentId: 'a', requestId: 'per_1', state: 'asked', permission: 'external_directory', patterns: ['/tmp/*'], at: 5 })
    expect(cache.snapshot().agents.a!.items[0]).toMatchObject({ id: 'per_1', kind: 'permission', status: 'waiting', summary: 'Permission external_directory /tmp/*' })
    cache.record({ type: 'agent.permission', runId: 'r', agentId: 'a', requestId: 'per_1', state: 'replied', reply: 'reject', at: 6 })
    expect(cache.snapshot().agents.a!.items).toHaveLength(1)
    expect(cache.snapshot().agents.a!.items[0]).toMatchObject({ status: 'completed', summary: 'Permission external_directory /tmp/* — rejected' })
  })

  test('the snapshot carries agent status, failure, usage availability and stream health', () => {
    const cache = new ActivityCache()
    cache.record({ type: 'agent.status', runId: 'r', agentId: 'a', status: 'failed', failure: { message: 'Transport failure: socket hang up (ECONNRESET)', code: 'ECONNRESET' } })
    cache.record({ type: 'agent.usage', runId: 'r', agentId: 'b', tokensIn: 1, tokensOut: 2, costUsd: 0 })
    cache.record({ type: 'bridge.status', runId: 'r', source: 'shard-0', state: 'reconnecting', message: 'refused: 401', at: 9 })
    const snap = cache.snapshot()
    expect(snap.agents.a).toMatchObject({ status: 'failed', failure: { code: 'ECONNRESET' }, usageReported: false })
    expect(snap.agents.b).toMatchObject({ usageReported: true })
    expect(snap.streams['shard-0']).toEqual({ state: 'reconnecting', message: 'refused: 401', at: 9 })
    expect(snap.revision).toBeGreaterThan(0)
  })

  test('other events pass through untouched, and clear releases everything', () => {
    const cache = new ActivityCache()
    const scored: EngineEvent = { type: 'round.scored', runId: 'r', roundIdx: 1, scores: [] }
    expect(cache.record(scored)).toBe(scored)
    cache.record(activity('a', { id: 'call_1' }))
    cache.clear()
    expect(cache.snapshot().agents).toEqual({})
  })
})
