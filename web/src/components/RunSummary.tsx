import type { RoundStats, RunSnapshot } from '../api.js'
import { formatTrend, sparkGeometry } from '../lib/sparkline.js'

const SPARK_W = 68
const SPARK_H = 16

/**
 * Answers "is evolution working?" without leaving the top of the page.
 *
 * The full analytics chart sits ~1500px down, past the grid, the leaderboard and the
 * round detail — so the one question a spectator actually has took a long scroll.
 */
function FitnessSpark({ rounds }: { rounds: RoundStats[] }) {
  if (rounds.length < 2) return null
  const means = rounds.map((r) => r.fitness.mean)
  const g = sparkGeometry(means, SPARK_W, SPARK_H)
  if (g.points.length < 2) return null

  const trend = formatTrend(g.trend)
  const rising = g.trend !== null && g.trend > 0.005
  const flat = g.trend !== null && Math.abs(g.trend) <= 0.005
  const label =
    trend === null
      ? 'Mean fitness across rounds'
      : `Mean fitness ${trend === 'flat' ? 'unchanged' : `${trend} across ${rounds.length} rounds`}`

  return (
    <span className="spark" title={label}>
      <svg
        width={SPARK_W}
        height={SPARK_H}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        role="img"
        aria-label={label}
        focusable="false"
      >
        <path className="spark__line" d={g.path} />
        {g.last && <circle className="spark__dot" cx={g.last.x} cy={g.last.y} r="1.8" />}
      </svg>
      {trend && (
        <span className={`spark__trend${rising ? ' spark__trend--up' : flat ? ' spark__trend--flat' : ' spark__trend--down'}`}>
          {trend}
        </span>
      )}
    </span>
  )
}

// Pure presentational strip: every value derives from props (snapshot +
// round-stats), so no fetch lives here — App passes what it already has.
export function RunSummary({ snapshot, busy, roundStats }: {
  snapshot: RunSnapshot
  busy: boolean
  roundStats: RoundStats[]
}) {
  let best: { score: number; idx: number } | null = null
  for (const r of roundStats) {
    if (!best || r.fitness.max > best.score) best = { score: r.fitness.max, idx: r.idx }
  }
  const totalCost = roundStats.reduce((sum, r) => sum + (Number.isFinite(r.costUsd) ? r.costUsd : 0), 0)
  const rostered = snapshot.roster.reduce((sum, r) => sum + (Number.isFinite(r.count) ? r.count : 0), 0)

  return (
    <section className="summary__strip" aria-label="Run summary" role="status" aria-live="polite">
      <span className="summary__name">{snapshot.name}</span>
      <span className="badge" title="sandbox">{snapshot.sandbox}</span>
      <span className={`badge${busy ? ' badge--live' : ''}`}>{busy ? 'running' : 'idle'}</span>
      <span className="stat"><em>rounds</em>{roundStats.length}</span>
      <span className="stat">
        <em>best</em>{best ? `${best.score.toFixed(2)}` : '—'}
        {best && <small> r{best.idx}</small>}
      </span>
      <FitnessSpark rounds={roundStats} />
      <span className="stat"><em>cost</em>${totalCost.toFixed(4)}</span>
      <span className="stat"><em>agents</em>{snapshot.agents.length}<small> / {rostered}</small></span>
    </section>
  )
}
