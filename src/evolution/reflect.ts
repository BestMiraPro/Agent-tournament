import { z } from 'zod'
import { capStrategy } from '../core/genome.js'
import type { Genome, RunConfig } from '../core/types.js'
import { parseWithRepair } from '../judge/parse.js'
import type { Provider } from '../runtime/provider.js'
import { buildReflectPrompt, type ReflectInput } from './prompts.js'
import { recombineStrategies } from './recombine.js'
import { REFLECT_JSON_SCHEMA } from './schemas.js'

const ReflectSchema = z.object({
  strategy_md: z.string(),
  notes_md: z.string().default(''),
  model_id: z.string().optional(),
  temperature: z.number().optional(),
})

export type ReflectRequest = Omit<ReflectInput, 'strategyCharCap'> & {
  currentModelId: string
  currentTemperature: number
}

export type ModelRejectionListener = (e: { agentModel: string; requested: string }) => void

export class Reflector {
  constructor(
    private provider: Provider,
    private cfg: RunConfig['reflect'],
    private allowedModels: readonly string[],
    private onModelRejected?: ModelRejectionListener,
  ) {}

  async reflect(req: ReflectRequest): Promise<Genome> {
    const prompt = buildReflectPrompt({ ...req, strategyCharCap: this.cfg.strategyCharCap })

    const fallback: Genome = {
      strategyMd: req.ownStrategy,
      notesMd: req.ownNotes,
      modelId: req.currentModelId,
      temperature: req.currentTemperature,
    }

    let parsed
    try {
      const raw = await this.provider.complete({
        purpose: 'reflect', prompt, modelId: this.cfg.modelId, schema: REFLECT_JSON_SCHEMA,
      })
      parsed = await parseWithRepair(raw, ReflectSchema, (err) =>
        this.provider.complete({
          purpose: 'reflect',
          prompt: `${prompt}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
          modelId: this.cfg.modelId,
          schema: REFLECT_JSON_SCHEMA,
        }),
      )
    } catch {
      // A failed mutation must never lose the genome — carry it forward unchanged.
      return fallback
    }

    let modelId = req.currentModelId
    if (this.cfg.allowModelMutation && parsed.model_id) {
      if (this.allowedModels.includes(parsed.model_id)) {
        modelId = parsed.model_id
      } else {
        // Silent rejection would disable model mutation invisibly.
        this.onModelRejected?.({ agentModel: req.currentModelId, requested: parsed.model_id })
      }
    }

    const temperature =
      parsed.temperature === undefined
        ? req.currentTemperature
        : Math.max(0, Math.min(1, parsed.temperature))

    const strategyMd = capStrategy(parsed.strategy_md.trim(), this.cfg.strategyCharCap)

    return {
      strategyMd: strategyMd.length > 0 ? strategyMd : req.ownStrategy,
      notesMd: parsed.notes_md,
      modelId,
      temperature,
    }
  }

  /**
   * Merges two parent strategies into one child text. WHY a passthrough on the
   * Reflector rather than provider-threading through breed: the driver holds a
   * Reflector but no provider, and recombination is a mutation-shaped task, so
   * the mutation model (this.cfg.modelId, i.e. config.reflect.modelId) is
   * structurally the right one — breed receives a bound closure and never sees
   * models or providers. Throws on failure; breed falls back to split-merge.
   */
  async recombine(
    strategyA: string,
    strategyB: string,
    goalMd: string,
  ): Promise<{ strategyMd: string; notesMd: string }> {
    const recombined = await recombineStrategies(
      this.provider,
      this.cfg.modelId,
      strategyA,
      strategyB,
      goalMd,
    )
    return {
      strategyMd: capStrategy(recombined.strategyMd, this.cfg.strategyCharCap),
      notesMd: recombined.notesMd,
    }
  }
}
