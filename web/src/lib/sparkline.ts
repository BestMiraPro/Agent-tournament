/**
 * Geometry for the fitness sparkline in the run summary strip.
 *
 * Pure and separately tested: the single question a spectator has is "is evolution
 * working", and answering it previously meant scrolling past ~1500px of grid, round
 * detail and leaderboard to reach the analytics chart.
 */

export interface SparkPoint {
  x: number
  y: number
}

export interface SparkGeometry {
  points: SparkPoint[]
  path: string
  /** Last point, so the caller can mark the current value. */
  last: SparkPoint | null
  /** Fractional change from first to last value; null when it cannot be computed. */
  trend: number | null
}

/**
 * Maps values onto a width x height box, y inverted so higher fitness sits higher.
 *
 * A flat series is drawn along the vertical middle rather than at y=0: a run whose
 * fitness never moves is exactly the failure this chart exists to reveal, and pinning
 * it to the floor would read as "no data" instead of "no progress".
 */
export function sparkGeometry(
  values: readonly number[],
  width: number,
  height: number,
): SparkGeometry {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return { points: [], path: '', last: null, trend: null }

  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min

  const points: SparkPoint[] = finite.map((v, i) => {
    const x = finite.length === 1 ? width / 2 : (i / (finite.length - 1)) * width
    const y = span === 0 ? height / 2 : height - ((v - min) / span) * height
    return { x: round(x), y: round(y) }
  })

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
  const first = finite[0]!
  const lastValue = finite[finite.length - 1]!
  const trend = first === 0 ? (lastValue === 0 ? 0 : null) : (lastValue - first) / Math.abs(first)

  return { points, path, last: points[points.length - 1] ?? null, trend }
}

const round = (n: number): number => Math.round(n * 10) / 10

/** `+312%`, `-4%`, `flat`, or null when there is nothing meaningful to say. */
export function formatTrend(trend: number | null): string | null {
  if (trend === null) return null
  if (Math.abs(trend) < 0.005) return 'flat'
  const pct = Math.round(trend * 100)
  return `${pct > 0 ? '+' : ''}${pct}%`
}
