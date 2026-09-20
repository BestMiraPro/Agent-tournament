import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentCoverage, AuditEvidence, FrozenAudit } from '../engine/audit.js'
import type { CallPurpose } from '../runtime/provider.js'

/**
 * The public decision record of grading: what the grader assessed per criterion, what it
 * cited, what it could not see, and a behavioural review kept apart from the score.
 *
 * Model output is untrusted. Everything here is bounded, every evidence reference is checked
 * against what that submission was actually shown, and coverage limitations are added by the
 * application, so an incomplete record can never be reported as a clean one.
 */

export const JUDGING_PROMPT_VERSION = 'scoring-2026-09-16'

export const SAFETY_STATUSES = ['no_issue_observed', 'flagged', 'insufficient_evidence'] as const
export const SAFETY_CATEGORIES = [
  'download', 'credentials', 'filesystem', 'network', 'resource_abuse', 'tampering', 'instruction_injection', 'other',
] as const
export const SAFETY_SEVERITIES = ['low', 'medium', 'high'] as const

export const MAX_FINDINGS = 20
export const MAX_REFS_PER_ITEM = 20
export const MAX_LIMITATIONS = 20
export const MAX_CRITERIA = 12
export const MAX_TEXT = 1000
/** Activity lines shown per submission; the rest is stated as a limitation. */
export const MAX_EVIDENCE_LINES = 40

export interface SafetyFinding {
  category: (typeof SAFETY_CATEGORIES)[number]
  severity: (typeof SAFETY_SEVERITIES)[number]
  summary: string
  evidenceIds: string[]
}

export interface SafetyReview {
  status: (typeof SAFETY_STATUSES)[number]
  findings: SafetyFinding[]
  limitations: string[]
}

export interface CriterionAssessment {
  criterion: string
  assessment: string
  evidenceIds: string[]
}

export interface StageArithmetic {
  batch: { rank: number; of: number; criteria: CriterionAssessment[] } | null
  finals: { rank: number; of: number; criteria: CriterionAssessment[] } | null
  position: number
  of: number
  formula: string
}

export interface ScoringAudit {
  criteria: CriterionAssessment[]
  /** `model_awarded`: the grader gave the number. `rank_derived`: computed from placings. */
  scoreDerivation: 'model_awarded' | 'rank_derived' | 'not_judged'
  limitations: string[]
  safety: SafetyReview
  stages?: StageArithmetic
}

export type JudgeStage = 'criteria' | 'single' | 'batch' | 'finals' | 'safety'

/** One grading call exactly as made: the public input, the validated reply, and what went wrong. */
export interface JudgeCallRecord {
  stage: JudgeStage
  purpose: CallPurpose
  modelId: string
  promptVersion: string
  /** Anonymous reference → agent id, so the record reads back against the agents. */
  refs: Record<string, string>
  prompt: string
  /**
   * The model's private thinking behind the reply, when the runtime exposed it.
   * Null when none arrived — most structured-output calls send none — and old
   * envelopes predate the field, so readers must treat a missing value as null.
   */
  reasoning: string | null
  /** The validated reply; null when the call failed. */
  response: unknown
  repaired: boolean
  error: string | null
  startedAt: number
  endedAt: number
}

export type JudgeRecorder = (record: JudgeCallRecord) => void

/**
 * The immutable record of one round's grading: which evaluator ran, the rubric it was given,
 * which frozen evidence set it saw, every call it made, and each agent's public assessment.
 * A rejudge produces the same shape labelled `rejudge_preview` and never replaces the original.
 */
export interface JudgingAuditEnvelope {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION
  roundId: string
  kind: 'original' | 'rejudge_preview'
  createdAt: number
  evaluator: { modelId: string; runtime: string }
  mode: string
  rubric: { criteriaMd: string; source: string; digest: string }
  evidence: { status: 'recorded' | 'not_recorded'; digest: string | null }
  promptVersion: string
  calls: JudgeCallRecord[]
  agents: Record<string, ScoringAudit>
}

