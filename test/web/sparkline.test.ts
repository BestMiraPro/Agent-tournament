import { describe, expect, test } from 'vitest'
import { formatTrend, sparkGeometry } from '../../web/src/lib/sparkline.js'

describe('sparkGeometry', () => {
  test('returns nothing for an empty series', () => {
    const g = sparkGeometry([], 60, 16)
    expect(g.points).toEqual([])
    expect(g.path).toBe('')
    expect(g.last).toBeNull()
  })

  test('places a single point in the middle horizontally', () => {
    const g = sparkGeometry([5], 60, 16)
    expect(g.points).toHaveLength(1)
    expect(g.points[0]!.x).toBe(30)
  })

  test('spans the full width across the series', () => {
    const g = sparkGeometry([1, 2, 3], 60, 16)
    expect(g.points[0]!.x).toBe(0)
    expect(g.points[2]!.x).toBe(60)
  })

  test('inverts y so a rising series rises visually', () => {
    const g = sparkGeometry([1, 10], 60, 16)
    expect(g.points[0]!.y).toBe(16)
    expect(g.points[1]!.y).toBe(0)
  })

  test('draws a flat series along the middle, not the floor', () => {
    // A run whose fitness never moves is the exact failure this chart exists to
    // reveal; pinned to y=height it would read as "no data" rather than "no progress".
    const g = sparkGeometry([7, 7, 7], 60, 16)
    expect(g.points.every((p) => p.y === 8)).toBe(true)
  })

  test('ignores non-finite values', () => {
    const g = sparkGeometry([1, Number.NaN, 3], 60, 16)
    expect(g.points).toHaveLength(2)
  })

  test('builds a valid SVG path', () => {
    expect(sparkGeometry([1, 2], 60, 16).path).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/)
  })

  test('reports a rising trend', () => {
    expect(sparkGeometry([10, 20], 60, 16).trend).toBeCloseTo(1)
  })

  test('reports a falling trend', () => {
    expect(sparkGeometry([20, 10], 60, 16).trend).toBeCloseTo(-0.5)
  })

  test('reports zero trend for a flat series', () => {
    expect(sparkGeometry([5, 5], 60, 16).trend).toBe(0)
  })

  test('cannot compute a trend from zero to non-zero', () => {
    expect(sparkGeometry([0, 5], 60, 16).trend).toBeNull()
  })

  test('exposes the last point for marking the current value', () => {
    const g = sparkGeometry([1, 2, 3], 60, 16)
    expect(g.last).toEqual(g.points[2])
  })
})

describe('formatTrend', () => {
  test('renders a rise with a sign', () => {
    expect(formatTrend(2.85)).toBe('+285%')
  })

  test('renders a fall', () => {
    expect(formatTrend(-0.4)).toBe('-40%')
  })

  test('calls a negligible change flat', () => {
    expect(formatTrend(0.001)).toBe('flat')
  })

  test('returns null when there is nothing to say', () => {
    expect(formatTrend(null)).toBeNull()
  })
})
