import { z } from 'zod'
import { makeRng } from '../core/rng.js'
import type { CriteriaSource, FileEntry, JudgeMode, RunConfig } from '../core/types.js'
import type { Provider } from '../runtime/provider.js'
import { parseWithRepair } from './parse.js'
import { buildCriteriaPrompt, buildScoringPrompt, type GradingContext } from './prompts.js'
import { CRITERIA_JSON_SCHEMA, RANKING_JSON_SCHEMA } from './schemas.js'

const RankingSchema = z.object({
  rankings: z.array(z.object({
    ref: z.string(),
    rank: z.number(),
    score: z.number(),
    rationale: z.string(),
  })),
  meta_digest: z.string().default(''),
})

const CriteriaSchema = z.object({
  criteria: z.array(z.object({
    name: z.string(),
    weight: z.number(),
    description: z.string().optional(),
  })),
})

export interface JudgeInput {
  agentId: string
  submissionMd: string
  files: FileEntry[]
  status: string
}

export interface JudgedScore {
  agentId: string
  rank: number
  score: number
  rationaleMd: string
}

export interface JudgeOutput {
  scores: JudgedScore[]
  metaDigest: string
  mode: JudgeMode
}

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

export class Judge {
  constructor(
    private provider: Provider,
    private cfg: RunConfig['judge'],
    private seed: number,
    private onWarning?: (message: string) => void,
    /** The run's context folder, named in criteria and scoring prompts. */
    private grading: GradingContext = { contextPath: null },
  ) {}

