import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { submissionCostLabel, submissionTokensLabel } from '../../web/src/lib/cost.js'

const sub = (usageKnown: boolean | null) => ({
  costUsd: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, usageKnown,
})

describe('persisted submission usage labels', () => {
  test('a lost terminal response is never shown as zero cost or zero tokens', () => {
    expect(submissionCostLabel(sub(false))).toBe('cost unavailable')
    expect(submissionTokensLabel(sub(false))).toBe('tokens unavailable')
  })

  test('observed usage is shown as the fact it is, including a real zero', () => {
    const observed = { costUsd: 0.0125, tokens: { in: 120, out: 30, cacheRead: 0, cacheWrite: 0 }, usageKnown: true }
    expect(submissionCostLabel(observed)).toBe('$0.0125')
    expect(submissionTokensLabel(observed)).toBe('120 in / 30 out tokens')
    expect(submissionCostLabel(sub(true))).toBe('$0.0000')
  })

  test('rows from before usage was recorded keep showing their stored figures', () => {
    expect(submissionCostLabel(sub(null))).toBe('$0.0000')
    expect(submissionTokensLabel(sub(null))).toBe('0 in / 0 out tokens')
  })

  test('both submission views use the labels rather than formatting raw cost', () => {
    for (const file of ['web/src/components/AgentDrawer.tsx', 'web/src/components/RoundDetail.tsx']) {
      const source = readFileSync(file, 'utf8')
      expect(source).toMatch(/submissionCostLabel\(sub\)/)
      expect(source).not.toMatch(/fmtCost\(sub\.costUsd\)/)
    }
  })
})
