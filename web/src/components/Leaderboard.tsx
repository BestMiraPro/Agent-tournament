import type { SnapshotAgent } from '../api.js'
import type { LiveState } from '../useLiveRun.js'

export function Leaderboard({ agents, live }: { agents: SnapshotAgent[]; live: LiveState }) {
  const labelOf = new Map(agents.map((a) => [a.agentId, a.label]))
  if (live.scores.length === 0) return <p className="muted">No scores yet.</p>

  return (
    <table className="leaderboard">
      <thead>
        <tr><th>#</th><th>Agent</th><th>Score</th></tr>
      </thead>
      <tbody>
        {live.scores.map((s) => (
          <tr key={s.agentId}>
            <td>{s.rank}</td>
            <td>{labelOf.get(s.agentId) ?? s.agentId.slice(0, 8)}</td>
            <td>{s.score.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
