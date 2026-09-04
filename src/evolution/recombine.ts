import { z } from 'zod'
import { parseWithRepair } from '../judge/parse.js'
import type { Provider } from '../runtime/provider.js'

/**
 * Strict shape for the recombine call. Strategy + notes only: unlike reflection
 * there is no model/temperature proposal — the child keeps A's model and
 * temperature verbatim (4d §7.2 parentage rules), so accepting model fields here
 * would only invite output the caller is contractually bound to ignore.
 */
export const RECOMBINE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    strategy_md: { type: 'string' },
    notes_md: { type: 'string' },
  },
  required: ['strategy_md', 'notes_md'],
  additionalProperties: false,
} as const

const RecombineSchema = z.object({
  strategy_md: z.string(),
  notes_md: z.string().default(''),
})

export function buildRecombinePrompt(strategyA: string, strategyB: string, goalMd: string): string {
  return [
    'You are an agent competing in an evolutionary tournament.',
    'Two strategies competed. Combine them into one stronger strategy for the goal below.',
    '',
    `PARENT A STRATEGY: ${strategyA}`,
    '',
    `PARENT B STRATEGY: ${strategyB}`,
    '',
    'GOAL:',
    goalMd,
    '',
    'Rewrite the two parents as a single strategy. Keep what works from each parent; drop what does not.',
    'Update the notes with anything worth remembering about the combination.',
    '',
    'Respond with JSON only, in exactly this shape:',
    '{"strategy_md":"...","notes_md":"..."}',
  ].join('\n')
}

/**
 * ONE structured LLM call merging two parent strategies. Mirrors
 * Reflector.reflect's call pattern exactly (single attempt + parseWithRepair's
 * single repair re-prompt): recombination is a mutation-shaped task, so it gets
 * the mutation retry budget, not the judge's three-attempt withRetry.
 *
 * WHY purpose 'reflect': the purpose only labels the provider session — the
 * model and schema do the real work — and MockProvider serves 'reflect' with
 * valid JSON, so mock rounds recombine without any new test wiring.
 *
 * Throws on provider failure, unrepairable output, or an empty strategy: the
 * caller (breed) catches everything and falls back to deterministic split-merge,
 * so a crossover slot NEVER fails a round.
 */
export async function recombineStrategies(
  provider: Provider,
  modelId: string,
  strategyA: string,
  strategyB: string,
  goalMd: string,
): Promise<{ strategyMd: string; notesMd: string }> {
  const prompt = buildRecombinePrompt(strategyA, strategyB, goalMd)
  const raw = await provider.complete({
    purpose: 'reflect', prompt, modelId, schema: RECOMBINE_JSON_SCHEMA,
  })
  const parsed = await parseWithRepair(raw, RecombineSchema, (err) =>
    provider.complete({
      purpose: 'reflect',
      prompt: `${prompt}\n\nYour previous reply failed to parse: ${err}. Reply with JSON only.`,
      modelId,
      schema: RECOMBINE_JSON_SCHEMA,
    }),
  )
  // A whitespace-only strategy is unusable output, not a successful
  // recombination — reject it here so every caller falls back identically.
  const strategyMd = parsed.strategy_md.trim()
  if (strategyMd.length === 0) throw new Error('recombineStrategies: model returned an empty strategy_md')
  return { strategyMd, notesMd: parsed.notes_md }
}
