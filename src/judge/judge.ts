import { z } from 'zod'
import { makeRng } from '../core/rng.js'
import type { CriteriaSource, FileEntry, JudgeMode, RunConfig } from '../core/types.js'
import type { CallPurpose, Provider } from '../runtime/provider.js'
import {
  CriteriaOutputSchema,
  JUDGING_PROMPT_VERSION,
  LimitationsOutputSchema,
  SafetyOutputSchema,
  allowedRefs,
  dedupe,
  normalizeCriteria,
  normalizeSafety,
  unreviewedSafety,
  type JudgeEvidence,
  type JudgeRecorder,
  type JudgeStage,
  type SafetyReview,
  type ScoringAudit,
} from './audit.js'
import { parseWithRepair } from './parse.js'
import { buildCriteriaPrompt, buildSafetyReviewPrompt, buildScoringPrompt, type GradingContext } from './prompts.js'
import { CRITERIA_JSON_SCHEMA, RANKING_JSON_SCHEMA, SAFETY_BATCH_JSON_SCHEMA } from './schemas.js'

/**
 * Scores must be finite and in range, and ranks positive integers, or the reply is invalid and
 * goes through the bounded repair path; the assessment fields default so a model without
 * structured output still parses, and a missing review is reported rather than assumed clean.
 */
const RankingEntrySchema = z.object({
  ref: z.string(),
  rank: z.number().int().min(1),
  score: z.number().finite().min(0).max(100),
  rationale: z.string(),
  criteria: CriteriaOutputSchema,
  limitations: LimitationsOutputSchema,
  safety: SafetyOutputSchema.optional(),
})
type RankingEntry = z.output<typeof RankingEntrySchema>

const RankingSchema = z.object({
  rankings: z.array(RankingEntrySchema),
  meta_digest: z.string().default(''),
})

const CriteriaSchema = z.object({
  criteria: z.array(z.object({
    name: z.string(),
    weight: z.number(),
    description: z.string().optional(),
  })),
})

const SafetyBatchSchema = z.object({
  reviews: z.array(z.object({ ref: z.string(), safety: SafetyOutputSchema })),
})

export interface JudgeInput {
  agentId: string
  submissionMd: string
  files: FileEntry[]
  status: string
  /** The round's frozen activity for this agent; absent when no audit was recorded. */
  evidence?: JudgeEvidence
}

export interface JudgedScore {
  agentId: string
  rank: number
  score: number
  rationaleMd: string
  /** Criterion assessments, limitations, behavioural review and how the score was derived. */
  audit?: ScoringAudit
}

export interface JudgeOutput {
  scores: JudgedScore[]
  metaDigest: string
  mode: JudgeMode
}

export type { JudgeCallRecord, JudgeRecorder, JudgeStage } from './audit.js'

/**
 * Goal-agnostic default criteria used only when live criteria generation fails
 * after retries. Same `- **name** (weight N): description` shape resolveCriteria
 * otherwise produces from a model's response, so downstream prompt-building code
 * cannot tell the difference. Judging on this instead of goal-specific criteria is
 * a real quality loss — see the `onWarning` callback below.
 */
export const FALLBACK_CRITERIA_MD = [
  '- **correctness** (weight 0.4): The work is accurate and free of errors relative to the stated goal.',
  '- **completeness** (weight 0.2): The work fully addresses the goal, leaving no required part undone.',
  '- **clarity** (weight 0.2): The work is clearly organized and easy to understand.',
  '- **goal adherence** (weight 0.2): The work stays faithful and directly responsive to the stated goal, without drifting into unrelated scope.',
].join('\n')

/**
 * Shared by both scoring paths, so "the judge never ranked this" reads identically
 * whether the population fit in one call or was split across batches.
 */
const NO_RANKING_MD = 'The judge returned no ranking for this submission.'

/** Failed attempts reviewed per call: bounded, and never one call per attempt. */
const REVIEW_BATCH = 10

