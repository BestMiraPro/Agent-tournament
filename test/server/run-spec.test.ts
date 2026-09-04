import { describe, expect, test } from 'vitest'
import { parseRunSpec } from '../../src/server/run-spec.js'

const base = {
  name: 'demo',
  goal: 'write a haiku',
  sandbox: 'mock',
  roster: [{ modelId: 'mock/model', count: 4, temperature: 0.7 }],
}

describe('parseRunSpec', () => {
  test('accepts a minimal mock spec', () => {
    const s = parseRunSpec(base)
    expect(s.population).toBe(4)
    expect(s.sandbox).toBe('mock')
  })

  test('population is the roster sum', () => {
    const s = parseRunSpec({
      ...base,
      roster: [
        { modelId: 'a/m', count: 3, temperature: 0.7 },
        { modelId: 'b/m', count: 2, temperature: 0.8 },
      ],
    })
    expect(s.population).toBe(5)
  })

  test('rejects an empty roster', () => {
    expect(() => parseRunSpec({ ...base, roster: [] })).toThrow(/roster/i)
  })

  test('rejects a roster entry with count zero', () => {
    expect(() =>
      parseRunSpec({ ...base, roster: [{ modelId: 'a/m', count: 0, temperature: 0.7 }] }),
    ).toThrow(/count/i)
  })

  test('docker requires a workspaceRoot', () => {
    expect(() => parseRunSpec({ ...base, sandbox: 'docker' })).toThrow(/workspaceRoot/i)
  })

  test('docker requires an authFile', () => {
    expect(() =>
      parseRunSpec({ ...base, sandbox: 'docker', workspaceRoot: '/tmp/w' }),
    ).toThrow(/authFile/i)
  })

  test('local requires a workspaceRoot', () => {
    expect(() => parseRunSpec({ ...base, sandbox: 'local' })).toThrow(/workspaceRoot/i)
  })

  test('unknown sandbox is rejected', () => {
    expect(() => parseRunSpec({ ...base, sandbox: 'lxc' })).toThrow(/sandbox/i)
  })

  test('judge and budget fall back to defaults', () => {
    const s = parseRunSpec(base)
    expect(s.judge.modelId).toBeTruthy()
    expect(s.budget.maxAgentTokens).toBeGreaterThan(0)
  })

  test('selection.crossoverPct defaults to 0', () => {
    expect(parseRunSpec(base).selection.crossoverPct).toBe(0)
  })

  test('accepts selection.crossoverPct in range', () => {
    expect(parseRunSpec({ ...base, selection: { crossoverPct: 0.5 } }).selection.crossoverPct).toBe(0.5)
  })

  test('rejects an out-of-range selection.crossoverPct', () => {
    expect(() => parseRunSpec({ ...base, selection: { crossoverPct: 1.5 } })).toThrow()
    expect(() => parseRunSpec({ ...base, selection: { crossoverPct: -0.1 } })).toThrow()
  })

  test('rejects a negative selection.eliteCount', () => {
    expect(() => parseRunSpec({ ...base, selection: { eliteCount: -1 } })).toThrow()
  })

  test('rejects out-of-range selection.topPct', () => {
    expect(() => parseRunSpec({ ...base, selection: { topPct: 1.5 } })).toThrow()
    expect(() => parseRunSpec({ ...base, selection: { topPct: NaN } })).toThrow()
  })

  test('accepts selection.bottomPct of 0 (no-cull A/B)', () => {
    expect(parseRunSpec({ ...base, selection: { bottomPct: 0 } }).selection.bottomPct).toBe(0)
  })

  test('rejects concurrency outside 1..64', () => {
    expect(() => parseRunSpec({ ...base, concurrency: 0 })).toThrow()
    expect(() => parseRunSpec({ ...base, concurrency: 65 })).toThrow()
  })

  test('rejects negative pricing rates', () => {
    expect(() =>
      parseRunSpec({ ...base, pricing: { 'a/m': { inPerM: -1, outPerM: 0 } } }),
    ).toThrow()
  })

  test('eliteCount beyond the top band throws', () => {
    expect(() =>
      parseRunSpec({ ...base, selection: { eliteCount: 5, topPct: 0.2 } }),
    ).toThrow(/top band size/)
  })

  test('eliteCount within the top band passes', () => {
    const s = parseRunSpec({ ...base, selection: { eliteCount: 1, topPct: 0.2 } })
    expect(s.selection.eliteCount).toBe(1)
  })

  test('criteria round-trips through the return', () => {
    expect(parseRunSpec({ ...base, criteria: '## C' }).criteria).toBe('## C')
    expect(parseRunSpec(base).criteria).toBeNull()
  })
})