  async resolveCriteria(
    goalMd: string,
    userCriteria: string | null,
  ): Promise<{ criteriaMd: string; source: CriteriaSource }> {
    if (userCriteria && userCriteria.trim().length > 0) {
      return { criteriaMd: userCriteria, source: 'user' }
    }
    try {
      const parsed = await this.withRetry(() => this.generateCriteria(goalMd))
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

  private async generateCriteria(goalMd: string): Promise<z.output<typeof CriteriaSchema>> {
    const raw = await this.provider.complete({
      purpose: 'criteria',
      prompt: buildCriteriaPrompt(goalMd, this.grading),
      modelId: this.cfg.modelId,
      schema: CRITERIA_JSON_SCHEMA,
    })
    return parseWithRepair(raw, CriteriaSchema, (err) =>
      this.provider.complete({
        purpose: 'criteria',
        prompt: `${buildCriteriaPrompt(goalMd, this.grading)}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
        modelId: this.cfg.modelId,
        schema: CRITERIA_JSON_SCHEMA,
      }),
    )
  }

  async score(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
    roundIdx = 0,
  ): Promise<JudgeOutput> {
    const judgeable = inputs.filter((i) => i.status === 'ok' && i.submissionMd.length > 0)
    const failed = inputs.filter((i) => !judgeable.includes(i))

    if (judgeable.length === 0) {
      return {
        scores: failed.map((f, i) => ({
          agentId: f.agentId, rank: i + 1, score: 0,
          rationaleMd: 'No valid submission was produced.',
        })),
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
        result = await this.withRetry(() => this.scoreSingleCall(goalMd, criteriaMd, judgeable, roundIdx))
      } catch {
        // Spec §9: fall back to batched mode on single-call failure. One malformed reply
        // from a real judge must not kill a multi-hour run.
        mode = 'batched_finals'
        result = await this.withRetry(() => this.scoreBatched(goalMd, criteriaMd, judgeable, roundIdx))
      }
    } else {
      result = await this.withRetry(() => this.scoreBatched(goalMd, criteriaMd, judgeable, roundIdx))
    }

    // Failed submissions never enter the judge's context; they are appended last.
    const scores = [
      ...result.scores,
      ...failed.map((f, i) => ({
        agentId: f.agentId,
        rank: result.scores.length + i + 1,
        score: 0,
        rationaleMd: 'No valid submission was produced.',
      })),
    ]

    return { scores, metaDigest: result.metaDigest, mode }
  }

  private async callJudge(prompt: string) {
    const raw = await this.provider.complete({
      purpose: 'judge', prompt, modelId: this.cfg.modelId, schema: RANKING_JSON_SCHEMA,
    })
    return parseWithRepair(raw, RankingSchema, (err) =>
      this.provider.complete({
        purpose: 'judge',
        prompt: `${prompt}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
        modelId: this.cfg.modelId,
        schema: RANKING_JSON_SCHEMA,
      }),
    )
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

  private async scoreSingleCall(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
    roundIdx: number,
  ) {
    const { anon, byRef } = this.anonymize(inputs, roundIdx)
    const parsed = await this.callJudge(
      buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap, this.grading),
    )
    return {
      scores: this.deanonymize(parsed.rankings, byRef),
      metaDigest: parsed.meta_digest,
    }
  }

  /** Rank within batches, then rank the batch winners; non-finalists interpolate. */
  private async scoreBatched(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
    roundIdx: number,
  ) {
    const rng = makeRng(this.seed)
    const shuffled = rng.shuffle(inputs)
    const batches: JudgeInput[][] = []
    for (let i = 0; i < shuffled.length; i += this.cfg.batchSize) {
      batches.push(shuffled.slice(i, i + this.cfg.batchSize))
    }

    const placings = new Map<string, { rank: number; rationale: string }>()
    const winners: JudgeInput[] = []
    let batchDigest = ''

    for (const batch of batches) {
      const { anon, byRef } = this.anonymize(batch, roundIdx)
      const parsed = await this.callJudge(
        buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap, this.grading),
      )
      batchDigest ||= parsed.meta_digest
      const placed = this.resolveRankings(parsed.rankings, byRef)
      for (const [agentId, entry] of placed) placings.set(agentId, entry)
      // The BEST-ranked entry, not the one numbered 1. A model that numbers from 2
      // otherwise contributed no winner at all, and every agent in the batch was
      // ordered behind every finalist however good its submission was.
      const best = [...placed.entries()].sort((a, b) => a[1].rank - b[1].rank)[0]
      const winner = best && batch.find((b) => b.agentId === best[0])
      if (winner) winners.push(winner)
    }

    const finalsOrder = new Map<string, { rank: number; rationale: string }>()
    // Only a real finals call (winners.length > 1) produces a finals digest; the
    // degenerate single-winner case below never talks to the judge, so there is
    // no finals digest to prefer and scoreBatched must fall back to the batch one.
    let finalsDigest = ''
    if (winners.length > 1) {
      const { anon, byRef } = this.anonymize(winners, roundIdx)
      const parsed = await this.callJudge(
        buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap, this.grading),
      )
      finalsDigest = parsed.meta_digest
      for (const [agentId, entry] of this.resolveRankings(parsed.rankings, byRef)) {
        finalsOrder.set(agentId, entry)
      }
    } else if (winners[0]) {
      finalsOrder.set(winners[0].agentId, {
        rank: 1,
        rationale: placings.get(winners[0].agentId)?.rationale ?? '',
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
      scores: ordered.map((inp, i) => ({
        agentId: inp.agentId,
        rank: i + 1,
        // A submission no call ever ranked scores 0, exactly as the single-call path
        // treats it. The positional score is only a stand-in for a judgement that was
        // actually made; handing one to an unjudged agent invents a verdict, and a
        // middling invented score is enough to keep it out of the cull band and breed it.
        score: placings.has(inp.agentId) || finalsOrder.has(inp.agentId)
          ? Math.round(((n - i) / n) * 100 * 100) / 100
          : 0,
        // Prefer the finals rationale for agents who reached the finals round; fall
        // back to their batch rationale otherwise. Only a judge response that omits
        // an agent's ref from every call it appeared in (malformed output) falls
        // through to the generic placement string.
        rationaleMd:
          finalsOrder.get(inp.agentId)?.rationale ||
          placings.get(inp.agentId)?.rationale ||
          (placings.has(inp.agentId) || finalsOrder.has(inp.agentId)
            ? `Placed ${i + 1} of ${n} across batch and finals ranking.`
            : NO_RANKING_MD),
      })),
      // The finals digest describes the models that actually competed for the top
      // places, so it is preferred; fall back to a batch digest only when there was
      // no finals round (population fit in a single batch).
      metaDigest: finalsDigest || batchDigest,
    }
  }

  private anonymize(inputs: readonly JudgeInput[], roundIdx: number) {
    // Round index must participate: population size is invariant, so seeding on it alone
    // produced the same permutation every round and turned judge position bias into a
    // persistent per-agent fitness bonus.
    const rng = makeRng(this.seed + roundIdx * 7919 + inputs.length)
    const order = this.cfg.anonymize ? rng.shuffle(inputs) : [...inputs]
    const byRef = new Map<string, string>()
    const anon = order.map((inp, i) => {
      const ref = `S${i + 1}`
      byRef.set(ref, inp.agentId)
      return { ref, submissionMd: inp.submissionMd, files: inp.files }
    })
    return { anon, byRef }
  }

  /**
   * Maps the model's rankings back to real agent IDs. The model's output is untrusted:
   * it may omit a ref it was shown, duplicate a ref, or return a ref it was never shown.
   * This must never let an agent silently vanish or be scored twice, and must never
   * fabricate an agent that was never in byRef.
   */
  /**
   * Turns one judge response into agent placings, applying the same rules as
   * `deanonymize`: a ref is taken once (first occurrence), and a ref the judge was never
   * shown is dropped rather than fabricating an agent. The batched path used to skip
   * both checks, so a repeated ref silently replaced a real placing with a later one.
   */
  private resolveRankings(
    rankings: { ref: string; rank: number; rationale: string }[],
    byRef: Map<string, string>,
  ): Map<string, { rank: number; rationale: string }> {
    const seenRefs = new Set<string>()
    const placed = new Map<string, { rank: number; rationale: string }>()
    for (const r of rankings) {
      if (seenRefs.has(r.ref)) continue
      seenRefs.add(r.ref)
      const agentId = byRef.get(r.ref)
      if (!agentId) continue
      placed.set(agentId, { rank: r.rank, rationale: r.rationale })
    }
    return placed
  }

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
