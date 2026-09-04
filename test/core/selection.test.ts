import { describe, expect, test } from 'vitest'
import { planSelection } from '../../src/core/selection.js'
import type { RankedAgent } from '../../src/core/selection.js'

const ranked = (n: number): RankedAgent[] =>
  Array.from({ length: n }, (_, i) => ({
    agentId: `a${i + 1}`,
    rank: i + 1,
    score: 100 - i,
  }))

const cfg = { eliteCount: 1, topPct: 0.2, bottomPct: 0.2, crossoverPct: 0, diversityFloor: false }

describe('planSelection', () => {
  test('population size is invariant', () => {
    const p = planSelection(ranked(20), cfg)
    expect(p.elite.length + p.survivors.length + p.clones.length).toBe(20)
  })

  test('clone count always equals cull count, even at asymmetric ratios', () => {
    const asym = { ...cfg, topPct: 0.3, bottomPct: 0.1 }
    const p = planSelection(ranked(20), asym)
    expect(p.clones.length).toBe(p.culled.length)
    expect(p.elite.length + p.survivors.length + p.clones.length).toBe(20)
  })

  test('rank 1 is elite', () => {
    expect(planSelection(ranked(20), cfg).elite).toEqual(['a1'])
  })

  test('elite is excluded from survivors (no double counting)', () => {
    const p = planSelection(ranked(20), cfg)
    expect(p.survivors).not.toContain('a1')
  })

  test('the worst agents are the culled ones', () => {
    expect(planSelection(ranked(20), cfg).culled).toEqual(['a17', 'a18', 'a19', 'a20'])
  })

  test('clone parents are drawn only from the top band', () => {
    const p = planSelection(ranked(20), cfg)
    const top = new Set(['a1', 'a2', 'a3', 'a4'])
    for (const c of p.clones) expect(top.has(c.parentAgentId)).toBe(true)
  })

  test('clone parents are assigned round-robin', () => {
    const p = planSelection(ranked(20), cfg)
    expect(p.clones.map((c) => c.parentAgentId)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  test('every culled agent is replaced exactly once', () => {
    const p = planSelection(ranked(20), cfg)
    expect(p.clones.map((c) => c.replacesAgentId).sort()).toEqual([...p.culled].sort())
  })

  test('bands partition the population with no overlap', () => {
    const p = planSelection(ranked(20), cfg)
    const all = [...p.elite, ...p.survivors, ...p.culled]
    expect(new Set(all).size).toBe(20)
  })

  test('handles a tiny population without culling everyone', () => {
    const p = planSelection(ranked(3), cfg)
    expect(p.elite.length + p.survivors.length + p.clones.length).toBe(3)
    expect(p.elite).toEqual(['a1'])
  })

  test('never culls the elite even if bottomPct is extreme', () => {
    const p = planSelection(ranked(4), { ...cfg, bottomPct: 0.99 })
    expect(p.culled).not.toContain('a1')
    expect(p.elite).toEqual(['a1'])
  })

  test('throws when eliteCount exceeds the top band', () => {
    expect(() => planSelection(ranked(20), { ...cfg, eliteCount: 10, topPct: 0.1 }))
      .toThrow(/eliteCount/i)
  })

  test('clone parents cycle when there are more culled than top-band parents', () => {
    const p = planSelection(ranked(20), { ...cfg, topPct: 0.1, bottomPct: 0.8 })
    expect(p.clones.map((c) => c.parentAgentId).slice(0, 4)).toEqual(['a1', 'a2', 'a1', 'a2'])
    expect(p.clones.length).toBe(16)
  })

  test('returns an empty plan for an empty population', () => {
    const p = planSelection([], cfg)
    expect(p).toEqual({ elite: [], survivors: [], culled: [], clones: [], crossovers: [], rescued: [] })
  })

  test('throws when eliteCount is negative', () => {
    expect(() => planSelection(ranked(20), { ...cfg, eliteCount: -1 })).toThrow(/eliteCount/i)
  })

  test('throws when topPct is NaN', () => {
    expect(() => planSelection(ranked(20), { ...cfg, topPct: NaN })).toThrow(/topPct|finite/i)
  })
})

describe('planSelection diversityFloor', () => {
  // n=10, elite 1, top band 2 (a1-a2), 3 culled (a8-a10), survivors a2-a7.
  const floorCfg = { eliteCount: 1, topPct: 0.2, bottomPct: 0.3, crossoverPct: 0, diversityFloor: true }
  const offCfg = { ...floorCfg, diversityFloor: false }
  const shared = 'alpha beta gamma delta'
  const odd = 'zebra quasar xenon fjord'
  const texts = (overrides: Record<string, string> = {}): Map<string, string> => {
    const m = new Map<string, string>()
    for (let i = 1; i <= 10; i++) m.set(`a${i}`, shared)
    for (const [id, text] of Object.entries(overrides)) m.set(id, text)
    return m
  }

  test('off ignores strategies entirely: rescued is empty, bands byte-identical', () => {
    const plain = planSelection(ranked(10), offCfg)
    const withTexts = planSelection(ranked(10), offCfg, texts({ a10: odd }))
    expect(withTexts).toEqual(plain)
    expect(plain.rescued).toEqual([])
    expect(plain.culled).toEqual(['a8', 'a9', 'a10'])
  })

  test('on rescues the most-distinct culled agent and bumps the lowest survivor', () => {
    const p = planSelection(ranked(10), floorCfg, texts({ a10: odd }))
    expect(p.rescued).toEqual(['a10'])
    expect(p.survivors).toContain('a10')
    expect(p.survivors).not.toContain('a7')
    expect(p.culled).toContain('a7')
    expect(p.culled).not.toContain('a10')
    // Totals unchanged: population invariant holds.
    expect(p.elite.length + p.survivors.length + p.clones.length + p.crossovers.length).toBe(10)
    expect(p.clones.length + p.crossovers.length).toBe(p.culled.length)
  })

  test('clones and crossovers derive from the final culled set after the swap', () => {
    const p = planSelection(ranked(10), { ...floorCfg, crossoverPct: 0.5 }, texts({ a10: odd }))
    expect(p.rescued).toEqual(['a10'])
    // Final culled is [a8, a9, a7]: first slot crosses, rest clone — the bumped
    // lowest-survivor is replaced, the rescued agent is not.
    expect(p.crossovers.map((x) => x.replacesAgentId)).toEqual(['a8'])
    expect(p.clones.map((c) => c.replacesAgentId).sort()).toEqual(['a7', 'a9'])
  })

  test('all-identical strategies tie → deterministic first-max rescue', () => {
    const p = planSelection(ranked(10), floorCfg, texts())
    expect(p.rescued).toEqual(['a8'])
    expect(p.culled).toContain('a7')
  })

  test('a most-distinct elite is kept: rescue happens among the culled only', () => {
    const p = planSelection(ranked(10), floorCfg, texts({ a1: odd }))
    expect(p.elite).toEqual(['a1'])
    expect(p.rescued).toEqual(['a8'])
    expect(p.rescued).not.toContain('a1')
  })

  test('missing strategy text scores 0: no evidence means no rescue', () => {
    // Empty record: every culled agent is textless → plan equals the floor-off bands.
    const p = planSelection(ranked(10), floorCfg, {})
    expect(p.rescued).toEqual([])
    expect(p.culled).toEqual(['a8', 'a9', 'a10'])
    // Partial: a9 is distinct with text, a10 has no text at all → a9 wins on
    // evidence; the textless agent scores 0 and is never rescued by default.
    const partial = texts({ a9: odd })
    partial.delete('a10')
    const q = planSelection(ranked(10), floorCfg, partial)
    expect(q.rescued).toEqual(['a9'])
  })
})
describe('planSelection crossover', () => {
  test('pct 0 yields no crossovers and clones identical to today', () => {
    const p = planSelection(ranked(20), cfg)
    expect(p.crossovers).toEqual([])
    expect(p.clones.map((c) => c.parentAgentId)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  test('pct 0.5 turns the first culled slots into crossovers', () => {
    const p = planSelection(ranked(20), { ...cfg, crossoverPct: 0.5 })
    expect(p.crossovers).toEqual([
      { parentAId: 'a1', parentBId: 'a2', replacesAgentId: 'a17' },
      { parentAId: 'a3', parentBId: 'a4', replacesAgentId: 'a18' },
    ])
    expect(p.clones.map((c) => c.replacesAgentId)).toEqual(['a19', 'a20'])
    // Population invariant: replacements still equal the culled count.
    expect(p.crossovers.length + p.clones.length).toBe(p.culled.length)
    const top = new Set(['a1', 'a2', 'a3', 'a4'])
    for (const x of p.crossovers) {
      expect(x.parentAId).not.toBe(x.parentBId)
      expect(top.has(x.parentAId)).toBe(true)
      expect(top.has(x.parentBId)).toBe(true)
    }
  })

  test('pct 1 turns every culled slot into a crossover', () => {
    const p = planSelection(ranked(20), { ...cfg, crossoverPct: 1 })
    expect(p.crossovers).toHaveLength(4)
    expect(p.clones).toEqual([])
  })

  test('a single-entry top band forces all clones', () => {
    const p = planSelection(ranked(4), { eliteCount: 1, topPct: 0.2, bottomPct: 0.5, crossoverPct: 1, diversityFloor: false })
    expect(p.culled).toHaveLength(2)
    expect(p.crossovers).toEqual([])
    expect(p.clones).toHaveLength(2)
  })

  test('throws for a non-finite or out-of-range crossoverPct', () => {
    for (const crossoverPct of [NaN, 1.5, -0.1]) {
      expect(() => planSelection(ranked(20), { ...cfg, crossoverPct })).toThrow(/crossoverPct/i)
    }
  })
})
