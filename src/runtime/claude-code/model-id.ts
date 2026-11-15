/**
 * Roster ids for models served by the owner's Claude subscription through the Claude Code CLI:
 * `claude-subscription/<model>`. Never routed to OpenCode, which may not hold a subscription token.
 */
export const CLAUDE_SUBSCRIPTION_PROVIDER = 'claude-subscription'

const PREFIX = `${CLAUDE_SUBSCRIPTION_PROVIDER}/`

/**
 * The model reaches the CLI's argv, so it must look like a model id and nothing else: a value
 * starting with `-` would be read as a flag. Same rule as Odysseus's Claude subscription provider.
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/

/** Offered in the dashboard's pickers. Any id the CLI accepts still works typed in. */
export const DEFAULT_CLAUDE_SUBSCRIPTION_MODELS = [
  'claude-subscription/claude-opus-5-5',
  'claude-subscription/claude-sonnet-5-5',
  'claude-subscription/claude-fable-5-1',
  'claude-subscription/claude-haiku-5-5',
  'claude-subscription/opus',
  'claude-subscription/sonnet',
  'claude-subscription/haiku',
] as const

export function isClaudeSubscriptionModel(modelId: string): boolean {
  return modelId.startsWith(PREFIX)
}

/** The model half of a valid `claude-subscription/<model>` id, or null when it is not one. */
export function claudeModelOf(modelId: string): string | null {
  if (!isClaudeSubscriptionModel(modelId)) return null
  const model = modelId.slice(PREFIX.length)
  return MODEL_RE.test(model) ? model : null
}

/** The model to hand the CLI; throws for anything that is not a valid subscription model id. */
export function requireClaudeModel(modelId: string): string {
  const model = claudeModelOf(modelId)
  if (model === null) {
    throw new Error(
      `${JSON.stringify(modelId)} is not a valid Claude subscription model id: use claude-subscription/<model>, ` +
        'where <model> is a Claude model id such as claude-opus-5-5 or an alias (opus, sonnet, haiku, fable)',
    )
  }
  return model
}
