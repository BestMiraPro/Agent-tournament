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

import { residencyOf } from './chatgpt-oauth.js'

export type RelayAuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key'

/** Where a ChatGPT upstream gets a current access token, and its subscription limit. */
export interface ChatGptCredentialSource {
  credentials(): Promise<{ access: string; accountId?: string }>
  /** The refusal to send while the subscription's limit holds, or null. */
  limited(): { message: string } | null
  /** Records an upstream 429 so later requests are refused until `resetAt` (ms). */
  noteLimit(resetAt: number): void
}

export interface RelayUpstream {
  providerId: string
  /** Fixed https base URL; request paths are appended, never parsed from the worker. */
  baseUrl: string
  authStyle: RelayAuthStyle
  apiKey: string
  /**
   * `chatgpt`: OpenCode's ChatGPT Plus/Pro login for `openai`, refreshed per request through
   * `chatgpt` and sent to the Codex backend as OpenCode itself sends it. Absent: an API key in the
   * provider's own header. The relay never carries a Claude subscription token: Claude Code holds it
   * in the worker and reaches Anthropic through the gateway's CONNECT route instead.
   */
  kind?: 'chatgpt'
  chatgpt?: ChatGptCredentialSource
}

export interface RelayGrant {
  token: string
  /** Full model ids (`provider/model`) the run may call. */
  allowedModels: readonly string[]
  maxRequests: number
  /**
   * This run's own upstreams and keys. Runs can use different credentials files, so keys travel
   * with the grant; without them the policy's shared upstreams apply.
   */
  upstreams?: readonly RelayUpstream[]
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
  | {
      ok: true; runId: string; modelId: string; url: string; headers: Record<string, string>; body: Buffer
      /** Headers that need an async credential (a refreshed access token), resolved just before sending. */
      prepare?: () => Promise<Record<string, string>>
      /** Sees the upstream status, to close a subscription's upstream on its usage limit. */
      onReply?: (status: number, headers: Record<string, string | string[] | undefined>) => void
    }
  | { ok: false; status: number; error: string; runId?: string }

/** Request headers that carry meaning upstream. Everything else — cookies, forwarding, the worker token — stays behind. */
const FORWARDED_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'] as const

/**
 * OpenCode Zen's free tier answers "can only be used in OpenCode" to a call that lacks the
 * identification OpenCode sends (September 15 relay acceptance run), so these go to Zen only.
 * They name the client and its session; none carries a credential. Bounded printable text.
 */
const OPENCODE_CLIENT_HEADERS = ['user-agent', 'x-opencode-client', 'x-opencode-project', 'x-opencode-session', 'x-opencode-request'] as const
const OPENCODE_PROVIDER_ID = 'opencode'
const MAX_CLIENT_HEADER_LENGTH = 256

/** What OpenCode sends to `openai` (its ChatGPT plugin adds them to every request); none carries a credential. */
const CHATGPT_CLIENT_HEADERS = ['user-agent', 'originator', 'session-id', 'x-session-affinity', 'x-session-id'] as const

function copyClientHeaders(from: RelayRequest['headers'], names: readonly string[], to: Record<string, string>): void {
  for (const name of names) {
    const value = headerValue(from, name)
    if (value !== undefined && value.length <= MAX_CLIENT_HEADER_LENGTH && /^[\x20-\x7e]*$/.test(value)) to[name] = value
  }
}

/**
 * OpenCode puts the system prompt in `instructions` when it runs `openai` on a ChatGPT login and in
 * leading `developer`/`system` input messages when it runs it on a key (verified against 1.18.21).
 * A protected worker runs it as a key, so the relay makes the same move OpenCode makes itself.
 */
export function codexBody(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.instructions === 'string' || !Array.isArray(body.input)) return body
  const input = [...body.input]
  const system: string[] = []
  while (input.length > 0) {
    const first = input[0] as { role?: unknown; content?: unknown } | null
    if (!first || (first.role !== 'developer' && first.role !== 'system')) break
    const content = first.content
    if (typeof content === 'string') system.push(content)
    else if (Array.isArray(content)) {
      system.push(content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join(''))
    }
    input.shift()
  }
  if (system.length === 0) return body
  return { ...body, instructions: system.join('\n'), input }
}

function retryAfterMs(headers: Record<string, string | string[] | undefined>): number {
  const raw = headers['retry-after']
  const value = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 3600) * 1000 : 60_000
}

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
  upstreams: Map<string, RelayUpstream> | null
}

const headerValue = (headers: RelayRequest['headers'], name: string): string | undefined => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

const TOKEN_HEADERS: { style: RelayAuthStyle; read: (headers: RelayRequest['headers']) => string | null }[] = [
  { style: 'bearer', read: (h) => /^Bearer (\S+)$/.exec(headerValue(h, 'authorization') ?? '')?.[1] ?? null },
  { style: 'x-api-key', read: (h) => headerValue(h, 'x-api-key') ?? null },
  { style: 'x-goog-api-key', read: (h) => headerValue(h, 'x-goog-api-key') ?? null },
]

export class RelayPolicy {
  private shared = new Map<string, RelayUpstream>()
  private byToken = new Map<string, GrantState>()

  constructor(upstreams: readonly RelayUpstream[] = [], public readonly limits: RelayLimits = DEFAULT_RELAY_LIMITS) {
    for (const upstream of upstreams) this.shared.set(upstream.providerId, upstream)
  }

  /** Issues or replaces a run's grant; its previous token stops working. */
  grant(runId: string, grant: RelayGrant): void {
    this.dropGrants(runId)
    this.byToken.set(grant.token, {
      runId,
      token: grant.token,
      allowedModels: new Set(grant.allowedModels),
      maxRequests: grant.maxRequests,
      used: 0,
      upstreams: grant.upstreams ? new Map(grant.upstreams.map((u) => [u.providerId, u])) : null,
    })
  }

