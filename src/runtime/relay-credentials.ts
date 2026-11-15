import { CODEX_RESPONSES_URL } from './chatgpt-oauth.js'
import { CLAUDE_SUBSCRIPTION_PROVIDER } from './claude-code/model-id.js'
import { upstreamFor, type ChatGptCredentialSource, type RelayUpstream } from './provider-relay.js'

/**
 * What OpenCode's own client sends to OpenCode Zen when nobody is signed in (verified September 15
 * 2026 against a fake upstream: `Authorization: Bearer public`). Only Zen's free models accept it; a
 * paid Zen model without a key fails upstream with the provider's own error.
 */
export const OPENCODE_ZEN_PUBLIC_KEY = 'public'

export interface CatalogProvider {
  api?: string | null
  npm?: string | null
}

/**
 * The relay's upstreams for a run's providers, built on the host from OpenCode's credentials
 * file. Keys stay in this process: they are never written to a worker mount, config, manifest,
 * environment or command line.
 *
 * Two subscription logins are carried: `claude-subscription` with a `claude setup-token` value (for
 * Claude Code's own requests), and OpenCode's ChatGPT Plus/Pro login for `openai`, which the relay
 * refreshes itself through `subscriptions.chatgpt`. Any other provider the relay cannot carry is
 * reported with a reason instead: another OAuth login (no refresh flow for it here), an SDK without
 * a known upstream, no key. Reasons are fixed text; no credential value or file content is ever
 * repeated in them.
 */
export function relayUpstreamsFromAuth(
  authJson: string,
  catalog: Record<string, CatalogProvider>,
  providerIds: readonly string[],
  subscriptions: { claudeToken?: string | null; chatgpt?: ChatGptCredentialSource | null } = {},
): { upstreams: RelayUpstream[]; unsupported: { providerId: string; reason: string }[] } {
  let auth: unknown
  try {
    auth = JSON.parse(authJson)
  } catch {
    throw new Error('the credentials file is not valid JSON')
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('the credentials file is not a JSON object')

  const upstreams: RelayUpstream[] = []
  const unsupported: { providerId: string; reason: string }[] = []
  for (const providerId of [...new Set(providerIds)]) {
    if (providerId === CLAUDE_SUBSCRIPTION_PROVIDER) {
      if (subscriptions.claudeToken) {
        upstreams.push({ providerId, baseUrl: 'https://api.anthropic.com', authStyle: 'bearer', apiKey: subscriptions.claudeToken, kind: 'claude-subscription' })
      } else {
        unsupported.push({
          providerId,
          reason: "claude-subscription needs a `claude setup-token` value under Subscriptions (the machine's own Claude login cannot be relayed)",
        })
      }
      continue
    }
    const entry = catalog[providerId]
    if (!entry) {
      unsupported.push({ providerId, reason: `${providerId} is not in the model catalogue` })
      continue
    }
    const target = upstreamFor(providerId, entry)
    if (!target) {
      unsupported.push({ providerId, reason: `${providerId} uses an SDK the relay cannot carry` })
      continue
    }
    const credential = (auth as Record<string, unknown>)[providerId]
    const type = credential && typeof credential === 'object' ? (credential as { type?: unknown }).type : undefined
    if (type === 'oauth' && providerId === 'openai' && subscriptions.chatgpt) {
      upstreams.push({ providerId, baseUrl: CODEX_RESPONSES_URL, authStyle: 'bearer', apiKey: '', kind: 'chatgpt', chatgpt: subscriptions.chatgpt })
      continue
    }
    if (type === 'oauth') {
      unsupported.push({ providerId, reason: `${providerId} is signed in with an OAuth login, which the relay cannot carry; add an API key for it` })
      continue
    }
    if (credential === undefined && providerId === 'opencode') {
      // Faithful to OpenCode without a login, so free Zen models keep working behind the relay.
      upstreams.push({ ...target, apiKey: OPENCODE_ZEN_PUBLIC_KEY })
      continue
    }
    const key = credential && typeof credential === 'object' ? (credential as { key?: unknown }).key : undefined
    if (type !== 'api' || typeof key !== 'string' || key.length === 0) {
      unsupported.push({ providerId, reason: `no API key for ${providerId} in the credentials file` })
      continue
    }
    upstreams.push({ ...target, apiKey: key })
  }
  return { upstreams, unsupported }
}
