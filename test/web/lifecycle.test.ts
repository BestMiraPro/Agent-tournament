import { describe, expect, test } from 'vitest'
import { createSelectionGuard, createStartGate, isCurrentRunRequest, shouldHydrateCriteria } from '../../web/src/lib/lifecycle.js'
import { createLiveSession, initialLiveState } from '../../web/src/useLiveRun.js'

describe('production lifecycle seams', () => {
  test('a pending start synchronously admits one POST only', () => {
    const gate = createStartGate()
    expect(gate.tryStart()).toBe(true)
    expect(gate.tryStart()).toBe(false)
    gate.finish()
    expect(gate.tryStart()).toBe(true)
  })

  test('a late old socket refresh cannot hydrate after a run switch', () => {
    const session = createLiveSession('old', initialLiveState)
    const request = session.beginRefresh('old')
    session.switchRun('new')
    session.snapshot({ ...initialLiveState, busy: true }, request)
    expect(session.state.busy).toBe(false)
  })

  test('only the latest same-run refresh can apply', () => {
    const session = createLiveSession('run', initialLiveState)
    const old = session.beginRefresh('run')
    const fresh = session.beginRefresh('run')
    session.snapshot({ ...initialLiveState, busy: true }, old)
    session.snapshot({ ...initialLiveState, roundIdx: 2 }, fresh)
    expect(session.state).toMatchObject({ busy: false, roundIdx: 2 })
  })

  test('switching rejudge selection makes the old completion inert and the new selection usable', () => {
    const guard = createSelectionGuard()
    const old = guard.begin('r:1')
    guard.select('r:2')
    expect(guard.current('r:1', old)).toBe(false)
    const next = guard.begin('r:2')
    expect(guard.current('r:2', next)).toBe(true)
  })

  test('a dirty criteria draft rejects a same-run server prefill while a pristine field accepts it', () => {
    expect(shouldHydrateCriteria(false)).toBe(true)
    expect(shouldHydrateCriteria(true)).toBe(false)
  })

  test('a delayed created-run read cannot reopen the run after Browse invalidates navigation', () => {
    const initialNavigation = 4
    const browseNavigation = 5
    expect(isCurrentRunRequest(null, 'created', browseNavigation, initialNavigation)).toBe(false)
  })
})
