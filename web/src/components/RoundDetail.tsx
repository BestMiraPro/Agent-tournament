import { useEffect, useState } from 'react'
import { getRoundDetail, serverError, type RoundDetail as RoundDetailData } from '../api.js'
import { Markdown } from './Markdown.js'

// Manifest entries are FileEntry { path, bytes } rows, but the endpoint serves
// them as unknown — fall back to String() so a shape change degrades to text.
function fileName(f: unknown): string {
  if (typeof f === 'object' && f !== null && 'path' in f) return String((f as { path: unknown }).path)
  return String(f)
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`
}

function Submission({ sub }: { sub: NonNullable<RoundDetailData['entries'][number]['submission']> }) {
  const manifestFiles = Array.isArray(sub.fileManifest) ? sub.fileManifest : null
  return (
    <>
      {sub.status !== 'ok' && <pre className="drawer__error">{sub.errorText ?? `submission ${sub.status}`}</pre>}
      {sub.submissionMd
        ? <Markdown text={sub.submissionMd} />
        : <p className="muted">No submission file.</p>}
      {manifestFiles && manifestFiles.length > 0 && (
        <ul className="drawer__files">
          {manifestFiles.map((f, i) => <li key={i}>{fileName(f)}</li>)}
        </ul>
      )}
      <p className="muted">
        {fmtCost(sub.costUsd)}
        {sub.durationMs !== null && <> · {fmtDuration(sub.durationMs)}</>}
        {' '}· {sub.tokens.in} in / {sub.tokens.out} out tokens
      </p>
    </>
  )
}

export function RoundDetail({ runId, rounds, busy, refreshKey }: {
  runId: string
  rounds: { idx: number }[]
  busy: boolean
  refreshKey: unknown
}) {
  // `rounds` is round-stats = completed rounds only; the in-flight idx is one
  // past the max (round idxs are sequential from 1) and exists as a row the
  // detail endpoint serves with entries [] while scoring runs.
  const completed = rounds.map((r) => r.idx).sort((a, b) => a - b)
  const inFlight = busy ? (completed.length > 0 ? completed[completed.length - 1]! + 1 : 1) : null
  const options = inFlight !== null && !completed.includes(inFlight) ? [...completed, inFlight] : completed

  const [selected, setSelected] = useState<number | null>(null)
  const effective = selected !== null && options.includes(selected)
    ? selected
    : options.length > 0 ? options[options.length - 1]! : null

  const [detail, setDetail] = useState<RoundDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // First load shows a line; later refreshes stay silent so a flaky fetch never
  // wipes the entries — the arena's own refresh already surfaces connection problems.
  useEffect(() => {
    if (effective === null) return
    let alive = true
    getRoundDetail(runId, effective)
      .then((d) => { if (alive) { setDetail(d); setLoading(false); setError(null) } })
      .catch((e) => { if (alive) { setError(serverError(e)); setLoading(false) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, effective, refreshKey])

  if (options.length === 0) return null

  const handleSelect = (idx: number) => {
    setSelected(idx)
    // Drop the previous round's detail so the panel never shows round N's
    // entries under round M's header while the fetch is in flight.
    setDetail(null)
    setLoading(true)
    setError(null)
  }

  return (
    <section className="rounddetail" aria-label="Round detail">
      <div className="rounddetail__head">
        <h2>Round detail</h2>
        <select
          aria-label="Round"
          value={effective ?? ''}
          onChange={(e) => handleSelect(Number(e.target.value))}
        >
          {options.map((idx) => (
            <option key={idx} value={idx}>
              {idx === inFlight ? `Round ${idx} (in progress)` : `Round ${idx}`}
            </option>
          ))}
        </select>
      </div>
      {loading && detail === null && <p className="muted">Loading round…</p>}
      {error && detail === null && <p className="error">{error}</p>}
      {detail && (
        <>
          <div className="rounddetail__header">
            <p className="rounddetail__goal">{detail.goalMd}</p>
            <p className="muted">
              {detail.criteriaMd ?? 'No criteria recorded.'}{' '}
              <span className={`badge badge--${detail.criteriaSource}`}>{detail.criteriaSource}</span>{' '}
              <span className="badge">{detail.status}</span>{' '}
              <span className="muted">{fmtCost(detail.costUsd)} · judge: {detail.judgeMode}</span>
            </p>
            {detail.metaDigest !== null && <Markdown text={detail.metaDigest} />}
          </div>
          {detail.entries.length === 0 ? (
            <p className="muted">Scoring in progress — entries appear after judging.</p>
          ) : (
            <div className="rounddetail__entries">
              {detail.entries.map((e) => (
                <article key={e.agentId} className="rounddetail__entry">
                  <div className="rounddetail__entry-head">
                    <span className="badge">#{e.rank}</span>
                    <span className="rounddetail__label">{e.label}</span>
                    <span className="badge" title={e.modelId}>{e.modelId}</span>
                    <span>{e.score.toFixed(2)}</span>
                    <span className="muted">{e.band ?? '—'}</span>
                  </div>
                  <Markdown text={e.rationaleMd} />
                  <details>
                    <summary>
                      {e.submission ? `${e.submission.status} · ${fmtCost(e.submission.costUsd)}` : 'no submission'}
                    </summary>
                    {e.submission ? <Submission sub={e.submission} /> : <p className="muted">No submission file.</p>}
                  </details>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
