import { describe, expect, test } from 'vitest'
import { diffConfig } from '../../web/src/lib/compare.js'
import type { RunConfig } from '../../web/src/api.js'

const base: RunConfig = {
  sandbox: 'mock',
  concurrency: 8,
  roster: [
    { modelId: 'a', count: 5, temperature: 0.7 },
    { modelId: 'b', count: 5, temperature: 0.8 },
  ],
  judge: { modelId: 'j1', mode: 'auto' },
  reflect: { modelId: 'r1' },
  selection: { topPct: 0.2, bottomPct: 0.2, eliteCount: 1, crossoverPct: 0 },
  budget: { maxRunTokens: 5_000_000, maxRoundTokens: 1_000_000, maxAgentTokens: 200_000 },
}

describe('diffConfig', () => {
  test('identical configs → all differs=false', () => {
    const rows = diffConfig(base, { ...base })
    expect(rows).toHaveLength(13)
    expect(rows.every((r) => r.differs === false)).toBe(true)
  })

  test('one field changed (judge.modelId) → exactly one differs=true', () => {
    const rows = diffConfig(base, { ...base, judge: { ...base.judge, modelId: 'j2' } })
    const changed = rows.filter((r) => r.differs)
    expect(changed).toHaveLength(1)
    expect(changed[0]!.field).toBe('judge.modelId')
  })

  test('roster count change → roster row differs', () => {
    const rows = diffConfig(base, {
      ...base,
      roster: [base.roster[0]!, { ...base.roster[1]!, count: 3 }],
    })
    const roster = rows.find((r) => r.field === 'roster')
    expect(roster?.differs).toBe(true)
  })

  test('nested selection field change → that row differs only', () => {
    const rows = diffConfig(base, { ...base, selection: { ...base.selection, topPct: 0.3 } })
    const topPct = rows.find((r) => r.field === 'selection.topPct')
    expect(topPct?.differs).toBe(true)
    expect(rows.filter((r) => r.field !== 'selection.topPct' && r.differs)).toHaveLength(0)
  })
})
