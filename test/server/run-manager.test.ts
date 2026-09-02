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
})
