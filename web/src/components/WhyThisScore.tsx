import type { AgentCoverage, AuditEvidenceItem, JudgingCall, ScoringAudit } from '../api.js'

/**
 * The public decision record behind one score: the rubric assessments, what was cited, what
 * the evidence could not show, the behavioural review, and the exact grader input and reply.
 *
 * Everything renders as text — no Markdown, no HTML, nothing fetched — because every string
 * here came from a model or an agent. Sections are `<details>`, so they are keyboard-reachable.
 */

/** `S2-E7` names record `E7` of the submission shown as `S2`; resolve it against this agent's records. */
export function evidenceFor(records: readonly AuditEvidenceItem[], agentId: string, evidenceId: string): AuditEvidenceItem | null {
  const dash = evidenceId.indexOf('-')
  const recordId = dash === -1 ? evidenceId : evidenceId.slice(dash + 1)
  return records.find((r) => r.agentId === agentId && r.id === recordId) ?? null
}

export function derivationLabel(audit: ScoringAudit): string {
  if (audit.scoreDerivation === 'model_awarded') return 'The grader awarded this score.'
  if (audit.scoreDerivation === 'not_judged') return 'Not graded: no grading call ranked this attempt.'
  const s = audit.stages
  if (!s) return 'Score derived from placing, not a rubric total.'
  return [
    `Score derived from placing, not a rubric total: ${s.formula}`,
    ...(s.batch ? [`batch rank ${s.batch.rank} of ${s.batch.of}`] : []),
    ...(s.finals ? [`finals rank ${s.finals.rank} of ${s.finals.of}`] : ['no finals call']),
    `position ${s.position} of ${s.of}`,
  ].join(' · ')
}

export function coverageLabel(coverage: AgentCoverage | null): string {
  if (!coverage) return 'No activity coverage was recorded for this attempt.'
  const capture = !coverage.capture
    ? 'no capture recorded'
    : coverage.capture.tampered
      ? 'submission changed after capture'
      : coverage.capture.sealed && coverage.capture.verified
        ? 'capture sealed and verified'
        : 'capture not certifiable'
  return [
    `${coverage.records} record(s)`,
    capture,
    ...(coverage.dropped > 0 ? [`${coverage.dropped} not kept at the evidence limit`] : []),
    ...(coverage.truncated > 0 ? [`${coverage.truncated} cut to the size limit`] : []),
  ].join(' · ')
}

function Cites({ ids, agentId, records }: { ids: string[]; agentId: string; records: readonly AuditEvidenceItem[] }) {
  if (ids.length === 0) return <p className="muted">No evidence cited.</p>
  return (
    <ul className="why__cites">
      {ids.map((id) => {
        const record = evidenceFor(records, agentId, id)
        return (
          <li key={id}>
            <code>{id}</code>{' '}
            {record
              ? `[${record.kind}${record.outcome ? ` ${record.outcome}` : ''}] ${record.summary}`
              : 'no such record in this round’s evidence'}
          </li>
        )
      })}
    </ul>
  )
}

export function WhyThisScore({ agentId, audit, records, coverage, calls, digestMatches, evidenceStatus }: {
  agentId: string
  audit: ScoringAudit | null
  records: readonly AuditEvidenceItem[]
  coverage: AgentCoverage | null
  calls: readonly JudgingCall[]
  /** False when the stored evidence no longer hashes to the digest it was sealed with. */
  digestMatches: boolean | null
  evidenceStatus: string
}) {
  if (!audit) return <p className="muted">Grading record not recorded for this round.</p>
  const mine = calls.filter((c) => Object.values(c.refs).includes(agentId))
  return (
    <div className="why">
      <p>{derivationLabel(audit)}</p>

      <section className="why__section">
        <h4>Criteria</h4>
        {audit.criteria.length === 0
          ? <p className="muted">The grader returned no criterion assessments.</p>
          : audit.criteria.map((c) => (
            <div key={c.criterion} className="why__criterion">
              <p><strong>{c.criterion}</strong> — {c.assessment}</p>
              <Cites ids={c.evidenceIds} agentId={agentId} records={records} />
            </div>
          ))}
      </section>

      <section className="why__section">
        <h4>
          Behavioural review <span className={`badge badge--${audit.safety.status}`}>{audit.safety.status.replace(/_/g, ' ')}</span>
        </h4>
        <p className="muted">A review of observed behaviour. It never raises or lowers the score.</p>
        {audit.safety.findings.map((f, i) => (
          <div key={`${f.category}-${i}`} className="why__finding">
            <p><strong>{f.category} · {f.severity}</strong> — {f.summary}</p>
            <Cites ids={f.evidenceIds} agentId={agentId} records={records} />
          </div>
        ))}
        {audit.safety.limitations.length > 0 && (
          <ul className="why__limits">{audit.safety.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        )}
      </section>

      <section className="why__section">
        <h4>Evidence coverage</h4>
        <p>{coverageLabel(coverage)}</p>
        {evidenceStatus !== 'recorded' && <p className="muted">Activity audit not recorded for this round.</p>}
        {digestMatches === false && <p className="error">The stored evidence no longer matches the digest it was sealed with.</p>}
        {audit.limitations.length > 0 && (
          <ul className="why__limits">{audit.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        )}
      </section>

      <details className="why__raw">
        <summary>Exact grader input and reply ({mine.length} call{mine.length === 1 ? '' : 's'})</summary>
        {mine.length === 0
          ? <p className="muted">No call for this attempt was recorded.</p>
          : mine.map((c, i) => (
            <div key={`${c.stage}-${i}`} className="why__call">
              <p className="muted">
                {c.stage} · {c.modelId}
                {c.repaired && ' · repaired after an invalid reply'}
                {c.error && ` · failed: ${c.error}`}
              </p>
              <pre>{c.prompt}</pre>
              <pre>{c.response === null ? 'no validated reply' : JSON.stringify(c.response, null, 2)}</pre>
              {(c.reasoning ?? null)
                ? <pre>{c.reasoning}</pre>
                : <p className="muted">The model returned no reasoning trace for this call.</p>}
            </div>
          ))}
      </details>
    </div>
  )
}
