import { describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { runConfigFor } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const base = {
  name: 'demo',
  goal: 'write a haiku',
  sandbox: 'mock',
  roster: [{ modelId: 'mock/model', count: 4, temperature: 0.7 }],
}

describe('contextDir', () => {
  test('defaults to null and blank means none', () => {
    expect(parseRunSpec(base).contextDir).toBeNull()
    expect(parseRunSpec({ ...base, contextDir: '   ' }).contextDir).toBeNull()
  })

  test('must be absolute', () => {
    expect(() => parseRunSpec({ ...base, contextDir: 'research' })).toThrow(/contextDir must be an absolute path/)
  })

  test('lands in the run config', () => {
    const dir = process.platform === 'win32' ? 'C:\\ctx' : '/ctx'
    expect(runConfigFor(parseRunSpec({ ...base, contextDir: dir })).contextDir).toBe(dir)
    expect(runConfigFor(parseRunSpec(base)).contextDir).toBeNull()
  })
})

describe('isolation', () => {
  const abs = process.platform === 'win32' ? 'C:\\ws' : '/ws'
  const docker = (count: number, extra: Record<string, unknown> = {}) => ({
    ...base, sandbox: 'docker', workspaceRoot: abs, authFile: `${abs}/auth.json`,
    roster: [{ modelId: 'w/m', count, temperature: 0.7 }], ...extra,
  })

  test('docker runs default to protected, one agent per container; other sandboxes to shared', () => {
    expect(parseRunSpec(docker(2, { maxContainers: 2 })).isolation).toBe('protected')
    expect(parseRunSpec(base).isolation).toBe('shared')
  })

  test('protected isolation refuses more agents than containers, with things to change', () => {
    expect(() => parseRunSpec(docker(7, { maxContainers: 4 }))).toThrow(
      /Protected isolation needs one container per agent: 7 agents but 4 containers\. Raise Containers to 7, lower the agent count to 4, or choose shared isolation/,
    )
  })

  test('shared isolation is an explicit choice that accepts co-tenants', () => {
    const s = parseRunSpec(docker(7, { maxContainers: 4, isolation: 'shared' }))
    expect(s.isolation).toBe('shared')
    expect(runConfigFor(s).isolation).toBe('shared')
    expect(runConfigFor(parseRunSpec(docker(2, { maxContainers: 2 }))).isolation).toBe('protected')
  })
})

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

  test('relative workspaceRoot is rejected, absolute passes', () => {
    expect(() => parseRunSpec({ ...base, workspaceRoot: '../../evil' })).toThrow(/absolute path/)
    expect(parseRunSpec({ ...base, workspaceRoot: '/tmp/w' }).workspaceRoot).toBe('/tmp/w')
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
      parseRunSpec({ ...base, pricing: { 'a/m': { inPerM: -1, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 } } }),
    ).toThrow()
  })

  test('accepts full 4-key pricing entries (nothing stripped)', () => {
    const s = parseRunSpec({
      ...base, pricing: { 'a/m': { inPerM: 1, outPerM: 2, cacheReadPerM: 3, cacheWritePerM: 4 } },
    })
    expect(s.pricing['a/m']).toEqual({ inPerM: 1, outPerM: 2, cacheReadPerM: 3, cacheWritePerM: 4 })
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

/**
 * The capacity preflight refuses a docker run with "Reduce maxContainers to N, lower
 * containerMemory ..." — but neither was part of the run spec, so a run created from the
 * dashboard could act on none of that advice. On a machine whose Docker memory is shared
 * with other projects, every docker run was refused with no way through from the app.
 */
describe('parseRunSpec container sizing', () => {
  test('defaults to the engine config when omitted', () => {
    const s = parseRunSpec(base)
    expect(s.maxContainers).toBe(DEFAULT_CONFIG.maxContainers)
    expect(s.containerMemory).toBe(DEFAULT_CONFIG.containerMemory)
    expect(s.containerCpus).toBe(DEFAULT_CONFIG.containerCpus)
  })

  test('accepts a smaller footprint for a constrained host', () => {
    const s = parseRunSpec({ ...base, maxContainers: 2, containerMemory: '512m', containerCpus: 0.5 })
    expect(s.maxContainers).toBe(2)
    expect(s.containerMemory).toBe('512m')
    expect(s.containerCpus).toBe(0.5)
  })

  test('the values reach the run config the preflight checks', () => {
    const config = runConfigFor(parseRunSpec({
      ...base, maxContainers: 2, containerMemory: '768m', containerCpus: 2,
    }))
    expect(config.maxContainers).toBe(2)
    expect(config.containerMemory).toBe('768m')
    expect(config.containerCpus).toBe(2)
  })

  test.each([[0], [65], [1.5]])('rejects maxContainers %j', (maxContainers) => {
    expect(() => parseRunSpec({ ...base, maxContainers })).toThrow(/maxContainers/)
  })

  test.each([['lots'], ['1gib'], ['-1g'], ['']])('rejects unparseable containerMemory %j', (containerMemory) => {
    expect(() => parseRunSpec({ ...base, containerMemory })).toThrow(/containerMemory/)
  })

  test.each([['512k'], ['256m'], ['384m']])('rejects containerMemory %j, below what an agent container needs', (containerMemory) => {
    // An idle agent container measured 250-267 MiB before doing any work, so 256m would
    // be at its ceiling on arrival, and "512k" meant as megabytes far below it. Each of
    // those kills would be recorded against the agent rather than the setting.
    expect(() => parseRunSpec({ ...base, containerMemory })).toThrow(/at least 512m/)
  })

  test('accepts exactly the floor', () => {
    expect(parseRunSpec({ ...base, containerMemory: '512m' }).containerMemory).toBe('512m')
  })

  test.each([[0], [-1], [65]])('rejects containerCpus %j', (containerCpus) => {
    expect(() => parseRunSpec({ ...base, containerCpus })).toThrow(/containerCpus/)
  })
})
