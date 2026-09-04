import type { RoundStats, RunSnapshot } from '../api.js'

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
      <span className="badge">{busy ? 'running' : 'idle'}</span>
      <span>{roundStats.length} round{roundStats.length === 1 ? '' : 's'}</span>
      <span>best {best ? `${best.score.toFixed(2)} (round ${best.idx})` : '—'}</span>
      <span>${totalCost.toFixed(4)}</span>
      <span className="muted">{snapshot.agents.length} active / {rostered} rostered</span>
    </section>
  )
}
