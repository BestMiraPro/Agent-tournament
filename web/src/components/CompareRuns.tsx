import { useEffect, useState } from 'react'
import { getExport, serverError, type RunExport } from '../api.js'
import { diffConfig } from '../lib/compare.js'
import { WORKER_COST_HEADING, WORKER_COST_TITLE, fmtCost } from '../lib/cost.js'

function fmtScore(n: number | null): string {
  return n === null ? '—' : n.toFixed(2)
}


function fmtWinner(w: { label: string; modelId: string } | null): string {
  return w ? `${w.label} · ${w.modelId}` : '—'
}

// Per-run summary derived purely from the export JSON: last round's goal
// (RunRow has no goal field — goals live on rounds), best/mean over every
// scored entry, total cost summed across rounds, and the agent holding the
// single highest score (label + modelId from that entry).
function summarize(e: RunExport): {
  name: string
  goal: string
  sandbox: string
  rounds: number
  best: number | null
  mean: number | null
  cost: number
  winner: { label: string; modelId: string } | null
} {
  const goal = e.rounds.length > 0 ? e.rounds[e.rounds.length - 1]!.goalMd : ''
  const entries = e.rounds.flatMap((r) => r.entries)
  const scores = entries.map((en) => en.score)
  const best = scores.length ? Math.max(...scores) : null
  const mean = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null
  const cost = e.rounds.reduce((s, r) => s + r.costUsd, 0)
  let winner: { label: string; modelId: string } | null = null
  let winnerScore = -Infinity
  for (const en of entries) {
    if (en.score > winnerScore) {
      winnerScore = en.score
      winner = { label: en.label, modelId: en.modelId }
    }
  }
  return { name: e.run.name, goal, sandbox: e.config.sandbox, rounds: e.rounds.length, best, mean, cost, winner }
}

export function CompareRuns({ a, b, onBack }: { a: string; b: string; onBack: () => void }) {
  const [data, setData] = useState<[RunExport, RunExport] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    setData(null)
    Promise.all([getExport(a), getExport(b)])
      .then(([ra, rb]) => { if (alive) setData([ra, rb]) })
      .catch((e) => { if (alive) setError(serverError(e)) })
    return () => { alive = false }
  }, [a, b])

  return (
    <>
      <div className="arena-head">
        <h1>Agent Tournament — compare runs</h1>
        <button onClick={onBack}>Back to runs</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading comparison…</p>}
      {data && (() => {
        const [ra, rb] = data
        const sa = summarize(ra)
        const sb = summarize(rb)
        const rows = diffConfig(ra.config, rb.config)
        return (
          <section aria-label="Run comparison">
            <table className="compare">
              <thead>
                <tr><th></th><th>Run A</th><th>Run B</th></tr>
              </thead>
              <tbody>
                <tr><th>Name</th><td>{sa.name}</td><td>{sb.name}</td></tr>
                <tr><th>Goal</th><td className="compare__goal">{sa.goal || '—'}</td><td className="compare__goal">{sb.goal || '—'}</td></tr>
                <tr><th>Sandbox</th><td>{sa.sandbox}</td><td>{sb.sandbox}</td></tr>
                <tr><th>Rounds</th><td>{sa.rounds}</td><td>{sb.rounds}</td></tr>
                <tr><th>Best score</th><td>{fmtScore(sa.best)}</td><td>{fmtScore(sb.best)}</td></tr>
                <tr><th>Mean score</th><td>{fmtScore(sa.mean)}</td><td>{fmtScore(sb.mean)}</td></tr>
                <tr><th title={WORKER_COST_TITLE}>{WORKER_COST_HEADING}</th><td>{fmtCost(sa.cost)}</td><td>{fmtCost(sb.cost)}</td></tr>
                <tr><th>Winner</th><td>{fmtWinner(sa.winner)}</td><td>{fmtWinner(sb.winner)}</td></tr>
              </tbody>
            </table>
            <h2>Config diff</h2>
            <table className="compare">
              <thead>
                <tr><th>Field</th><th>Run A</th><th>Run B</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.field} className={r.differs ? 'diff--changed' : 'diff--same'}>
                    <td>{r.field}</td>
                    <td>{r.a}</td>
                    <td>{r.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      })()}
    </>
  )
}