type Placing = { rank: number; rationale: string; entry: RankingEntry; ref: string }

export class Judge {
  constructor(
    private provider: Provider,
    private cfg: RunConfig['judge'],
    private seed: number,
    private onWarning?: (message: string) => void,
    /** The run's context folder, named in criteria and scoring prompts. */
    private grading: GradingContext = { contextPath: null },
  ) {}

  /** What actually graded: the configured model and the runtime that answered, for the record. */
  evaluator(): { modelId: string; runtime: string } {
    return { modelId: this.cfg.modelId, runtime: this.provider.describe?.() ?? 'unknown' }
  }

  async resolveCriteria(
    goalMd: string,
    userCriteria: string | null,
    recorder?: JudgeRecorder,
  ): Promise<{ criteriaMd: string; source: CriteriaSource }> {
    if (userCriteria && userCriteria.trim().length > 0) {
      return { criteriaMd: userCriteria, source: 'user' }
    }
    try {
      const parsed = await this.withRetry(() => this.call({
        purpose: 'criteria', stage: 'criteria',
        prompt: buildCriteriaPrompt(goalMd, this.grading), schema: CRITERIA_JSON_SCHEMA, parser: CriteriaSchema,
      }, recorder))
      const criteriaMd = parsed.criteria
        .map((c) => `- **${c.name}** (weight ${c.weight})${c.description ? `: ${c.description}` : ''}`)
        .join('\n')
      return { criteriaMd, source: 'generated' }
    } catch (e) {
      // Mirrors Judge.score's single-call-to-batched fallback (spec §9): one bad
      // reply from the criteria model must not kill the round, and resolveCriteria
      // runs before scoring, so it would kill the round even earlier than that.
      // Falling back silently would be worse than throwing, though — judging on
      // generic criteria instead of goal-specific ones is a real quality loss, so
      // it must be visible via onWarning rather than pass unnoticed.
      const detail = e instanceof Error ? e.message : String(e)
      this.onWarning?.(
        `Judge.resolveCriteria: criteria generation failed after retries (${detail}); falling back to default criteria.`,
      )
      return { criteriaMd: FALLBACK_CRITERIA_MD, source: 'generated' }
    }
  }

  async score(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
    roundIdx = 0,
    recorder?: JudgeRecorder,
  ): Promise<JudgeOutput> {
    const judgeable = inputs.filter((i) => i.status === 'ok' && i.submissionMd.length > 0)
    const failed = inputs.filter((i) => !judgeable.includes(i))

    // Failed attempts are reviewed for behaviour too: nothing to grade is not nothing to see.
    const reviews = await this.reviewAttempts(goalMd, failed, roundIdx, recorder)
    const failedScore = (f: JudgeInput, rank: number): JudgedScore => ({
      agentId: f.agentId, rank, score: 0,
      rationaleMd: 'No valid submission was produced.',
      audit: {
        criteria: [],
        scoreDerivation: 'not_judged',
        limitations: ['No valid submission was produced, so nothing was graded.'],
        safety: reviews.get(f.agentId)
          ?? unreviewedSafety(f.evidence, f.evidence?.recorded ? 'The behavioural review returned nothing for this attempt.' : undefined),
      },
    })

    if (judgeable.length === 0) {
      return {
        scores: failed.map((f, i) => failedScore(f, i + 1)),
        metaDigest: 'No agent produced a valid submission this round.',
        mode: 'single_call',
      }
    }

    const chosen: JudgeMode =
      this.cfg.mode === 'auto'
        ? (judgeable.length <= this.cfg.singleCallMaxPopulation ? 'single_call' : 'batched_finals')
        : this.cfg.mode

    let mode = chosen
    let result: { scores: JudgedScore[]; metaDigest: string }

    if (chosen === 'single_call') {
      try {
        result = await this.withRetry(() => this.scoreSingleCall(goalMd, criteriaMd, judgeable, roundIdx, recorder))
      } catch {
        // Spec §9: fall back to batched mode on single-call failure. One malformed reply
        // from a real judge must not kill a multi-hour run.
        mode = 'batched_finals'
        result = await this.withRetry(() => this.scoreBatched(goalMd, criteriaMd, judgeable, roundIdx, recorder))
      }
    } else {
      result = await this.withRetry(() => this.scoreBatched(goalMd, criteriaMd, judgeable, roundIdx, recorder))
    }

    // Failed submissions never enter the scoring context; they are appended last.
    const scores = [
      ...result.scores,
      ...failed.map((f, i) => failedScore(f, result.scores.length + i + 1)),
    ]

    return { scores, metaDigest: result.metaDigest, mode }
  }

