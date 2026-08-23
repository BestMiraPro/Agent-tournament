import { z } from 'zod'
import { capStrategy } from '../core/genome.js'
import type { Genome, RunConfig } from '../core/types.js'
import { parseWithRepair } from '../judge/parse.js'
import type { Provider } from '../runtime/provider.js'
import { buildReflectPrompt, type ReflectInput } from './prompts.js'

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

export class Reflector {
  constructor(
    private provider: Provider,
    private cfg: RunConfig['reflect'],
    private allowedModels: readonly string[],
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
        purpose: 'reflect', prompt, modelId: this.cfg.modelId,
      })
      parsed = await parseWithRepair(raw, ReflectSchema, (err) =>
        this.provider.complete({
          purpose: 'reflect',
          prompt: `${prompt}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
          modelId: this.cfg.modelId,
        }),
      )
    } catch {
      // A failed mutation must never lose the genome — carry it forward unchanged.
      return fallback
    }

    const modelId =
      this.cfg.allowModelMutation &&
      parsed.model_id &&
      this.allowedModels.includes(parsed.model_id)
        ? parsed.model_id
        : req.currentModelId

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
}
