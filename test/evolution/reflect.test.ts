import { describe, expect, test } from 'vitest'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider, GOOD_KEYWORDS, trueFitness } from '../../src/runtime/mock-provider.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import type { Provider } from '../../src/runtime/provider.js'

const cfg = DEFAULT_CONFIG.reflect
const base = {
  ownStrategy: 'plain',
  ownNotes: '',
  ownRank: 3,
  ownScore: 40,
  ownRationale: 'weak',
  topPerformers: [{ rank: 1, strategy: GOOD_KEYWORDS.join(' '), excerpt: 'x', rationale: 'y' }],
  metaDigest: 'winners verified',
  nextGoal: 'goal',
  goalChanged: false,
}

describe('Reflector', () => {
  test('produces a strategy at least as fit as the original', async () => {
    const r = new Reflector(new MockProvider(1), cfg, ['m'])
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(trueFitness(out.strategyMd)).toBeGreaterThan(trueFitness('plain'))
  })

  test('enforces the strategy character cap', async () => {
    const long: Provider = { complete: async () => JSON.stringify({ strategy_md: 'x'.repeat(5000), notes_md: '' }) }
    const r = new Reflector(long, { ...cfg, strategyCharCap: 100 }, ['m'])
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.strategyMd.length).toBeLessThanOrEqual(100)
  })

  test('caps a long recombined strategy while preserving its notes', async () => {
    const long: Provider = {
      complete: async () => JSON.stringify({ strategy_md: 'x'.repeat(5000), notes_md: 'lineage notes' }),
    }
    const r = new Reflector(long, { ...cfg, strategyCharCap: 100 }, ['m'])

    const out = await r.recombine('parent a', 'parent b', 'goal')
    expect(out.notesMd).toBe('lineage notes')
    expect(out.strategyMd.length).toBeLessThanOrEqual(100)
  })

  test('keeps a short recombined strategy unchanged', async () => {
    const short: Provider = {
      complete: async () => JSON.stringify({ strategy_md: 'combined approach', notes_md: 'lineage notes' }),
    }
    const r = new Reflector(short, { ...cfg, strategyCharCap: 100 }, ['m'])

    await expect(r.recombine('parent a', 'parent b', 'goal')).resolves.toEqual({
      strategyMd: 'combined approach',
      notesMd: 'lineage notes',
    })
  })

  test('leaves failed recombination available for breed fallback handling', async () => {
    const broken: Provider = { complete: async () => { throw new Error('provider unavailable') } }
    const r = new Reflector(broken, cfg, ['m'])

    await expect(r.recombine('parent a', 'parent b', 'goal')).rejects.toThrow('provider unavailable')
  })

  test('clamps temperature into range', async () => {
    const wild: Provider = { complete: async () => JSON.stringify({ strategy_md: 'ok', notes_md: '', temperature: 9 }) }
    const r = new Reflector(wild, cfg, ['m'])
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.temperature).toBeLessThanOrEqual(1)
  })

  test('rejects a model outside the allowed roster', async () => {
    const rogue: Provider = { complete: async () => JSON.stringify({ strategy_md: 'ok', notes_md: '', model_id: 'evil/model' }) }
    const r = new Reflector(rogue, cfg, ['m'])
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.modelId).toBe('m')
  })

  test('accepts a model that is in the roster', async () => {
    const ok: Provider = { complete: async () => JSON.stringify({ strategy_md: 'ok', notes_md: '', model_id: 'm2' }) }
    const r = new Reflector(ok, cfg, ['m', 'm2'])
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.modelId).toBe('m2')
  })

  test('carries the previous genome forward when output is unrecoverable', async () => {
    const broken: Provider = { complete: async () => 'not json at all' }
    const r = new Reflector(broken, cfg, ['m'])
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.strategyMd).toBe('plain')
    expect(out.modelId).toBe('m')
  })
})

describe('Reflector observability', () => {
  test('reports a rejected model instead of dropping it silently', async () => {
    const rejected: { agentModel: string; requested: string }[] = []
    const rogue = { complete: async () => JSON.stringify({ strategy_md: 'ok', notes_md: '', model_id: 'evil/model' }) }
    const r = new Reflector(rogue as never, cfg, ['m'], (e) => rejected.push(e))
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.modelId).toBe('m')
    expect(rejected).toEqual([{ agentModel: 'm', requested: 'evil/model' }])
  })

  test('does not report when the requested model is allowed', async () => {
    const rejected: unknown[] = []
    const ok = { complete: async () => JSON.stringify({ strategy_md: 'ok', notes_md: '', model_id: 'm2' }) }
    const r = new Reflector(ok as never, cfg, ['m', 'm2'], () => rejected.push(1))
    const out = await r.reflect({ ...base, currentModelId: 'm', currentTemperature: 0.7 })
    expect(out.modelId).toBe('m2')
    expect(rejected).toHaveLength(0)
  })
})
