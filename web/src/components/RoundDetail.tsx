import { useEffect, useRef, useState } from 'react'
import { getRoundDetail, listModels, rejudge, serverError, type RoundDetail as RoundDetailData, type RejudgeResult } from '../api.js'
import { effectiveRound, roundOptions } from '../lib/rounds.js'
import { createSelectionGuard } from '../lib/lifecycle.js'
import { Markdown } from './Markdown.js'
import { WORKER_COST_LABEL, WORKER_COST_TITLE, fmtCost, submissionCostLabel, submissionTokensLabel } from '../lib/cost.js'

// Manifest entries are FileEntry { path, bytes } rows, but the endpoint serves
// them as unknown — fall back to String() so a shape change degrades to text.
function fileName(f: unknown): string {
  if (typeof f === 'object' && f !== null && 'path' in f) return String((f as { path: unknown }).path)
  return String(f)
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
          {manifestFiles.map((f) => <li key={fileName(f)}>{fileName(f)}</li>)}
        </ul>
      )}
      <p className="muted">
        {submissionCostLabel(sub)}
        {sub.durationMs !== null && <> · {fmtDuration(sub.durationMs)}</>}
        {' '}· {submissionTokensLabel(sub)}
      </p>
    </>
  )
}

export function RoundDetail({ runId, rounds, busy, lastRoundIdx, refreshKey }: {
  runId: string
  rounds: { idx: number }[]
  busy: boolean
  lastRoundIdx: number
  refreshKey: unknown
}) {
  // `rounds` is round-stats = scored rounds only, so the in-flight idx cannot
  // be derived from it (a score-less failed round would shift it). lastRoundIdx
  // is the in-flight row's idx by construction — created at startRound before
  // any scores exist — and the detail endpoint serves it with entries [].
  const completed = rounds.map((r) => r.idx)
  const options = roundOptions(completed, busy, lastRoundIdx)
  // The in-flight round is the one offered but not yet scored; used only to label it.
  const inFlight = options.find((idx) => !completed.includes(idx)) ?? null

  const [selected, setSelected] = useState<number | null>(null)
  const effective = effectiveRound(options, selected)

  const [detail, setDetail] = useState<RoundDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [judgeModel, setJudgeModel] = useState('')
  const [rejudging, setRejudging] = useState(false)
  const [rejudgeResult, setRejudgeResult] = useState<RejudgeResult | null>(null)
  const [rejudgeError, setRejudgeError] = useState<string | null>(null)
  const rejudgeGuard = useRef(createSelectionGuard())
  const rejudgeIdentity = `${runId}:${effective ?? ''}`

  useEffect(() => {
    rejudgeGuard.current.select(rejudgeIdentity)
    setRejudging(false)
    setRejudgeResult(null)
    setRejudgeError(null)
  }, [runId, effective])

  // First load shows a line; later refreshes stay silent so a flaky fetch never
  // wipes the entries — the arena's own refresh already surfaces connection problems.
  useEffect(() => {
    if (effective === null) return
    let alive = true
    setRejudgeResult(null)
    setRejudgeError(null)
    getRoundDetail(runId, effective)
      .then((d) => { if (alive) { setDetail(d); setLoading(false); setError(null) } })
      .catch((e) => { if (alive) { setError(serverError(e)); setLoading(false) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, effective, refreshKey])

  // Known-models is a copy-paste aid only: failure or an empty list hides the
  // datalist options and free-text input keeps working (mirrors RunSetup).
  useEffect(() => {
    let alive = true
    listModels().then(
      (m) => { if (alive) setModels(m) },
      () => { if (alive) setModels([]) },
    )
    return () => { alive = false }
  }, [])

  if (options.length === 0) return null

  const handleSelect = (idx: number) => {
    setSelected(idx)
    // Drop the previous round's detail so the panel never shows round N's
    // entries under round M's header while the fetch is in flight.
    setDetail(null)
    setLoading(true)
    setError(null)
    setRejudgeResult(null)
    setRejudgeError(null)
  }

  const handleRejudge = async () => {
    if (effective === null) return
    const request = rejudgeGuard.current.begin(rejudgeIdentity)
    const roundIdx = effective
    setRejudging(true)
    setRejudgeError(null)
    setRejudgeResult(null)
    try {
      const result = await rejudge(runId, roundIdx, judgeModel.trim())
      if (rejudgeGuard.current.current(`${runId}:${roundIdx}`, request)) setRejudgeResult(result)
    } catch (e) {
      if (rejudgeGuard.current.current(`${runId}:${roundIdx}`, request)) setRejudgeError(serverError(e))
    } finally {
      if (rejudgeGuard.current.current(`${runId}:${roundIdx}`, request)) setRejudging(false)
    }
  }

  return (
    <section className="rounddetail" aria-label="Round detail" aria-busy={loading && detail === null}>
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
              <span className="muted" title={WORKER_COST_TITLE}>
                {fmtCost(detail.costUsd)} {WORKER_COST_LABEL} · judge: {detail.judgeMode}
              </span>
            </p>
            {detail.metaDigest !== null && <Markdown text={detail.metaDigest} />}
          </div>
          <form className="rounddetail__rejudge" onSubmit={(e) => { e.preventDefault(); void handleRejudge() }}>
            <input
              list="rejudge-models"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              placeholder="judge model id"
              disabled={busy || rejudging}
              aria-label="Judge model"
            />
            <datalist id="rejudge-models">
              {models.map((m) => <option key={m} value={m} />)}
            </datalist>
            <button
              type="submit"
              disabled={busy || rejudging || !judgeModel.trim() || detail.status !== 'complete'}
            >
              {rejudging ? 'Rejudging…' : 'Rejudge'}
            </button>
          </form>
          {rejudgeError && <p className="error">{rejudgeError}</p>}
          {rejudgeResult && (
            <div className="rounddetail__rejudge-result">
              <div className="rounddetail__rejudge-head">
                <span className="muted">Rejudge ({rejudgeResult.mode})</span>
                <button type="button" onClick={() => setRejudgeResult(null)}>Clear</button>
              </div>
              <table>
                <thead>
                  <tr><th>Agent</th><th>Old</th><th>New</th><th></th><th>New rationale</th></tr>
                </thead>
                <tbody>
                  {rejudgeResult.entries.map((e) => (
                    <tr key={e.agentId}>
                      <td>{e.label}</td>
                      <td>#{e.oldRank}</td>
                      <td>#{e.newRank}</td>
                      <td>{e.rankChanged ? <span className="badge">changed</span> : <span className="muted">—</span>}</td>
                      <td>{e.newRationaleMd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rejudgeResult.metaDigest && <Markdown text={rejudgeResult.metaDigest} />}
            </div>
          )}
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
                      {e.submission ? `${e.submission.status} · ${submissionCostLabel(e.submission)}` : 'no submission'}
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
