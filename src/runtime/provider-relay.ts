/**
 * The decision half of the provider relay: may this worker request go upstream, and exactly
 * where and with which credential.
 *
 * Protected workers hold no provider credentials. Their OpenCode config points each provider's
 * base URL at the relay and carries a per-run token where the API key would be. The relay
 * accepts only the model-call endpoints of providers it has a fixed https upstream for, only
 * models in the run's roster, only within the run's request grant, and swaps the token for the
 * real key on the way out. It is not a general proxy: no other paths, methods, query strings,
 * hosts or CONNECT tunnels. A worker can still use the model access deliberately granted to it;
 * the grant bounds that use and every decision names the run it is charged to.
 */

export type RelayAuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key'

export interface RelayUpstream {
  providerId: string
  /** Fixed https base URL; request paths are appended, never parsed from the worker. */
  baseUrl: string
  authStyle: RelayAuthStyle
  apiKey: string
}

export interface RelayGrant {
  token: string
  /** Full model ids (`provider/model`) the run may call. */
  allowedModels: readonly string[]
  maxRequests: number
}

export interface RelayLimits {
  maxRequestBytes: number
  maxResponseBytes: number
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = { maxRequestBytes: 8 * 1024 ** 2, maxResponseBytes: 32 * 1024 ** 2 }

export interface RelayRequest {
  method: string
  /** Path and query as received, e.g. `/wandb/chat/completions`. */
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

export type RelayDecision =
  | { ok: true; runId: string; modelId: string; url: string; headers: Record<string, string>; body: Buffer }
  | { ok: false; status: number; error: string; runId?: string }

/** Request headers that carry meaning upstream. Everything else — cookies, forwarding, the worker token — stays behind. */
const FORWARDED_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'] as const

const DEFAULT_BASE: Record<string, { base: string | null; authStyle: RelayAuthStyle }> = {
  '@ai-sdk/openai-compatible': { base: null, authStyle: 'bearer' },
  '@ai-sdk/openai': { base: 'https://api.openai.com/v1', authStyle: 'bearer' },
  '@ai-sdk/anthropic': { base: 'https://api.anthropic.com/v1', authStyle: 'x-api-key' },
  '@ai-sdk/google': { base: 'https://generativelanguage.googleapis.com/v1beta', authStyle: 'x-goog-api-key' },
}

/**
 * The relay upstream for a catalogue provider (models.dev: `api` base URL and SDK `npm`
 * package), or null when the relay cannot carry it: an unknown SDK, or anything but plain https.
 */
export function upstreamFor(
  providerId: string,
  entry: { api?: string | null; npm?: string | null },
): Omit<RelayUpstream, 'apiKey'> | null {
  const known = entry.npm ? DEFAULT_BASE[entry.npm] : undefined
  if (!known) return null
  const candidate = entry.api ?? known.base
  if (!candidate) return null
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  return { providerId, baseUrl: candidate.replace(/\/+$/, ''), authStyle: known.authStyle }
}

interface GrantState {
  runId: string
  token: string
  allowedModels: Set<string>
  maxRequests: number
  used: number
}

const headerValue = (headers: RelayRequest['headers'], name: string): string | undefined => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

export class RelayPolicy {
  private upstreams = new Map<string, RelayUpstream>()
  private byToken = new Map<string, GrantState>()

  constructor(upstreams: readonly RelayUpstream[], public readonly limits: RelayLimits = DEFAULT_RELAY_LIMITS) {
    for (const upstream of upstreams) this.upstreams.set(upstream.providerId, upstream)
  }

  /** Issues or replaces a run's grant; its previous token stops working. */
  grant(runId: string, grant: RelayGrant): void {
    this.revoke(runId)
    this.byToken.set(grant.token, {
      runId,
      token: grant.token,
      allowedModels: new Set(grant.allowedModels),
      maxRequests: grant.maxRequests,
      used: 0,
    })
  }

