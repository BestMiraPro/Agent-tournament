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
})