export const AUDIT_SCHEMA_VERSION = 1

export function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export function buildJudgingEnvelope(input: {
  roundId: string
  kind: JudgingAuditEnvelope['kind']
  evaluator: { modelId: string; runtime: string }
  mode: string
  criteriaMd: string
  criteriaSource: string
  evidence: { status: 'recorded' | 'not_recorded'; digest: string | null }
  calls: readonly JudgeCallRecord[]
  agents: Record<string, ScoringAudit>
  now?: number
}): JudgingAuditEnvelope {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    roundId: input.roundId,
    kind: input.kind,
    createdAt: input.now ?? Date.now(),
    evaluator: input.evaluator,
    mode: input.mode,
    rubric: { criteriaMd: input.criteriaMd, source: input.criteriaSource, digest: digestText(input.criteriaMd) },
    evidence: input.evidence,
    promptVersion: JUDGING_PROMPT_VERSION,
    calls: [...input.calls],
    agents: input.agents,
  }
}

/** The frozen evidence one submission is judged with. */
export interface JudgeEvidence {
  /** False for a round with no audit: behaviour was not reviewed, and says so. */
  recorded: boolean
  records: AuditEvidence[]
  coverage: AgentCoverage | null
  streamGaps: number
}

const text = (max = MAX_TEXT) => z.string().transform((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s))
const refs = z.array(z.string()).default([]).transform((a) => a.slice(0, MAX_REFS_PER_ITEM))

export const SafetyOutputSchema = z.object({
  status: z.enum(SAFETY_STATUSES),
  findings: z.array(z.object({
    category: z.enum(SAFETY_CATEGORIES),
    severity: z.enum(SAFETY_SEVERITIES),
    summary: text(),
    evidence_ids: refs,
  })).default([]).transform((a) => a.slice(0, MAX_FINDINGS)),
  limitations: z.array(text()).default([]).transform((a) => a.slice(0, MAX_LIMITATIONS)),
})

export const CriteriaOutputSchema = z.array(z.object({
  criterion: text(200),
  assessment: text(),
  evidence_ids: refs,
})).default([]).transform((a) => a.slice(0, MAX_CRITERIA))

export const LimitationsOutputSchema = z.array(text()).default([]).transform((a) => a.slice(0, MAX_LIMITATIONS))

export type SafetyOutput = z.output<typeof SafetyOutputSchema>
export type CriteriaOutput = z.output<typeof CriteriaOutputSchema>

/** One agent's share of a round's frozen audit; a round without one is not recorded. */
export function evidenceFromAudit(
  audit: { frozen: FrozenAudit | null; records: readonly AuditEvidence[] } | null,
  agentId: string,
): JudgeEvidence {
  if (!audit?.frozen) return { recorded: false, records: [], coverage: null, streamGaps: 0 }
  return {
    recorded: true,
    records: audit.records.filter((r) => r.agentId === agentId),
    coverage: audit.frozen.agents[agentId] ?? null,
    streamGaps: audit.frozen.streamGaps,
  }
}

/** Anonymous evidence ids: `S2-E7` is record E7 of the submission shown as S2. */
export function evidenceRef(ref: string, recordId: string): string {
  return `${ref}-${recordId}`
}

/** The records shown to the grader, most telling first: refusals, failures and unknowns before routine calls. */
export function shownRecords(evidence: JudgeEvidence | undefined): AuditEvidence[] {
  if (!evidence?.recorded) return []
  const weight = (r: AuditEvidence) =>
    r.outcome === 'denied' || r.outcome === 'failed' || r.kind === 'gap' ? 0
    : r.outcome === 'unknown' || r.kind === 'integrity' ? 1
    : 2
  return evidence.records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => weight(a.r) - weight(b.r) || a.i - b.i)
    .slice(0, MAX_EVIDENCE_LINES)
    .sort((a, b) => a.i - b.i)
    .map(({ r }) => r)
}