  /** Revoked first when a run stops: later requests with its token are unauthenticated. */
  revoke(runId: string): void {
    for (const [token, state] of this.byToken) if (state.runId === runId) this.byToken.delete(token)
  }

  authorize(req: RelayRequest): RelayDecision {
    if (req.method !== 'POST') return { ok: false, status: 405, error: 'only POST model calls are relayed' }

    const route = this.route(req.path)
    if (!route) return { ok: false, status: 404, error: 'not a relayed model endpoint' }
    const { upstream, rest, query, pathModel } = route

    const token = this.tokenFrom(req.headers, upstream.authStyle)
    const grant = token ? this.byToken.get(token) : undefined
    if (!grant) return { ok: false, status: 401, error: 'missing or unknown relay token' }

    if (req.body.length > this.limits.maxRequestBytes) {
      return { ok: false, status: 413, runId: grant.runId, error: `request body exceeds ${this.limits.maxRequestBytes} bytes` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(req.body.toString('utf8'))
    } catch {
      return { ok: false, status: 400, runId: grant.runId, error: 'request body is not JSON' }
    }
    const bodyModel = parsed && typeof parsed === 'object' ? (parsed as { model?: unknown }).model : undefined
    const model = pathModel ?? (typeof bodyModel === 'string' && bodyModel.length > 0 ? bodyModel : null)
    if (!model) return { ok: false, status: 400, runId: grant.runId, error: 'request names no model' }
    const modelId = `${upstream.providerId}/${model}`
    if (!grant.allowedModels.has(modelId)) {
      return { ok: false, status: 403, runId: grant.runId, error: `model ${modelId} is not in this run's roster` }
    }
    if (grant.used >= grant.maxRequests) {
      return { ok: false, status: 429, runId: grant.runId, error: `this run used all ${grant.maxRequests} relay requests it was granted` }
    }
    grant.used++

    const headers: Record<string, string> = {}
    for (const name of FORWARDED_HEADERS) {
      const value = headerValue(req.headers, name)
      if (value !== undefined) headers[name] = value
    }
    if (upstream.authStyle === 'bearer') headers.authorization = `Bearer ${upstream.apiKey}`
    else headers[upstream.authStyle] = upstream.apiKey

    return {
      ok: true,
      runId: grant.runId,
      modelId,
      url: `${upstream.baseUrl}/${rest}${query ? `?${query}` : ''}`,
      headers,
      body: req.body,
    }
  }

  private route(raw: string): { upstream: RelayUpstream; rest: string; query: string; pathModel: string | null } | null {
    const q = raw.indexOf('?')
    const path = q === -1 ? raw : raw.slice(0, q)
    const query = q === -1 ? '' : raw.slice(q + 1)
    // Encoded or doubled separators and dot segments are how a path escapes its prefix.
    if (!path.startsWith('/') || /%|\\|\/\/|(^|\/)\.\.?(\/|$)/.test(path)) return null
    const match = /^\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(path)
    if (!match) return null
    const upstream = this.upstreams.get(match[1]!)
    if (!upstream) return null
    const rest = match[2]!
    switch (upstream.authStyle) {
      case 'bearer':
        return !query && ['chat/completions', 'responses', 'completions'].includes(rest)
          ? { upstream, rest, query, pathModel: null }
          : null
      case 'x-api-key':
        return !query && rest === 'messages' ? { upstream, rest, query, pathModel: null } : null
      case 'x-goog-api-key': {
        const google = /^models\/([A-Za-z0-9._-]+):(generateContent|streamGenerateContent)$/.exec(rest)
        return google && (query === '' || query === 'alt=sse') ? { upstream, rest, query, pathModel: google[1]! } : null
      }
    }
  }

  private tokenFrom(headers: RelayRequest['headers'], style: RelayAuthStyle): string | null {
    if (style === 'bearer') {
      const match = /^Bearer (\S+)$/.exec(headerValue(headers, 'authorization') ?? '')
      return match ? match[1]! : null
    }
    return headerValue(headers, style) ?? null
  }
}