  /** Text plus reasoning trace, preferring the rich path when the runtime exposes one. */
  private async completeRich(req: { purpose: CallPurpose; prompt: string; schema: unknown }): Promise<{ text: string; reasoning: string | null }> {
    if (typeof this.provider.completeRich === 'function') {
      return this.provider.completeRich({
        purpose: req.purpose, prompt: req.prompt, modelId: this.cfg.modelId, schema: req.schema,
      })
    }
    return {
      text: await this.provider.complete({
        purpose: req.purpose, prompt: req.prompt, modelId: this.cfg.modelId, schema: req.schema,
      }),
      reasoning: null,
    }
  }

  /** One model call with its bounded repair, recorded whether it succeeds or fails. */
  private async call<S extends z.ZodTypeAny>(
    req: { purpose: CallPurpose; stage: JudgeStage; prompt: string; schema: unknown; parser: S; refs?: ReadonlyMap<string, string> },
    recorder?: JudgeRecorder,
  ): Promise<z.output<S>> {
    const startedAt = Date.now()
    let repaired = false
    // The trace behind the reply that finally validated: the repair call's when repaired.
    let reasoning: string | null = null
    const record = (response: unknown, error: string | null) => {
      try {
        recorder?.({
          stage: req.stage, purpose: req.purpose, modelId: this.cfg.modelId, promptVersion: JUDGING_PROMPT_VERSION,
          refs: Object.fromEntries(req.refs ?? []), prompt: req.prompt, reasoning, response, repaired, error,
          startedAt, endedAt: Date.now(),
        })
      } catch {
        /* recording must never fail grading */
      }
    }
    try {
      const first = await this.completeRich({
        purpose: req.purpose, prompt: req.prompt, schema: req.schema,
      })
      reasoning = first.reasoning
      const value = await parseWithRepair(first.text, req.parser, async (err) => {
        repaired = true
        const retry = await this.completeRich({
          purpose: req.purpose,
          prompt: `${req.prompt}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
          schema: req.schema,
        })
        reasoning = retry.reasoning
        return retry.text
      })
      record(value, null)
      return value
    } catch (e) {
      record(null, e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /** Spec §15: two retries before giving up on a judging strategy. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn()
      } catch (e) {
        lastError = e
      }
    }
    throw lastError
  }

  /**
   * Behavioural review of attempts with nothing to grade, in bounded batches. A failed review
   * call never fails the round: its attempts are reported unreviewed instead.
   */
  private async reviewAttempts(
    goalMd: string,
    failed: readonly JudgeInput[],
    roundIdx: number,
    recorder?: JudgeRecorder,
  ): Promise<Map<string, SafetyReview>> {
    const out = new Map<string, SafetyReview>()
    const reviewable = failed.filter((f) => f.evidence?.recorded)
    for (let i = 0; i < reviewable.length; i += REVIEW_BATCH) {
      const chunk = reviewable.slice(i, i + REVIEW_BATCH)
      const { anon, byRef } = this.anonymize(chunk, roundIdx, 'F')
      try {
        const parsed = await this.call({
          purpose: 'review', stage: 'safety',
          prompt: buildSafetyReviewPrompt(goalMd, anon.map((a) => ({ ref: a.ref, status: a.status, evidence: a.evidence })), this.grading),
          schema: SAFETY_BATCH_JSON_SCHEMA, parser: SafetyBatchSchema, refs: byRef,
        }, recorder)
        const seen = new Set<string>()
        for (const r of parsed.reviews) {
          const agentId = byRef.get(r.ref)
          if (!agentId || seen.has(r.ref)) continue
          seen.add(r.ref)
          const evidence = chunk.find((c) => c.agentId === agentId)?.evidence
          out.set(agentId, normalizeSafety(r.safety, allowedRefs(r.ref, evidence), evidence))
        }
      } catch (e) {
        this.onWarning?.(
          `Judge: the behavioural review of ${chunk.length} failed attempt(s) failed (${e instanceof Error ? e.message : String(e)}); they are reported unreviewed.`,
        )
      }
    }
    return out
  }

  /** A ranking entry's public assessment, with its references held to that submission's evidence. */
  private assess(entry: RankingEntry, ref: string, evidence: JudgeEvidence | undefined, derivation: ScoringAudit['scoreDerivation']): ScoringAudit {
    const allowed = allowedRefs(ref, evidence)
    const criteria = normalizeCriteria(entry.criteria, allowed)
    return {
      criteria: criteria.criteria,
      scoreDerivation: derivation,
      limitations: dedupe([
        ...entry.limitations,
        ...(criteria.removed > 0 ? [`${criteria.removed} cited evidence reference(s) were not in the evidence shown and were removed.`] : []),
      ]),
      safety: normalizeSafety(entry.safety, allowed, evidence),
    }
  }

  private async scoreSingleCall(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
    roundIdx: number,
    recorder?: JudgeRecorder,
  ) {
    const { anon, byRef } = this.anonymize(inputs, roundIdx)
    const parsed = await this.call({
      purpose: 'judge', stage: 'single',
      prompt: buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap, this.grading),
      schema: RANKING_JSON_SCHEMA, parser: RankingSchema, refs: byRef,
    }, recorder)
    const placed = this.resolveRankings(parsed.rankings, byRef)
    const evidenceOf = new Map(inputs.map((i) => [i.agentId, i.evidence]))
    return {
      scores: this.deanonymize(parsed.rankings, byRef).map((s): JudgedScore => {
        const p = placed.get(s.agentId)
        const evidence = evidenceOf.get(s.agentId)
        return {
          ...s,
          audit: p
            ? this.assess(p.entry, p.ref, evidence, 'model_awarded')
            : { criteria: [], scoreDerivation: 'not_judged', limitations: [NO_RANKING_MD], safety: unreviewedSafety(evidence, NO_RANKING_MD) },
        }
      }),
      metaDigest: parsed.meta_digest,
    }
  }

  /** Rank within batches, then rank the batch winners; non-finalists interpolate. */
  private async scoreBatched(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
    roundIdx: number,
    recorder?: JudgeRecorder,
  ) {
    const rng = makeRng(this.seed)
    const shuffled = rng.shuffle(inputs)
    const batches: JudgeInput[][] = []
    for (let i = 0; i < shuffled.length; i += this.cfg.batchSize) {
      batches.push(shuffled.slice(i, i + this.cfg.batchSize))
    }

    const placings = new Map<string, Placing & { of: number }>()
    const winners: JudgeInput[] = []
    let batchDigest = ''

    for (const batch of batches) {
      const { anon, byRef } = this.anonymize(batch, roundIdx)
      const parsed = await this.call({
        purpose: 'judge', stage: 'batch',
        prompt: buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap, this.grading),
        schema: RANKING_JSON_SCHEMA, parser: RankingSchema, refs: byRef,
      }, recorder)
      batchDigest ||= parsed.meta_digest
      const placed = this.resolveRankings(parsed.rankings, byRef)
      for (const [agentId, entry] of placed) placings.set(agentId, { ...entry, of: batch.length })
      // The BEST-ranked entry, not the one numbered 1. A model that numbers from 2
      // otherwise contributed no winner at all, and every agent in the batch was
      // ordered behind every finalist however good its submission was.
      const best = [...placed.entries()].sort((a, b) => a[1].rank - b[1].rank)[0]
      const winner = best && batch.find((b) => b.agentId === best[0])
      if (winner) winners.push(winner)
    }

    const finalsOrder = new Map<string, { rank: number; rationale: string; placing: (Placing & { of: number }) | null }>()
    // Only a real finals call (winners.length > 1) produces a finals digest; the
    // degenerate single-winner case below never talks to the judge, so there is
    // no finals digest to prefer and scoreBatched must fall back to the batch one.
    let finalsDigest = ''
    if (winners.length > 1) {
      const { anon, byRef } = this.anonymize(winners, roundIdx)
      const parsed = await this.call({
        purpose: 'judge', stage: 'finals',
        prompt: buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap, this.grading),
        schema: RANKING_JSON_SCHEMA, parser: RankingSchema, refs: byRef,
      }, recorder)
      finalsDigest = parsed.meta_digest
      for (const [agentId, entry] of this.resolveRankings(parsed.rankings, byRef)) {
        finalsOrder.set(agentId, { rank: entry.rank, rationale: entry.rationale, placing: { ...entry, of: winners.length } })
      }
    } else if (winners[0]) {
      finalsOrder.set(winners[0].agentId, {
        rank: 1,
        rationale: placings.get(winners[0].agentId)?.rationale ?? '',
        placing: null,
      })
    }

    // Finalists first by their finals rank, then everyone else by batch placing.
    const ordered = [...inputs].sort((a, b) => {
      const fa = finalsOrder.get(a.agentId)?.rank ?? Infinity
      const fb = finalsOrder.get(b.agentId)?.rank ?? Infinity
      if (fa !== fb) return fa - fb
      return (placings.get(a.agentId)?.rank ?? 99) - (placings.get(b.agentId)?.rank ?? 99)
    })

    const n = ordered.length
    return {
      scores: ordered.map((inp, i): JudgedScore => {
        const batch = placings.get(inp.agentId)
        const finals = finalsOrder.get(inp.agentId)
        const judged = batch !== undefined || finals !== undefined
        // A submission no call ever ranked scores 0, exactly as the single-call path
        // treats it. The positional score is only a stand-in for a judgement that was
        // actually made; handing one to an unjudged agent invents a verdict, and a
        // middling invented score is enough to keep it out of the cull band and breed it.
        const score = judged ? Math.round(((n - i) / n) * 100 * 100) / 100 : 0
        const batchAudit = batch ? this.assess(batch.entry, batch.ref, inp.evidence, 'rank_derived') : null
        const finalsAudit = finals?.placing ? this.assess(finals.placing.entry, finals.placing.ref, inp.evidence, 'rank_derived') : null
        return {
          agentId: inp.agentId,
          rank: i + 1,
          score,
          // Prefer the finals rationale for agents who reached the finals round; fall
          // back to their batch rationale otherwise. Only a judge response that omits
          // an agent's ref from every call it appeared in (malformed output) falls
          // through to the generic placement string.
          rationaleMd:
            finals?.rationale ||
            batch?.rationale ||
            (judged ? `Placed ${i + 1} of ${n} across batch and finals ranking.` : NO_RANKING_MD),
          // A positional score is not a weighted rubric score: the record says which it is
          // and shows the placings and arithmetic behind the number.
          audit: {
            criteria: (finalsAudit ?? batchAudit)?.criteria ?? [],
            scoreDerivation: judged ? 'rank_derived' : 'not_judged',
            limitations: dedupe([
              ...(batchAudit?.limitations ?? []),
              ...(finalsAudit?.limitations ?? []),
              ...(judged ? [] : [NO_RANKING_MD]),
            ]),
            safety: batchAudit?.safety ?? finalsAudit?.safety ?? unreviewedSafety(inp.evidence, NO_RANKING_MD),
            stages: {
              batch: batch && batchAudit ? { rank: batch.rank, of: batch.of, criteria: batchAudit.criteria } : null,
              finals: finals?.placing && finalsAudit ? { rank: finals.placing.rank, of: finals.placing.of, criteria: finalsAudit.criteria } : null,
              position: i + 1,
              of: n,
              formula: judged ? `round((${n} - ${i}) / ${n} × 100, 2) = ${score}` : 'Not ranked by any grading call: 0',
            },
          },
        }
      }),
      // The finals digest describes the models that actually competed for the top
      // places, so it is preferred; fall back to a batch digest only when there was
      // no finals round (population fit in a single batch).
      metaDigest: finalsDigest || batchDigest,
    }
  }

  private anonymize(inputs: readonly JudgeInput[], roundIdx: number, prefix = 'S') {
    // Round index must participate: population size is invariant, so seeding on it alone
    // produced the same permutation every round and turned judge position bias into a
    // persistent per-agent fitness bonus.
    const rng = makeRng(this.seed + roundIdx * 7919 + inputs.length)
    const order = this.cfg.anonymize ? rng.shuffle(inputs) : [...inputs]
    const byRef = new Map<string, string>()
    const anon = order.map((inp, i) => {
      const ref = `${prefix}${i + 1}`
      byRef.set(ref, inp.agentId)
      return { ref, submissionMd: inp.submissionMd, files: inp.files, status: inp.status, evidence: inp.evidence }
    })
    return { anon, byRef }
  }

  /**
   * Turns one judge response into agent placings, applying the same rules as
   * `deanonymize`: a ref is taken once (first occurrence), and a ref the judge was never
   * shown is dropped rather than fabricating an agent. The batched path used to skip
   * both checks, so a repeated ref silently replaced a real placing with a later one.
   */
  private resolveRankings(rankings: RankingEntry[], byRef: Map<string, string>): Map<string, Placing> {
    const seenRefs = new Set<string>()
    const placed = new Map<string, Placing>()
    for (const r of rankings) {
      if (seenRefs.has(r.ref)) continue
      seenRefs.add(r.ref)
      const agentId = byRef.get(r.ref)
      if (!agentId) continue
      placed.set(agentId, { rank: r.rank, rationale: r.rationale, entry: r, ref: r.ref })
    }
    return placed
  }

  /**
   * Maps the model's rankings back to real agent IDs. The model's output is untrusted:
   * it may omit a ref it was shown, duplicate a ref, or return a ref it was never shown.
   * This must never let an agent silently vanish or be scored twice, and must never
   * fabricate an agent that was never in byRef.
   */
  private deanonymize(
    rankings: { ref: string; rank: number; score: number; rationale: string }[],
    byRef: Map<string, string>,
  ): JudgedScore[] {
    const seenRefs = new Set<string>()
    const scoredByAgentId = new Map<string, JudgedScore>()

    for (const r of rankings) {
      if (seenRefs.has(r.ref)) continue // duplicate ref: keep only the first occurrence
      seenRefs.add(r.ref)
      const agentId = byRef.get(r.ref)
      if (!agentId) continue // ref never shown to the judge: ignore, don't fabricate an agent
      scoredByAgentId.set(agentId, { agentId, rank: r.rank, score: r.score, rationaleMd: r.rationale })
    }

    // Any agent shown to the judge but never mentioned in its response still gets a
    // result — appended last with score 0 — rather than silently disappearing.
    for (const agentId of byRef.values()) {
      if (!scoredByAgentId.has(agentId)) {
        scoredByAgentId.set(agentId, {
          agentId,
          rank: Number.MAX_SAFE_INTEGER,
          score: 0,
          rationaleMd: NO_RANKING_MD,
        })
      }
    }

    return [...scoredByAgentId.values()]
      .sort((a, b) => a.rank - b.rank)
      .map((s, i) => ({ ...s, rank: i + 1 }))
  }
}
