import { useEffect, useState, type KeyboardEvent } from 'react'
import { getRuns, type RunListItem } from '../api.js'

export function RunBrowser({ onOpen, onCreate, onCompare }: {
  onOpen: (runId: string) => void
  onCreate: () => void
  onCompare?: (a: string, b: string) => void
}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    getRuns()
      .then((r) => { if (alive) setRuns(r.runs) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])

  // Cap at 2: a third add drops the oldest (FIFO via Set insertion order) so
  // the "Compare selected" button's two ids stay stable and recent.
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else {
        if (next.size >= 2) next.delete(next.values().next().value as string)
        next.add(id)
      }
      return next
    })
  }

  if (error) return <p className="error">{error}</p>
  if (!runs) return <p className="muted">Loading runs…</p>
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div>
      <div className="runbrowser__create">
        <button onClick={onCreate}>Create run</button>
        {onCompare && selected.size === 2 && (
          <button
            onClick={() => {
              const [a, b] = [...selected] as [string, string]
              setSelected(new Set())
              onCompare(a, b)
            }}
          >
            Compare selected
          </button>
        )}
      </div>
      {sorted.length === 0 ? (
        <p className="muted">No runs yet — create one above.</p>
      ) : (
        <table className="runbrowser">
          <thead>
            <tr>
              <th></th>
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
                  if (e.currentTarget !== e.target) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(r.id)
                  }
                }}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    aria-label={`Select run ${r.name}`}
                    onChange={() => toggle(r.id)}
                  />
                </td>
                <td>{r.name}</td>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.rounds}</td>
                <td>{r.bestScore !== null ? r.bestScore.toFixed(2) : '—'}</td>
                <td>${r.costUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
