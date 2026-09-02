import { describe, expect, test } from 'vitest'
import { parseMemoryLimit, planCapacity } from '../../../src/runtime/docker/capacity.js'

describe('parseMemoryLimit', () => {
  test('parses megabytes and gigabytes', () => {
    expect(parseMemoryLimit('512m')).toBe(512 * 1024 * 1024)
    expect(parseMemoryLimit('1g')).toBe(1024 * 1024 * 1024)
    expect(parseMemoryLimit('2G')).toBe(2 * 1024 * 1024 * 1024)
  })

  test('throws on an unparseable limit', () => {
    expect(() => parseMemoryLimit('lots')).toThrow(/memory/i)
  })
})

describe('planCapacity', () => {
  const host = { totalMemoryBytes: 6.69 * 1024 ** 3, usedMemoryBytes: 1.5 * 1024 ** 3, cpus: 16 }

  test('accepts a plan that fits comfortably', () => {
    const r = planCapacity({ containers: 4, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(true)
  })

  test('rejects a plan that exceeds available memory', () => {
    const r = planCapacity({ containers: 20, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/memory/i)
  })

  test('rejects a plan that oversubscribes CPUs', () => {
    const r = planCapacity({ containers: 4, memory: '256m', cpus: 8 }, host)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cpu/i)
  })

  test('reserves headroom rather than consuming every last byte', () => {
    // 5.19GiB free; 5 x 1g would fit arithmetically but leaves nothing for the host.
    const r = planCapacity({ containers: 5, memory: '1g', cpus: 1 }, host)
    expect(r.ok).toBe(false)
  })

  test('suggests the largest container count that would fit', () => {
    const r = planCapacity({ containers: 20, memory: '1g', cpus: 1 }, host)
    expect(r.suggestedContainers).toBeGreaterThan(0)
    expect(r.suggestedContainers).toBeLessThan(20)
  })
})