  /** Revoked first when a run stops: later requests with its token are unauthenticated. */
  revoke(runId: string): void {
    this.dropGrants(runId)
  }

  private dropGrants(runId: string): void {
    for (const [token, state] of this.byToken) if (state.runId === runId) this.byToken.delete(token)
  }

  authorize(req: RelayRequest): RelayDecision {
    if (req.method !== 'POST') return { ok: false, status: 405, error: 'only POST model calls are relayed' }

    const target = parsePath(req.path)
    if (!target) return { ok: false, status: 404, error: 'not a relayed model endpoint' }

    let grant: GrantState | undefined
    let presentedStyle: RelayAuthStyle | undefined
    for (const candidate of TOKEN_HEADERS) {
      const token = candidate.read(req.headers)
      const found = token ? this.byToken.get(token) : undefined
      if (found) {
        grant = found
        presentedStyle = candidate.style
        break
      }
    }
    if (!grant) return { ok: false, status: 401, error: 'missing or unknown relay token' }

    const upstream = (grant.upstreams ?? this.shared).get(target.providerId)
    const route = upstream ? routeFor(upstream, target.rest, target.query) : null
    if (!upstream || !route) return { ok: false, status: 404, runId: grant.runId, error: 'not a relayed model endpoint' }
    // The token must arrive where that provider's SDK puts its key, as OpenCode sends it.
    if (presentedStyle !== upstream.authStyle) return { ok: false, status: 401, error: 'missing or unknown relay token' }

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
    const model = route.pathModel ?? (typeof bodyModel === 'string' && bodyModel.length > 0 ? bodyModel : null)
    if (!model) return { ok: false, status: 400, runId: grant.runId, error: 'request names no model' }
    const modelId = `${upstream.providerId}/${model}`
    if (!grant.allowedModels.has(modelId)) {
      return { ok: false, status: 403, runId: grant.runId, error: `model ${modelId} is not in this run's roster` }
    }
    if (grant.used >= grant.maxRequests) {
      return { ok: false, status: 429, runId: grant.runId, error: `this run used all ${grant.maxRequests} relay requests it was granted` }
    }
    // A subscription past its usage limit is refused here, so a worker's retries cannot hammer it.
    const limited = upstream.kind === 'chatgpt' ? upstream.chatgpt?.limited() ?? null : null
    if (limited) return { ok: false, status: 429, runId: grant.runId, error: limited.message }
    grant.used++

    const headers: Record<string, string> = {}
    for (const name of FORWARDED_HEADERS) {
      const value = headerValue(req.headers, name)
      if (value !== undefined) headers[name] = value
    }
    if (upstream.providerId === OPENCODE_PROVIDER_ID) copyClientHeaders(req.headers, OPENCODE_CLIENT_HEADERS, headers)

    if (upstream.kind === 'chatgpt') {
      const source = upstream.chatgpt
      if (!source) return { ok: false, status: 502, runId: grant.runId, error: 'the ChatGPT login is not available to the relay' }
      copyClientHeaders(req.headers, CHATGPT_CLIENT_HEADERS, headers)
      return {
        ok: true,
        runId: grant.runId,
        modelId,
        url: upstream.baseUrl,
        headers,
        body: Buffer.from(JSON.stringify(codexBody(parsed as Record<string, unknown>))),
        // Set last, after every forwarded header, so none can stand in for the token.
        prepare: async () => {
          const { access, accountId } = await source.credentials()
          const residency = residencyOf(access)
          return {
            authorization: `Bearer ${access}`,
            ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
            ...(residency ? { 'x-openai-internal-codex-residency': residency } : {}),
          }
        },
        onReply: (status, replyHeaders) => {
          if (status === 429) source.noteLimit(Date.now() + retryAfterMs(replyHeaders))
        },
      }
    }

    // Set last, so no forwarded header can stand in for the key.
    if (upstream.authStyle === 'bearer') headers.authorization = `Bearer ${upstream.apiKey}`
    else headers[upstream.authStyle] = upstream.apiKey

    return {
      ok: true,
      runId: grant.runId,
      modelId,
      url: `${upstream.baseUrl}/${target.rest}${target.query ? `?${target.query}` : ''}`,
      headers,
      body: req.body,
    }
  }
}

function parsePath(raw: string): { providerId: string; rest: string; query: string } | null {
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const query = q === -1 ? '' : raw.slice(q + 1)
  // Encoded or doubled separators and dot segments are how a path escapes its prefix.
  if (!path.startsWith('/') || /%|\\|\/\/|(^|\/)\.\.?(\/|$)/.test(path)) return null
  const match = /^\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(path)
  return match ? { providerId: match[1]!, rest: match[2]!, query } : null
}

function routeFor(upstream: RelayUpstream, rest: string, query: string): { pathModel: string | null } | null {
  // OpenCode's ChatGPT plugin sends only Responses calls to the Codex backend.
  if (upstream.kind === 'chatgpt') return rest === 'responses' && query === '' ? { pathModel: null } : null
  switch (upstream.authStyle) {
    case 'bearer':
      return !query && ['chat/completions', 'responses', 'completions'].includes(rest) ? { pathModel: null } : null
    case 'x-api-key':
      return !query && rest === 'messages' ? { pathModel: null } : null
    case 'x-goog-api-key': {
      const google = /^models\/([A-Za-z0-9._-]+):(generateContent|streamGenerateContent)$/.exec(rest)
      return google && (query === '' || query === 'alt=sse') ? { pathModel: google[1]! } : null
    }
  }
}
