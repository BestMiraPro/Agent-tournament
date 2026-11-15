import type { SubscriptionStatus } from '../api.js'

/**
 * Whether a model id bills a subscription: every `claude-subscription/*` model, and OpenCode's
 * `openai/*` models while the credentials file holds a ChatGPT Plus/Pro login.
 */
export function isSubscriptionModel(modelId: string, status: SubscriptionStatus | null): boolean {
  if (modelId.startsWith('claude-subscription/')) return true
  return status !== null && status.chatgpt.signedIn && modelId.startsWith(status.chatgpt.modelPrefix)
}

/**
 * The picker list: discovered models plus the Claude subscription models (which OpenCode does not
 * list), each labelled "subscription" when it bills one. Order kept, duplicates dropped.
 */
export function pickerModels(discovered: readonly string[], status: SubscriptionStatus | null): { models: string[]; labels: Record<string, string> } {
  const models = [...new Set([...(status?.claude.models ?? []), ...discovered])]
  const labels: Record<string, string> = {}
  for (const m of models) if (isSubscriptionModel(m, status)) labels[m] = 'subscription'
  return { models, labels }
}

/** One line per subscription saying whether it can be used, and what to do if not. */
export function subscriptionSummary(status: SubscriptionStatus): { claude: string; chatgpt: string } {
  const c = status.claude
  const claude = !c.cli.found
    ? 'Claude: the Claude Code CLI is not installed on this machine.'
    : c.mode === 'token'
      ? 'Claude: setup token saved — used for local and Docker runs.'
      : c.mode === 'host'
        ? "Claude: this machine's Claude Code login detected — local runs only; Docker needs a setup token."
        : 'Claude: not signed in.'
  const g = status.chatgpt
  const chatgpt = !g.signedIn
    ? 'ChatGPT: no ChatGPT Plus/Pro login in the OpenCode credentials file.'
    : g.expired
      ? 'ChatGPT: signed in; the access token has expired and is refreshed on the next call.'
      : 'ChatGPT: signed in through OpenCode.'
  return { claude, chatgpt }
}
