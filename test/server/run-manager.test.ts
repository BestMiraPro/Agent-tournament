import { describe, expect, test, vi } from 'vitest'
import { RunManager } from '../../src/server/run-manager.js'
import type { EngineEvent } from '../../src/engine/events.js'

const fakeEngine = (opts: { fail?: boolean; delayMs?: number } = {}) => {
  const calls: { runId: string; goalMd: string }[] = []
  return {
    calls,
    engine: {
      createRun: (name: string) => ({ id: `run-${name}` }),
      runRound: async (runId: string, input: { goalMd: string }) => {
        calls.push({ runId, goalMd: input.goalMd })
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (opts.fail) throw new Error('round exploded')
        return { roundId: 'rd', roundIdx: calls.length, metaDigest: '', budgetBreach: null }
      },
      dispose: vi.fn(async () => {}),
    },
  }
}

describe('RunManager', () => {
  test('startRound returns immediately and runs in the background', async () => {
    const { engine, calls } = fakeEngine({ delayMs: 50 })
    const m = new RunManager(engine as never, () => {})
    const t0 = Date.now()
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    expect(Date.now() - t0).toBeLessThan(30)
    await m.waitForIdle('r1')
    expect(calls).toHaveLength(1)
  })

  test('reports a round as busy while it runs', async () => {
    const { engine } = fakeEngine({ delayMs: 50 })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    expect(m.isBusy('r1')).toBe(true)
    await m.waitForIdle('r1')
    expect(m.isBusy('r1')).toBe(false)
  })

  test('refuses to start a second round while one is running', async () => {
    const { engine, calls } = fakeEngine({ delayMs: 50 })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    expect(() => m.startRound('r1', { goalMd: 'g2', criteriaMd: null })).toThrow(/already running/i)
    await m.waitForIdle('r1')
    expect(calls).toHaveLength(1)
  })

  test('allows concurrent rounds for different runs', async () => {
    const { engine, calls } = fakeEngine({ delayMs: 30 })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    m.startRound('r2', { goalMd: 'g', criteriaMd: null })
    await Promise.all([m.waitForIdle('r1'), m.waitForIdle('r2')])
    expect(calls).toHaveLength(2)
  })

  test('a failing round emits an error event and leaves the run idle', async () => {
    const seen: EngineEvent[] = []
    const { engine } = fakeEngine({ fail: true })
    const m = new RunManager(engine as never, (e) => seen.push(e))
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    await m.waitForIdle('r1')
    expect(m.isBusy('r1')).toBe(false)
    expect(seen.some((e) => e.type === 'round.complete')).toBe(true)
  })

  test('lastError records why a round failed', async () => {
    const { engine } = fakeEngine({ fail: true })
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })
    await m.waitForIdle('r1')
    expect(m.lastError('r1')).toMatch(/exploded/)
  })

  test('disposeAll prevents a new round from starting while teardown waits', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const engine = {
      runRound: async () => {
        await gate
        return { roundId: 'rd', roundIdx: 1, metaDigest: '', budgetBreach: null }
      },
      dispose: vi.fn(async () => {}),
    }
    const m = new RunManager(engine as never, () => {})
    m.startRound('r1', { goalMd: 'g', criteriaMd: null })

    const disposal = m.disposeAll()
    expect(() => m.startRound('r2', { goalMd: 'g', criteriaMd: null })).toThrow(/dispos/)
    release()
    await disposal
    expect(engine.dispose).toHaveBeenCalledWith('r1')
  })

  test('disposeAll releases runs whose rounds already finished', async () => {
    // inFlight is cleared the moment a round settles, so iterating only that map means
    // a run that completed normally never reaches engine.dispose and its sandbox
    // (with Docker, its containers) outlives the process's shutdown.
    const engine = {
      runRound: async () => ({ roundId: 'rd', roundIdx: 1, metaDigest: '', budgetBreach: null }),
      dispose: vi.fn(async () => {}),
    }
    const m = new RunManager(engine as never, () => {})
    m.startRound('finished', { goalMd: 'g', criteriaMd: null })
    await m.waitForIdle('finished')
    expect(m.isBusy('finished')).toBe(false)

    await m.disposeAll()
    expect(engine.dispose).toHaveBeenCalledWith('finished')
  })

  test('disposeAll releases each run once however often it ran or is called', async () => {
    const engine = {
      runRound: async () => ({ roundId: 'rd', roundIdx: 1, metaDigest: '', budgetBreach: null }),
      dispose: vi.fn(async () => {}),
    }
    const m = new RunManager(engine as never, () => {})
    for (const _ of [0, 1, 2]) {
      m.startRound('repeat', { goalMd: 'g', criteriaMd: null })
      await m.waitForIdle('repeat')
    }
    await m.disposeAll()
    await m.disposeAll()
    expect(engine.dispose.mock.calls).toEqual([['repeat']])
  })
})

test('an arbitrary round failure is reported as a run error, not as a budget breach', async () => {
  // Any failure used to be sent as `budgetBreach`, so the dashboard labelled a crashed
  // planner or a provider outage as "Budget: ...".
  const { engine } = fakeEngine({ fail: true })
  const events: EngineEvent[] = []
  const m = new RunManager(engine as never, (e) => events.push(e))
  m.startRound('r1', { goalMd: 'g', criteriaMd: null })
  await m.waitForIdle('r1')
  const complete = events.find((e) => e.type === 'round.complete') as Extract<EngineEvent, { type: 'round.complete' }>
  expect(complete.budgetBreach).toBeNull()
  expect(complete.error).toBe('round exploded')
})
