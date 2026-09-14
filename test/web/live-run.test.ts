import { describe, expect, test } from 'vitest'
import { applyLiveEvent, createLiveSession, liveReducer, initialLiveState } from '../../web/src/useLiveRun.js'
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

  test('usage is the terminal total, set rather than summed, and marks usage as reported', () => {
    // The engine reports one terminal total per agent. Summing would count it twice the
    // moment any other source also reported usage for the same agent.
    let s = liveReducer(initialLiveState, { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 10, tokensOut: 5, costUsd: 0.1 })
    expect(s.agents['a']?.usageReported).toBe(true)
    s = liveReducer(s, { type: 'agent.usage', runId: 'r', agentId: 'a', tokensIn: 20, tokensOut: 5, costUsd: 0.2 })
    expect(s.agents['a']?.tokensIn).toBe(20)
    expect(s.agents['a']?.costUsd).toBeCloseTo(0.2)
  })

  test('an agent with no usage report is not presented as having used zero', () => {
    const s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'running' })
    expect(s.agents['a']?.usageReported).toBe(false)
  })

  test('a failed agent keeps its failure, and a new attempt clears it', () => {
    const failure = { message: 'OpenCode returned HTTP 500 UnknownError (ref err_0672e772)', httpStatus: 500, code: 'UnknownError', ref: 'err_0672e772' }
    let s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'failed', roundIdx: 1, failure })
    expect(s.agents['a']?.failure).toEqual(failure)
    s = liveReducer(s, { type: 'round.status', runId: 'r', roundIdx: 2, status: 'preparing' })
    expect(s.agents['a']?.failure).toBeNull()
    expect(s.agents['a']?.usageReported).toBe(false)
  })

  test('a round that failed outright is a run error, not a budget breach', () => {
    const s = liveReducer(initialLiveState, {
      type: 'round.complete', runId: 'r', roundIdx: -1, budgetBreach: null, error: 'planner exploded',
    })
    expect(s.lastBreach).toBeNull()
    expect(s.lastError).toBe('planner exploded')
    const next = liveReducer(s, { type: 'round.status', runId: 'r', roundIdx: 2, status: 'preparing' })
    expect(next.lastError).toBeNull()
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

describe('permission waits', () => {
  const asked = {
    type: 'agent.permission', runId: 'r', agentId: 'a', requestId: 'per_1', state: 'asked',
    permission: 'external_directory', patterns: ['/tmp/*'], at: 5_000,
  }

  test('an asked permission shows the agent waiting, from when it was asked', () => {
    let s = liveReducer(initialLiveState, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'running' })
    s = liveReducer(s, asked)
    expect(s.agents.a!.status).toBe('running')
    expect(s.agents.a!.permission).toEqual({ requestId: 'per_1', permission: 'external_directory', patterns: ['/tmp/*'], since: 5_000 })
  })

  test('a reply to that request ends the wait and says how it was answered', () => {
    let s = liveReducer(initialLiveState, asked)
    s = liveReducer(s, { type: 'agent.permission', runId: 'r', agentId: 'a', requestId: 'per_other', state: 'replied', reply: 'once', at: 6_000 })
    expect(s.agents.a!.permission?.requestId).toBe('per_1')
    s = liveReducer(s, { type: 'agent.permission', runId: 'r', agentId: 'a', requestId: 'per_1', state: 'replied', reply: 'reject', at: 7_000 })
    expect(s.agents.a!.permission).toBeNull()
    expect(s.agents.a!.activity).toBe('Permission rejected: external_directory')
  })

  test('an ended attempt or a new round is not left waiting', () => {
    let s = liveReducer(initialLiveState, asked)
    s = liveReducer(s, { type: 'agent.status', runId: 'r', agentId: 'a', status: 'failed' })
    expect(s.agents.a!.permission).toBeNull()
    s = liveReducer(liveReducer(initialLiveState, asked), { type: 'round.status', runId: 'r', roundIdx: 2, status: 'preparing' })
    expect(s.agents.a?.permission ?? null).toBeNull()
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

describe('scoped live session', () => {
  test('ignores events from another run before reducing them', () => {
    const session = createLiveSession('chosen', { ...initialLiveState, scores: [] })
    session.event({ type: 'round.status', runId: 'other', roundIdx: 9, status: 'running' })
    expect(session.state).toEqual({ ...initialLiveState, scores: [] })
  })

  test('switching to an unscored run clears the prior run state', () => {
    const session = createLiveSession('old', { ...initialLiveState, scores: [{ agentId: 'a', rank: 1, score: 4 }], busy: true })
    session.switchRun('fresh')
    expect(session.state.scores).toEqual([])
    expect(session.state.busy).toBe(false)
  })

  test('a completion event prevents an older in-flight fetch from restoring busy', () => {
    const session = createLiveSession('r', { ...initialLiveState, busy: true, roundIdx: 1 })
    const request = session.beginRefresh()
    session.event({ type: 'round.complete', runId: 'r', roundIdx: 1, budgetBreach: null })
    session.snapshot({ ...initialLiveState, busy: true, roundIdx: 1 }, request)
    expect(session.state.busy).toBe(false)
  })

  test('ignores an old-run fetch after switching runs', () => {
    const session = createLiveSession('old', initialLiveState)
    const request = session.beginRefresh()
    session.switchRun('new')
    session.snapshot({ ...initialLiveState, busy: true }, request)
    expect(session.state.busy).toBe(false)
  })

  test('uses the active live round for actions while the snapshot still says zero', () => {
    const s = applyLiveEvent({ ...initialLiveState, roundIdx: 0 }, 'r', { type: 'round.status', runId: 'r', roundIdx: 1, status: 'running' })
    expect(s.roundIdx).toBe(1)
  })
})