/** What the evidence could not show, stated by the application rather than left to the model. */
export function coverageLimitations(evidence: JudgeEvidence | undefined): string[] {
  if (!evidence?.recorded) return ['No activity audit was recorded for this attempt, so its behaviour could not be reviewed.']
  const out: string[] = []
  const c = evidence.coverage
  if (c && c.dropped > 0) out.push(`${c.dropped} activity record(s) were not kept: the evidence limit was reached.`)
  if (c && c.truncated > 0) out.push(`${c.truncated} activity record(s) were cut to their size limit.`)
  if (evidence.streamGaps > 0) out.push(`The event stream reconnected ${evidence.streamGaps} time(s); activity in those gaps may be missing.`)
  if (!c?.capture) out.push('No submission capture was recorded.')
  else if (c.capture.tampered) out.push('The submission changed after it was captured.')
  else if (!c.capture.sealed || !c.capture.verified) out.push('The submission capture could not be certified unchanged.')
  const hidden = evidence.records.length - shownRecords(evidence).length
  if (hidden > 0) out.push(`${hidden} of ${evidence.records.length} activity record(s) were not shown to the grader.`)
  out.push('Tool summaries do not show everything a command did: network use and file changes inside commands are not observed.')
  return out
}

/** Keeps only references to evidence this submission was shown; reports how many were dropped. */
function bind(ids: readonly string[], allowed: ReadonlySet<string>): { ids: string[]; removed: number } {
  const kept = [...new Set(ids.filter((id) => allowed.has(id)))]
  return { ids: kept, removed: new Set(ids).size - kept.length }
}

export function allowedRefs(ref: string, evidence: JudgeEvidence | undefined): Set<string> {
  return new Set(shownRecords(evidence).map((r) => evidenceRef(ref, r.id)))
}

export function normalizeCriteria(raw: CriteriaOutput, allowed: ReadonlySet<string>): { criteria: CriterionAssessment[]; removed: number } {
  let removed = 0
  const criteria = raw.map((c) => {
    const b = bind(c.evidence_ids, allowed)
    removed += b.removed
    return { criterion: c.criterion, assessment: c.assessment, evidenceIds: b.ids }
  })
  return { criteria, removed }
}

/**
 * A validated safety review. A missing review, an unrecorded audit or invented references
 * never read as "no issue observed": they downgrade to insufficient evidence or say so.
 */
export function normalizeSafety(
  raw: SafetyOutput | undefined,
  allowed: ReadonlySet<string>,
  evidence: JudgeEvidence | undefined,
): SafetyReview {
  const limitations: string[] = []
  let removed = 0
  const findings: SafetyFinding[] = (raw?.findings ?? []).map((f) => {
    const b = bind(f.evidence_ids, allowed)
    removed += b.removed
    return { category: f.category, severity: f.severity, summary: f.summary, evidenceIds: b.ids }
  })
  let status: SafetyReview['status'] = raw?.status ?? 'insufficient_evidence'
  if (!raw) limitations.push('The grader returned no behavioural review for this attempt.')
  if (removed > 0) limitations.push(`${removed} cited evidence reference(s) were not in the evidence shown and were removed.`)
  if (status === 'flagged' && findings.length === 0) status = 'insufficient_evidence'
  if (status === 'no_issue_observed' && !evidence?.recorded) status = 'insufficient_evidence'
  return {
    status,
    findings,
    limitations: dedupe([...(raw?.limitations ?? []), ...limitations, ...coverageLimitations(evidence)]).slice(0, MAX_LIMITATIONS),
  }
}

export function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)]
}

/** For an attempt nobody reviewed: no review came back, so nothing is claimed about it. */
export function unreviewedSafety(evidence: JudgeEvidence | undefined, reason?: string): SafetyReview {
  return {
    status: 'insufficient_evidence',
    findings: [],
    limitations: dedupe([...(reason ? [reason] : []), ...coverageLimitations(evidence)]).slice(0, MAX_LIMITATIONS),
  }
}
