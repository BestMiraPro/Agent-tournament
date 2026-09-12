import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  WORKER_COST_HEADING, WORKER_COST_LABEL, WORKER_COST_TITLE, fmtCost,
} from '../../web/src/lib/cost.js'

describe('cost labelling', () => {
  test('formats to four decimal places', () => {
    expect(fmtCost(0)).toBe('$0.0000')
    expect(fmtCost(1.23456)).toBe('$1.2346')
  })

  test('the wording says what is excluded, not just what is counted', () => {
    // A reader who only sees "cost" has no way to know a judge call is missing from it.
    for (const excluded of ['Judging', 'reflection', 'criteria', 'recombination']) {
      expect(WORKER_COST_TITLE.toLowerCase()).toContain(excluded.toLowerCase())
    }
    expect(WORKER_COST_TITLE).toMatch(/higher than this/)
    expect(WORKER_COST_LABEL).toBe('worker cost')
    expect(WORKER_COST_HEADING).toBe('Worker cost')
  })

  /**
   * Reported cost is the sum of submission costs — agent calls only. Judging, reflection,
   * criteria generation and recombination go through Provider.complete, which returns text
   * and no usage, so the engine never learns what they cost; budget.record is likewise
   * called only inside the per-agent loop. Calling any of this "Total cost" overstates how
   * much of the bill the number covers, by a margin that grows with population.
   */
  test('no view claims a total, and none re-implements the formatter', () => {
    const views = [
      'web/src/components/RunSummary.tsx',
      'web/src/components/RunBrowser.tsx',
      'web/src/components/AnalyticsPanel.tsx',
      'web/src/components/CompareRuns.tsx',
      'web/src/components/RoundDetail.tsx',
      'web/src/components/AgentDrawer.tsx',
    ]
    for (const view of views) {
      const source = readFileSync(view, 'utf8')
      expect(source).toMatch(/from '\.\.\/lib\/cost\.js'/)
      expect(source).not.toMatch(/function fmtCost/)
      expect(source).not.toMatch(/Total cost/)
      expect(source).not.toMatch(/<th>Cost<\/th>/)
    }
  })
})
