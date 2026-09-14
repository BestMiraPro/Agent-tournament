import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { RoundStats, RunSnapshot } from '../../web/src/api.js'
import { RunSummary } from '../../web/src/components/RunSummary.js'
import { comparableRoundSegments, latestComparableSegment } from '../../web/src/lib/goals.js'

function round(idx: number, goalMd: string, scoreScale: RoundStats['scoreScale'], max = idx * 10): RoundStats {
  return {
    idx,
    goalMd,
    scoreScale,
    costUsd: 0,
    fitness: { min: max - 2, mean: max - 1, max },
    modelShare: [],
    diversity: 0,
    criteriaMd: null,
    criteriaSource: 'generated',
    metaDigest: null,
    judgeMode: 'single',
  }
}

const snapshot: RunSnapshot = {
  runId: 'run', name: 'Run', lastRoundIdx: 3, goalMd: 'goal', initialCriteria: null, lastRoundCriteria: null,
  agents: [], scores: [],
  busy: false, lastError: null, sandbox: 'mock', roster: [], capacity: null, warnings: [],
}

describe('comparable round segments', () => {
  test('keeps a constant goal and score scale in one series', () => {
    const rounds = [round(1, 'goal', 'judge'), round(2, 'goal', 'judge')]

    expect(comparableRoundSegments(rounds)).toEqual([rounds])
  })

  test('splits when the goal changes or scoring changes from judge to rank', () => {
    const rounds = [round(1, 'goal', 'judge'), round(2, 'next goal', 'judge'), round(3, 'next goal', 'rank')]

    expect(comparableRoundSegments(rounds)).toEqual([[rounds[0]], [rounds[1]], [rounds[2]]])
  })

  test('starts a new series when a goal returns after another goal', () => {
    const rounds = [round(1, 'goal', 'judge'), round(2, 'other', 'judge'), round(3, 'goal', 'judge')]

    expect(comparableRoundSegments(rounds)).toEqual([[rounds[0]], [rounds[1]], [rounds[2]]])
  })

  test('does not render a trend for a one-round latest comparable segment', () => {
    const rounds = [round(1, 'goal', 'judge', 10), round(2, 'goal', 'judge', 99), round(3, 'next goal', 'judge', 20)]

    expect(latestComparableSegment(rounds)).toEqual([rounds[2]])
    const markup = renderToStaticMarkup(createElement(RunSummary, { snapshot, busy: false, roundStats: rounds }))
    expect(markup).toContain('latest comparable segment')
    expect(markup).toContain('20.00')
    expect(markup).toContain('r3')
    expect(markup).not.toContain('spark__trend')
  })
})
