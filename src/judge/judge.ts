import { z } from 'zod'
import { makeRng } from '../core/rng.js'
import type { CriteriaSource, FileEntry, JudgeMode, RunConfig } from '../core/types.js'
import type { Provider } from '../runtime/provider.js'
import { parseWithRepair } from './parse.js'
import { buildCriteriaPrompt, buildScoringPrompt } from './prompts.js'

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

export class Judge {
  constructor(
    private provider: Provider,
    private cfg: RunConfig['judge'],
    private seed: number,
  ) {}

  async resolveCriteria(
    goalMd: string,
    userCriteria: string | null,
  ): Promise<{ criteriaMd: string; source: CriteriaSource }> {
    if (userCriteria && userCriteria.trim().length > 0) {
      return { criteriaMd: userCriteria, source: 'user' }
    }
    const raw = await this.provider.complete({
      purpose: 'criteria',
      prompt: buildCriteriaPrompt(goalMd),
      modelId: this.cfg.modelId,
    })
    const parsed = await parseWithRepair(raw, CriteriaSchema, (err) =>
      this.provider.complete({
        purpose: 'criteria',
        prompt: `${buildCriteriaPrompt(goalMd)}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
        modelId: this.cfg.modelId,
      }),
    )
    const criteriaMd = parsed.criteria
      .map((c) => `- **${c.name}** (weight ${c.weight})${c.description ? `: ${c.description}` : ''}`)
      .join('\n')
    return { criteriaMd, source: 'generated' }
  }

  async score(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
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

    const mode: JudgeMode =
      this.cfg.mode === 'auto'
        ? (judgeable.length <= this.cfg.singleCallMaxPopulation ? 'single_call' : 'batched_finals')
        : this.cfg.mode

    const result = mode === 'single_call'
      ? await this.scoreSingleCall(goalMd, criteriaMd, judgeable)
      : await this.scoreBatched(goalMd, criteriaMd, judgeable)

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
      purpose: 'judge', prompt, modelId: this.cfg.modelId,
    })
    return parseWithRepair(raw, RankingSchema, (err) =>
      this.provider.complete({
        purpose: 'judge',
        prompt: `${prompt}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
        modelId: this.cfg.modelId,
      }),
    )
  }

  private async scoreSingleCall(goalMd: string, criteriaMd: string, inputs: readonly JudgeInput[]) {
    const { anon, byRef } = this.anonymize(inputs)
    const parsed = await this.callJudge(
      buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap),
    )
    return {
      scores: this.deanonymize(parsed.rankings, byRef),
      metaDigest: parsed.meta_digest,
    }
  }

  /** Rank within batches, then rank the batch winners; non-finalists interpolate. */
  private async scoreBatched(goalMd: string, criteriaMd: string, inputs: readonly JudgeInput[]) {
    const rng = makeRng(this.seed)
    const shuffled = rng.shuffle(inputs)
    const batches: JudgeInput[][] = []
    for (let i = 0; i < shuffled.length; i += this.cfg.batchSize) {
      batches.push(shuffled.slice(i, i + this.cfg.batchSize))
    }

    const placings = new Map<string, number>()
    const winners: JudgeInput[] = []
    let digest = ''

    for (const batch of batches) {
      const { anon, byRef } = this.anonymize(batch)
      const parsed = await this.callJudge(
        buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap),
      )
      digest ||= parsed.meta_digest
      for (const r of parsed.rankings) {
        const agentId = byRef.get(r.ref)
        if (agentId) placings.set(agentId, r.rank)
      }
      const top = parsed.rankings.find((r) => r.rank === 1)
      const winnerId = top ? byRef.get(top.ref) : undefined
      const winner = batch.find((b) => b.agentId === winnerId)
      if (winner) winners.push(winner)
    }

    const finalsOrder = new Map<string, number>()
    if (winners.length > 1) {
      const { anon, byRef } = this.anonymize(winners)
      const parsed = await this.callJudge(
        buildScoringPrompt(goalMd, criteriaMd, anon, this.cfg.submissionCharCap),
      )
      for (const r of parsed.rankings) {
        const agentId = byRef.get(r.ref)
        if (agentId) finalsOrder.set(agentId, r.rank)
      }
    } else if (winners[0]) {
      finalsOrder.set(winners[0].agentId, 1)
    }

    // Finalists first by their finals rank, then everyone else by batch placing.
    const ordered = [...inputs].sort((a, b) => {
      const fa = finalsOrder.get(a.agentId) ?? Infinity
      const fb = finalsOrder.get(b.agentId) ?? Infinity
      if (fa !== fb) return fa - fb
      return (placings.get(a.agentId) ?? 99) - (placings.get(b.agentId) ?? 99)
    })

    const n = ordered.length
    return {
      scores: ordered.map((inp, i) => ({
        agentId: inp.agentId,
        rank: i + 1,
        score: Math.round(((n - i) / n) * 100 * 100) / 100,
        rationaleMd: `Placed ${i + 1} of ${n} across batch and finals ranking.`,
      })),
      metaDigest: digest,
    }
  }

  private anonymize(inputs: readonly JudgeInput[]) {
    const rng = makeRng(this.seed + inputs.length)
    const order = this.cfg.anonymize ? rng.shuffle(inputs) : [...inputs]
    const byRef = new Map<string, string>()
    const anon = order.map((inp, i) => {
      const ref = `S${i + 1}`
      byRef.set(ref, inp.agentId)
      return { ref, submissionMd: inp.submissionMd, files: inp.files }
    })
    return { anon, byRef }
  }

  private deanonymize(
    rankings: { ref: string; rank: number; score: number; rationale: string }[],
    byRef: Map<string, string>,
  ): JudgedScore[] {
    return rankings
      .flatMap((r) => {
        const agentId = byRef.get(r.ref)
        return agentId ? [{ agentId, rank: r.rank, score: r.score, rationaleMd: r.rationale }] : []
      })
      .sort((a, b) => a.rank - b.rank)
      .map((s, i) => ({ ...s, rank: i + 1 }))
  }
}
