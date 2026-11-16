import { request as httpsRequest } from 'node:https'

/**
 * `web_search`: LangSearch first when its key is configured, Exa when LangSearch cannot answer.
 *
 * Any primary failure falls back, and the reason is kept as a fixed code — never the provider's
 * error text, which can echo request detail. Exa is the public MCP endpoint OpenCode itself uses:
 * keyless by default (direct IPv4 is required for that), the operator's key in `x-api-key` when
 * set. Keys travel only in request headers, never in URLs, results or errors.
 */

export const LANGSEARCH_URL = 'https://api.langsearch.com/v1/web-search'
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'

export type SearchProviderId = 'langsearch' | 'exa'

export type FallbackReason =
  | 'missing_key' | 'unauthorized' | 'rate_limited' | 'quota_exhausted' | 'server_error'
  | 'timeout' | 'network' | 'bad_response' | 'client_error'

export interface SearchResult {
  title: string
  url: string
  snippet: string
  published: string | null
}

export interface SearchOutcome {
  provider: SearchProviderId
  results: SearchResult[]
  /** Why the primary did not answer, when it did not. */
  fallback: { from: 'langsearch'; reason: FallbackReason } | null
  /** HTTP status and size of the answering provider's response. */
  status: number
  bytes: number
}

export class WebSearchError extends Error {
  readonly code = 'search_failed'
  constructor(public readonly primary: FallbackReason, public readonly fallback: FallbackReason) {
    super(`web search failed: langsearch ${primary}, then exa ${fallback}`)
    this.name = 'WebSearchError'
  }
}

export class HttpTimeoutError extends Error {
  constructor() {
    super('request timed out')
    this.name = 'HttpTimeoutError'
  }
}

export type HttpPost = (req: {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  /** 4 forces IPv4. */
  family?: 4
}) => Promise<{ status: number; body: string }>

export interface SearchKeys {
  langsearch: string | null
  exa: string | null
}

export interface SearchDeps {
  keys: SearchKeys
  post?: HttpPost
}

const LANGSEARCH_TIMEOUT_MS = 12_000
const EXA_TIMEOUT_MS = 25_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_SNIPPET_CHARS = 1000

/** One HTTPS POST, a fresh agent, no redirects, a bounded response. */
export const nodeHttpsPost: HttpPost = (req) =>
  new Promise((resolve, reject) => {
    const body = Buffer.from(req.body)
    const r = httpsRequest(req.url, {
      method: 'POST',
      agent: false,
      ...(req.family ? { family: req.family } : {}),
      headers: { ...req.headers, 'content-length': String(body.length) },
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy()
          r.destroy(new Error('response too large'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
    const timer = setTimeout(() => r.destroy(new HttpTimeoutError()), req.timeoutMs)
    r.on('error', (e) => { clearTimeout(timer); reject(e) })
    r.end(body)
  })

class ProviderFailure extends Error {
  constructor(public readonly reason: FallbackReason) {
    super(reason)
  }
}

function statusReason(status: number, message: string): FallbackReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402 || status === 432 || status === 433) return 'quota_exhausted'
  if (status === 429) return /allowance|quota|daily|exhaust/i.test(message) ? 'quota_exhausted' : 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'client_error'
}

async function send(post: HttpPost, req: Parameters<HttpPost>[0]): Promise<{ status: number; body: string }> {
  try {
    return await post(req)
  } catch (e) {
    throw new ProviderFailure(e instanceof HttpTimeoutError ? 'timeout' : 'network')
  }
}

function snippet(text: unknown): string {
  const s = typeof text === 'string' ? text.trim() : ''
  return s.length > MAX_SNIPPET_CHARS ? `${s.slice(0, MAX_SNIPPET_CHARS)}…` : s
}

async function langsearch(query: string, count: number, key: string, post: HttpPost) {
  const res = await send(post, {
    url: LANGSEARCH_URL,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, count }),
    timeoutMs: LANGSEARCH_TIMEOUT_MS,
  })
  if (res.status !== 200) throw new ProviderFailure(statusReason(res.status, res.body))
  let parsed: { code?: unknown; msg?: unknown; data?: { webPages?: { value?: unknown } } }
  try {
    parsed = JSON.parse(res.body) as typeof parsed
  } catch {
    throw new ProviderFailure('bad_response')
  }
  if (typeof parsed.code === 'number' && parsed.code !== 200) {
    throw new ProviderFailure(statusReason(parsed.code, typeof parsed.msg === 'string' ? parsed.msg : ''))
  }
  const value = parsed.data?.webPages?.value
  if (!Array.isArray(value)) throw new ProviderFailure('bad_response')
  const results = value.flatMap((v: { name?: unknown; url?: unknown; snippet?: unknown; datePublished?: unknown }) =>
    typeof v?.url === 'string'
      ? [{ title: typeof v.name === 'string' ? v.name : v.url, url: v.url, snippet: snippet(v.snippet), published: typeof v.datePublished === 'string' ? v.datePublished : null }]
      : [])
  return { results: results.slice(0, count), status: res.status, bytes: Buffer.byteLength(res.body) }
}

/** Exa's `web_search_exa` text: `Title:/URL:/Published:/Highlights:` blocks separated by `---`. */
export function parseExaText(text: string): SearchResult[] {
  return text.split(/\n-{3,}\n/).flatMap((block) => {
    const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, 'm').exec(block)?.[1]?.trim() ?? null
    const url = field('URL')
    if (!url) return []
    const published = field('Published')
    const body = /^(?:Highlights|Text|Summary):[ \t]*\n?([\s\S]*)$/m.exec(block)?.[1] ?? ''
    return [{ title: field('Title') || url, url, published: published && published !== 'N/A' ? published : null, snippet: snippet(body) }]
  })
}

function jsonRpcPayload(body: string): { result?: { isError?: boolean; content?: { type?: string; text?: string }[] }; error?: unknown } | null {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown
      return v && typeof v === 'object' ? (v as ReturnType<typeof jsonRpcPayload>) : null
    } catch {
      return null
    }
  }
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) return tryParse(trimmed)
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = tryParse(line.slice(5).trim())
    if (payload) return payload
  }
  return null
}

async function exa(query: string, count: number, key: string | null, post: HttpPost) {
  const res = await send(post, {
    url: EXA_MCP_URL,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { 'x-api-key': key } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: count, objective: query } },
    }),
    timeoutMs: EXA_TIMEOUT_MS,
    family: 4,
  })
  if (res.status !== 200) throw new ProviderFailure(statusReason(res.status, res.body))
  const payload = jsonRpcPayload(res.body)
  if (!payload || payload.error || !payload.result || payload.result.isError) throw new ProviderFailure('bad_response')
  const text = (payload.result.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string')?.text ?? ''
  return { results: parseExaText(text).slice(0, count), status: res.status, bytes: Buffer.byteLength(res.body) }
}

export async function webSearch(query: string, maxResults: number, deps: SearchDeps): Promise<SearchOutcome> {
  const post = deps.post ?? nodeHttpsPost
  let reason: FallbackReason = 'missing_key'
  if (deps.keys.langsearch) {
    try {
      return { provider: 'langsearch', fallback: null, ...(await langsearch(query, maxResults, deps.keys.langsearch, post)) }
    } catch (e) {
      reason = e instanceof ProviderFailure ? e.reason : 'bad_response'
    }
  }
  try {
    return { provider: 'exa', fallback: { from: 'langsearch', reason }, ...(await exa(query, maxResults, deps.keys.exa, post)) }
  } catch (e) {
    throw new WebSearchError(reason, e instanceof ProviderFailure ? e.reason : 'bad_response')
  }
}
