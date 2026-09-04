import { describe, expect, test } from 'vitest'
import { runPool } from '../../src/runtime/pool.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('runPool', () => {
  test('returns results in input order', async () => {
    const out = await runPool([3, 1, 2], 2, async (n) => {
      await sleep(n * 5)
      return n * 10
    })
    expect(out.map((r) => (r.ok ? r.value : null))).toEqual([30, 10, 20])
  })

  test('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(10)
      active--
      return 1
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('isolates failures without rejecting the pool', async () => {
    const out = await runPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(out[0]).toEqual({ ok: true, value: 1 })
    expect(out[1]!.ok).toBe(false)
    expect(out[2]).toEqual({ ok: true, value: 3 })
  })

  test('handles an empty input', async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([])
  })

  test('shouldStop aborts queued items while the in-flight one completes', async () => {
    let stop = false
    const started: number[] = []
    const out = await runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n)
        if (n === 1) {
          stop = true
          await sleep(20)
        }
        return n
      },
      { shouldStop: () => stop },
    )
    expect(out[0]).toEqual({ ok: true, value: 1 })
    expect(started).toEqual([1])
    for (const r of out.slice(1)) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toBe('round aborted')
    }
  })
})
