import { useEffect, useRef, useState } from 'react'
import { getAgentDetail, retireAgent, serverError, type AgentDetail } from '../api.js'
import type { LiveAgent } from '../useLiveRun.js'
import { lineDiff, type DiffLine } from '../lib/diff.js'
import { Markdown } from './Markdown.js'
import { ActivityTimeline } from './ActivityTimeline.js'
import { submissionCostLabel } from '../lib/cost.js'

const DIFF_PREFIX: Record<DiffLine['kind'], string> = { same: ' ', add: '+', del: '−' }

function Diff({ a, b }: { a: string; b: string }) {
  return (
    <pre className="drawer__diff">
      {lineDiff(a, b).map((l, i) => (
        <div key={i} className={`diff-${l.kind}`}>{DIFF_PREFIX[l.kind]} {l.text}</div>
      ))}
    </pre>
  )
}


function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`
}

// Manifest entries are FileEntry { path, bytes } rows, but the endpoint serves
// them as unknown — fall back to String() so a shape change degrades to text.
function fileName(f: unknown): string {
  if (typeof f === 'object' && f !== null && 'path' in f) return String((f as { path: unknown }).path)
  return String(f)
}

export function AgentDrawer({ runId, agentId, onClose, onRetired, live, activityUnavailable }: {
  runId: string
  agentId: string
  onClose: () => void
  onRetired?: () => void
  /** This agent's live state for the current round, so an open drawer follows it. */
  live?: LiveAgent
  /** The server holds no live history for this run (it restarted since the run was active). */
  activityUnavailable?: boolean
}) {
  const [data, setData] = useState<AgentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retiring, setRetiring] = useState(false)
  const [retireError, setRetireError] = useState<string | null>(null)

  const handleRetire = () => {
    if (!window.confirm('Retire this agent? It sits out future rounds.')) return
    setRetiring(true)
    setRetireError(null)
    retireAgent(runId, agentId)
      .then(() => { onRetired?.() })
      .catch((e) => { setRetireError(serverError(e)); setRetiring(false) })
  }

  // Selecting another cell changes agentId → refetch; `alive` stops a slow stale
  // response from clobbering a newer selection.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setData(null)
    getAgentDetail(runId, agentId)
      .then((d) => { if (alive) { setData(d); setLoading(false) } })
      .catch((e) => { if (alive) { setError(serverError(e)); setLoading(false) } })
    return () => { alive = false }
  }, [runId, agentId])

  // When the agent this drawer shows finishes or fails, re-read its persisted detail in
  // place. The drawer used to fetch once on open, so it went on showing the previous
  // round until it was closed and reopened.
  const terminal = live?.status === 'done' || live?.status === 'failed' ? live.status : null
  const seenTerminal = useRef(terminal)
  useEffect(() => {
    if (terminal === seenTerminal.current) return
    seenTerminal.current = terminal
    if (terminal === null) return
    let alive = true
    getAgentDetail(runId, agentId)
      .then((d) => { if (alive) { setData(d); setError(null); setLoading(false) } })
      .catch(() => { /* keep what is shown; the live failure above still reports this attempt */ })
    return () => { alive = false }
  }, [runId, agentId, terminal])

  // The drawer is only mounted while open, so "while open" = "while mounted".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const genomes = data?.genomes ?? []
  const current = genomes.at(-1)
  const previous = genomes.at(-2)
  const history = data?.history ?? []
  const lastEntry = history.at(-1)
  const sub = lastEntry?.submission ?? null
  const manifestFiles = sub && Array.isArray(sub.fileManifest) ? sub.fileManifest : null
  const bestRank = history.length > 0 ? Math.min(...history.map((h) => h.rank)) : null
  const lineage = data ? [...data.lineage].reverse() : []
  const liveFailure = live?.status === 'failed' ? live.failure : null

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-label={`Agent ${data?.agent.label ?? agentId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer__head">
          <span className="drawer__label">{data?.agent.label ?? agentId}</span>
          {current && (
            <span className="drawer__badge" title={current.modelId}>
              {current.modelId} @ {current.temperature}
            </span>
          )}
          {data && <span className="muted">r{data.agent.bornRound} · {data.agent.status}</span>}
          {data?.agent.status === 'active' && (
            <button className="danger danger--small" disabled={retiring} onClick={handleRetire}>
              {retiring ? 'Retiring…' : 'Retire agent'}
            </button>
          )}
          <button className="drawer__close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {retireError && <p className="error drawer__retire-error">{retireError}</p>}
        <div className="drawer__body">
          {/* Shown before persisted detail loads: this is the attempt happening now. */}
          {liveFailure && (
            <section>
              <h3>Current round failure</h3>
              <pre className="drawer__error">{liveFailure.message}</pre>
              <p className="muted">
                {[
                  liveFailure.httpStatus !== undefined ? `HTTP ${liveFailure.httpStatus}` : null,
                  liveFailure.code ?? null,
                  liveFailure.ref ? `ref ${liveFailure.ref}` : null,
                ].filter(Boolean).join(' · ')}
              </p>
            </section>
          )}
          {(live || activityUnavailable) && (
            <section>
              <h3>Live activity</h3>
              <ActivityTimeline
                items={live?.items ?? []}
                truncated={live?.activityTruncated ?? false}
                unavailable={activityUnavailable ?? false}
              />
            </section>
          )}
          {loading && <p>Loading…</p>}
          {error && <p className="error">{error}</p>}
          {data && !loading && !error && (
            <>
              <section>
                <h3>Score history</h3>
                {history.length === 0 ? (
                  <p className="muted">Not scored yet.</p>
                ) : (
                  <>
                    <p className="muted">Best rank: #{bestRank}</p>
                    <table className="leaderboard">
                      <thead>
                        <tr><th>Round</th><th>Rank</th><th>Score</th><th>Band</th></tr>
                      </thead>
                      <tbody>
                        {history.map((h) => (
                          <tr key={h.roundIdx}>
                            <td>{h.roundIdx}</td>
                            <td>#{h.rank}</td>
                            <td>{h.score.toFixed(2)}</td>
                            <td>{h.band ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>
              {current && (
                <section>
                  <h3>Strategy</h3>
                  <Markdown text={current.strategyMd} />
                  {previous && (
                    <>
                      <h4>vs previous round</h4>
                      <Diff a={previous.strategyMd} b={current.strategyMd} />
                    </>
                  )}
                </section>
              )}
              {current && previous && (previous.notesMd !== '' || current.notesMd !== '') && (
                <section>
                  <h3>Notes</h3>
                  <Diff a={previous.notesMd} b={current.notesMd} />
                </section>
              )}
              {lastEntry && (
                <section>
                  <h3>Latest submission</h3>
                  {sub ? (
                    <>
                      <p>
                        <span className={`drawer__badge drawer__badge--${sub.status}`}>{sub.status}</span>{' '}
                        {submissionCostLabel(sub)}
                        {sub.durationMs !== null && <> · {fmtDuration(sub.durationMs)}</>}
                      </p>
                      {sub.errorText && <pre className="drawer__error">{sub.errorText}</pre>}
                      {sub.submissionMd
                        ? <Markdown text={sub.submissionMd} />
                        : <p className="muted">No submission file.</p>}
                      {manifestFiles && manifestFiles.length > 0 && (
                        <ul className="drawer__files">
                          {manifestFiles.map((f, i) => <li key={i}>{fileName(f)}</li>)}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p className="muted">No submission recorded.</p>
                  )}
                </section>
              )}
              {lastEntry && (
                <section>
                  <h3>Judge rationale</h3>
                  <Markdown text={lastEntry.rationaleMd} />
                </section>
              )}
              <section>
                <h3>Lineage</h3>
                <nav className="drawer__lineage" aria-label="Lineage">
                  {lineage.map((n, i) => (
                    <span key={n.agentId}>
                      <span className="drawer__crumb" title={`born round ${n.bornRound}`}>{n.label}</span>
                      {i < lineage.length - 1 && <span className="drawer__crumb-sep"> → </span>}
                    </span>
                  ))}
                </nav>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
