import { describe, expect, test } from 'vitest'
import { effectiveRound, roundOptions } from '../../web/src/lib/rounds.js'

describe('roundOptions', () => {
  test('never offers round 0 when a first round has just started', () => {
    // The regression: busy is true from the websocket, lastRoundIdx is still 0 from a
    // stale snapshot. Round 0 does not exist, so requesting it 404s.
    expect(roundOptions([], true, 0)).toEqual([])
  })

  test('offers the in-flight round once the snapshot has caught up', () => {
    expect(roundOptions([], true, 1)).toEqual([1])
  })

  test('appends the in-flight round after completed ones', () => {
    expect(roundOptions([1, 2], true, 3)).toEqual([1, 2, 3])
  })

  test('does not duplicate a round that is both completed and in flight', () => {
    expect(roundOptions([1, 2], true, 2)).toEqual([1, 2])
  })

  test('offers only completed rounds when idle', () => {
    expect(roundOptions([1, 2], false, 2)).toEqual([1, 2])
  })

  test('ignores lastRoundIdx entirely when idle', () => {
    expect(roundOptions([1], false, 99)).toEqual([1])
  })

  test('sorts completed rounds ascending', () => {
    expect(roundOptions([3, 1, 2], false, 3)).toEqual([1, 2, 3])
  })

  test('handles a run with no rounds at all', () => {
    expect(roundOptions([], false, 0)).toEqual([])
  })
})

describe('effectiveRound', () => {
  test('returns null when there is nothing to show', () => {
    expect(effectiveRound([], null)).toBeNull()
  })

  test('defaults to the newest round', () => {
    expect(effectiveRound([1, 2, 3], null)).toBe(3)
  })

  test('honours a valid selection', () => {
    expect(effectiveRound([1, 2, 3], 2)).toBe(2)
  })

  test('falls back to the newest when the selection no longer exists', () => {
    // A selected in-flight round disappears from options once the round fails.
    expect(effectiveRound([1, 2], 5)).toBe(2)
  })
})
