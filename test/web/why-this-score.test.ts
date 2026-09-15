import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { AuditEvidenceItem, JudgingCall, ScoringAudit } from '../../web/src/api.js'
import { WhyThisScore, coverageLabel, derivationLabel, evidenceFor } from '../../web/src/components/WhyThisScore.js'

const records: AuditEvidenceItem[] = [
  { id: 'E1', agentId: 'a', kind: 'tool', outcome: 'completed', summary: 'bash: python fib.py', observedAt: 1, source: 'provider_stream' },
  { id: 'E2', agentId: 'a', kind: 'tool', outcome: 'denied', summary: 'read: /context/BRIEF.md', observedAt: 2, source: 'policy' },
  { id: 'E1', agentId: 'b', kind: 'tool', outcome: 'completed', summary: "someone else's work", observedAt: 3, source: 'provider_stream' },
]

const audit: ScoringAudit = {
  criteria: [{ criterion: 'correctness', assessment: 'ran the script and quoted real output', evidenceIds: ['S1-E1'] }],
  scoreDerivation: 'model_awarded',
  limitations: ['Tool summaries do not show everything a command did.'],
  safety: {
    status: 'flagged',
    findings: [{ category: 'filesystem', severity: 'low', summary: 'tried to read outside its workspace', evidenceIds: ['S1-E2', 'S1-E9'] }],
    limitations: ['1 cited evidence reference(s) were not in the evidence shown and were removed.'],
  },
}

const calls: JudgingCall[] = [
  { stage: 'single', purpose: 'judge', modelId: 'w/m', refs: { S1: 'a', S2: 'b' }, prompt: 'SUBMISSIONS: <submission ref="S1">', response: { rankings: [] }, repaired: true, error: null },
  { stage: 'safety', purpose: 'review', modelId: 'w/m', refs: { F1: 'c' }, prompt: 'other agent only', response: null, error: 'upstream 429', repaired: false },
]

const render = (over: Partial<Parameters<typeof WhyThisScore>[0]> = {}) =>
  renderToStaticMarkup(createElement(WhyThisScore, {
    agentId: 'a', audit, records, calls, evidenceStatus: 'recorded', digestMatches: true,
    coverage: { records: 2, dropped: 0, truncated: 0, capture: { sealed: true, verified: true, tampered: false } },
    ...over,
  }))

describe('evidence references', () => {
  test('an id resolves against its own agent, never another agent with the same record id', () => {
    expect(evidenceFor(records, 'a', 'S1-E1')?.summary).toBe('bash: python fib.py')
    expect(evidenceFor(records, 'b', 'S2-E1')?.summary).toBe("someone else's work")
    expect(evidenceFor(records, 'a', 'S1-E9')).toBeNull()
  })
})

describe('score derivation', () => {
  test('a model-awarded score says so; a rank-derived one shows the placings and arithmetic', () => {
    expect(derivationLabel(audit)).toBe('The grader awarded this score.')
    expect(derivationLabel({
      ...audit, scoreDerivation: 'rank_derived',
      stages: { batch: { rank: 2, of: 5 }, finals: null, position: 4, of: 12, formula: 'round((12 - 3) / 12 × 100, 2) = 75' },
    })).toBe('Score derived from placing, not a rubric total: round((12 - 3) / 12 × 100, 2) = 75 · batch rank 2 of 5 · no finals call · position 4 of 12')
    expect(derivationLabel({ ...audit, scoreDerivation: 'not_judged' })).toBe('Not graded: no grading call ranked this attempt.')
  })

  test('coverage states captures and losses plainly, including having none', () => {
    expect(coverageLabel(null)).toBe('No activity coverage was recorded for this attempt.')
    expect(coverageLabel({ records: 9, dropped: 2, truncated: 1, capture: { sealed: false, verified: false, tampered: false } }))
      .toBe('9 record(s) · capture not certifiable · 2 not kept at the evidence limit · 1 cut to the size limit')
    expect(coverageLabel({ records: 1, dropped: 0, truncated: 0, capture: { sealed: true, verified: true, tampered: true } }))
      .toBe('1 record(s) · submission changed after capture')
  })
})

describe('Why this score', () => {
  const html = render()

  test('shows the criterion assessments with the cited evidence resolved to what was observed', () => {
    expect(html).toContain('correctness')
    expect(html).toContain('ran the script and quoted real output')
    expect(html).toContain('<code>S1-E1</code> [tool completed] bash: python fib.py')
  })

  test('the behavioural review is shown as separate from the score, with its findings and limits', () => {
    expect(html).toContain('Behavioural review')
    expect(html).toContain('It never raises or lowers the score.')
    expect(html).toContain('flagged')
    expect(html).toContain('tried to read outside its workspace')
    expect(html).toContain('<code>S1-E2</code> [tool denied] read: /context/BRIEF.md')
    // A reference the validator removed cannot be resolved, and says so rather than inventing one.
    expect(html).toContain('no such record in this round’s evidence')
  })

  test('only this agent\'s grading calls are offered, with the exact input and reply', () => {
    expect(html).toContain('Exact grader input and reply (1 call)')
    expect(html).toContain('repaired after an invalid reply')
    expect(html).toContain('SUBMISSIONS: &lt;submission ref=&quot;S1&quot;&gt;')
    expect(html).not.toContain('other agent only')
  })

  test('a round with no grading record says so instead of showing an empty one', () => {
    expect(render({ audit: null })).toContain('Grading record not recorded for this round.')
  })

  test('an unrecorded audit and a broken digest are both surfaced', () => {
    const html2 = render({ evidenceStatus: 'not_recorded', digestMatches: false, coverage: null })
    expect(html2).toContain('Activity audit not recorded for this round.')
    expect(html2).toContain('The stored evidence no longer matches the digest it was sealed with.')
  })

  test('evidence renders as text, never through the markdown or html path', () => {
    const src = readFileSync('web/src/components/WhyThisScore.tsx', 'utf8')
    expect(src).not.toContain("from './Markdown.js'")
    expect(src).not.toContain('dangerouslySetInnerHTML')
    const injected = render({
      records: [{ id: 'E1', agentId: 'a', kind: 'tool', summary: '<img src=x onerror="alert(1)">', observedAt: 1, source: 'provider_stream' }],
    })
    expect(injected).not.toContain('<img src=x')
    expect(injected).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })
})
