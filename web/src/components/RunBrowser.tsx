import { useEffect, useState, type KeyboardEvent } from 'react'
import { getRuns, type RunListItem } from '../api.js'

export function RunBrowser({ onOpen, onCreate }: {
  onOpen: (runId: string) => void
  onCreate: () => void
}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    getRuns()
      .then((r) => { if (alive) setRuns(r.runs) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!runs) return <p className="muted">Loading runs…</p>
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div>
      <div className="runbrowser__create">
        <button onClick={onCreate}>Create run</button>
      </div>
      {sorted.length === 0 ? (
        <p className="muted">No runs yet — create one above.</p>
      ) : (
        <table className="runbrowser">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Rounds</th>
              <th>Best</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                className="runbrowser__row"
                role="button"
                tabIndex={0}
                aria-label={`Open run ${r.name}`}
                onClick={() => onOpen(r.id)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(r.id)
                  }
                }}
              >
                <td>{r.name}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.rounds}</td>
                <td>{r.bestScore ? r.bestScore.toFixed(2) : '—'}</td>
                <td>${r.costUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
