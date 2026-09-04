import { describe, expect, test } from 'vitest'
import { planSelection } from '../../src/core/selection.js'
import type { RankedAgent } from '../../src/core/selection.js'

const ranked = (n: number): RankedAgent[] =>
  Array.from({ length: n }, (_, i) => ({
    agentId: `a${i + 1}`,
    rank: i + 1,
    score: 100 - i,
  }))

const cfg = { eliteCount: 1, topPct: 0.2, bottomPct: 0.2, crossoverPct: 0 }

describe('planSelection', () => {
  test('population size is invariant', () => {
    const p = planSelection(ranked(20), cfg)
    expect(p.elite.length + p.survivors.length + p.clones.length).toBe(20)
  })

  test('clone count always equals cull count, even at asymmetric ratios', () => {
    const asym = { eliteCount: 1, topPct: 0.3, bottomPct: 0.1, crossoverPct: 0 }
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
    expect(p).toEqual({ elite: [], survivors: [], culled: [], clones: [], crossovers: [] })
  })

  test('throws when eliteCount is negative', () => {
    expect(() => planSelection(ranked(20), { ...cfg, eliteCount: -1 })).toThrow(/eliteCount/i)
  })

  test('throws when topPct is NaN', () => {
    expect(() => planSelection(ranked(20), { ...cfg, topPct: NaN })).toThrow(/topPct|finite/i)
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
    const p = planSelection(ranked(4), { eliteCount: 1, topPct: 0.2, bottomPct: 0.5, crossoverPct: 1 })
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
