import { upstreamFor, type RelayUpstream } from './provider-relay.js'

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
 * A provider the relay cannot carry is reported with a reason instead: an OAuth login (it
 * needs a refresh flow the relay does not perform), an SDK without a known upstream, no key.
 * Reasons are fixed text; no credential value or file content is ever repeated in them.
 */
export function relayUpstreamsFromAuth(
  authJson: string,
  catalog: Record<string, CatalogProvider>,
  providerIds: readonly string[],
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
