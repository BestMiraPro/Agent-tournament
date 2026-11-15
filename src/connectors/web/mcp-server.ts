import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readWebSearchKeys } from './config.js'
import { fetchTarget, searchTarget, type WebCallRecord, type WebEvidenceSink, type WebTool } from './evidence.js'
import { fetchPage, WebFetchError, type FetchDeps, type FetchedPage, type FetchLimits } from './fetch-page.js'
import { WebLimiter, type WebLimits } from './limits.js'
import { webSearch, WebSearchError, type HttpPost, type SearchKeys, type SearchOutcome } from './search.js'
import { BlockedTargetError, MAX_URL_LENGTH } from './ssrf.js'

/**
 * The web tools as an MCP server for one agent of one run. In-process: keys, limits and evidence
 * stay in the host process that created it, whatever transport carries the protocol (the local
 * loopback endpoint now, the connectors bridge for Docker workers at integration, stdio standalone).
 */

export interface WebServerDeps {
  runId: string
  agentId: string
  evidence: WebEvidenceSink
  /** Shared by every agent of the run. */
  limiter: WebLimiter
  /** Read per call, so a key added between calls applies. */
  keys: () => SearchKeys
  now?: () => number
  post?: HttpPost
  fetchDeps?: FetchDeps
  fetchLimits?: Partial<FetchLimits>
}

export const DEFAULT_MAX_RESULTS = 5
export const MAX_RESULTS = 10
export const MAX_QUERY_LENGTH = 400

/** Codes that mean the request was refused by policy rather than failing on the way. */
const DENIED = new Set(['invalid_url', 'blocked_host', 'blocked_address'])

const PROVIDER_NAME = { langsearch: 'LangSearch', exa: 'Exa' } as const

function formatSearch(query: string, out: SearchOutcome): string {
  const via = out.fallback
    ? `via ${PROVIDER_NAME[out.provider]}; LangSearch unavailable: ${out.fallback.reason}`
    : `via ${PROVIDER_NAME[out.provider]}`
  const head = `Search results for "${query}" (${via}):`
  if (out.results.length === 0) return `${head}\n\nNo results.`
  const items = out.results.map((r, i) => [
    `${i + 1}. ${r.title}`,
    `   ${r.url}`,
    ...(r.published ? [`   Published: ${r.published}`] : []),
    ...(r.snippet ? [r.snippet.split('\n').map((line) => `   ${line}`).join('\n')] : []),
  ].join('\n'))
  return `${head}\n\n${items.join('\n\n')}`
}

function formatPage(requested: string, page: FetchedPage): string {
  return [
    `URL: ${page.url === requested ? requested : `${requested} → ${page.url}`}`,
    `Status: ${page.status} · ${page.contentType} · ${page.bytes} bytes${page.truncated ? ' · truncated' : ''}`,
    ...(page.title ? [`Title: ${page.title}`] : []),
    '',
    page.text,
  ].join('\n')
}

const refusal = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })

export function createWebMcpServer(deps: WebServerDeps): McpServer {
  const now = deps.now ?? Date.now
  const server = new McpServer({ name: 'arena-web', version: '1.0.0' })

  const record = (r: WebCallRecord) => {
    try {
      deps.evidence(r)
    } catch {
      /* a broken evidence sink must not break the agent's call */
    }
  }

  const begin = (tool: WebTool, target: string) => {
    const startedAt = now()
    const admission = deps.limiter.admit(deps.agentId, tool)
    const base = { id: `W${admission.seq}`, runId: deps.runId, agentId: deps.agentId, tool, target, startedAt }
    return { admission, base, elapsed: () => now() - startedAt }
  }

  server.registerTool('web_search', {
    title: 'Web search',
    description:
      'Search the web. Returns titles, URLs and snippets. Read a result in full with web_fetch. ' +
      'Every call is recorded and counted against this agent\'s search limit.',
    inputSchema: {
      query: z.string().min(1).max(MAX_QUERY_LENGTH).describe('What to search for.'),
      maxResults: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results, 1-${MAX_RESULTS} (default ${DEFAULT_MAX_RESULTS}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, maxResults }) => {
    const { admission, base, elapsed } = begin('web_search', searchTarget(query))
    if (!admission.ok) {
      record({ ...base, outcome: 'denied', status: null, bytes: 0, durationMs: 0, error: admission.reason })
      return refusal(admission.message)
    }
    try {
      const out = await webSearch(query, maxResults ?? DEFAULT_MAX_RESULTS, { keys: deps.keys(), post: deps.post })
      record({
        ...base, outcome: 'completed', provider: out.provider,
        ...(out.fallback ? { fallbackReason: out.fallback.reason } : {}),
        status: out.status, bytes: out.bytes, results: out.results.length, durationMs: elapsed(),
      })
      return { content: [{ type: 'text' as const, text: formatSearch(query, out) }] }
    } catch (e) {
      const failed = e instanceof WebSearchError
      record({
        ...base, outcome: 'failed', status: null, bytes: 0, durationMs: elapsed(),
        ...(failed ? { fallbackReason: e.primary } : {}),
        error: failed ? `exa_${e.fallback}` : 'search_failed',
      })
      return refusal(failed ? e.message : 'web search failed')
    }
  })

  server.registerTool('web_fetch', {
    title: 'Fetch a web page',
    description:
      'Read one public web page (http or https) as text. HTML is converted to readable text; ' +
      'plain text, JSON and XML are returned as they are; binary files are refused. ' +
      'Every call is recorded and counted against this agent\'s fetch limit.',
    inputSchema: {
      url: z.string().max(MAX_URL_LENGTH).describe('The absolute http(s) URL to read.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ url }) => {
    const { admission, base, elapsed } = begin('web_fetch', fetchTarget(url))
    if (!admission.ok) {
      record({ ...base, outcome: 'denied', status: null, bytes: 0, durationMs: 0, error: admission.reason })
      return refusal(admission.message)
    }
    try {
      const page = await fetchPage(url, deps.fetchDeps, deps.fetchLimits)
      const finalTarget = fetchTarget(page.url)
      record({
        ...base, outcome: 'completed', ...(finalTarget !== base.target ? { finalTarget } : {}),
        status: page.status, contentType: page.contentType, bytes: page.bytes,
        ...(page.truncated ? { truncated: true } : {}), durationMs: elapsed(),
      })
      return { content: [{ type: 'text' as const, text: formatPage(url, page) }] }
    } catch (e) {
      // Only this module's own errors carry a code and a fixed message; anything else says nothing.
      const coded = e instanceof BlockedTargetError || e instanceof WebFetchError
      const code = coded ? e.code : 'network'
      record({ ...base, outcome: DENIED.has(code) ? 'denied' : 'failed', status: null, bytes: 0, durationMs: elapsed(), error: code })
      return refusal(coded ? e.message : 'the fetch failed')
    }
  })

  return server
}

export interface WebConnectorOptions {
  limits?: Partial<WebLimits>
  keys?: () => SearchKeys
  now?: () => number
  post?: HttpPost
  fetchDeps?: FetchDeps
  fetchLimits?: Partial<FetchLimits>
}

/**
 * Web tool servers for many runs and agents: one limiter per run, shared by its agents, closed for
 * good by `endRun`. The shape the connectors bridge registers (`createServer(ctx)`), and what the
 * local loopback endpoint serves.
 */
export function webConnector(opts: WebConnectorOptions = {}) {
  const limiters = new Map<string, WebLimiter>()
  const ended = new Set<string>()
  const limiterFor = (runId: string): WebLimiter => {
    let limiter = limiters.get(runId)
    if (!limiter) {
      limiter = new WebLimiter(opts.limits)
      if (ended.has(runId)) limiter.close()
      else limiters.set(runId, limiter)
    }
    return limiter
  }
  return {
    createServer(ctx: { runId: string; agentId: string; evidence: WebEvidenceSink }): McpServer {
      return createWebMcpServer({
        runId: ctx.runId,
        agentId: ctx.agentId,
        evidence: ctx.evidence,
        limiter: limiterFor(ctx.runId),
        keys: opts.keys ?? (() => readWebSearchKeys()),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.post ? { post: opts.post } : {}),
        ...(opts.fetchDeps ? { fetchDeps: opts.fetchDeps } : {}),
        ...(opts.fetchLimits ? { fetchLimits: opts.fetchLimits } : {}),
      })
    },
    endRun(runId: string): void {
      ended.add(runId)
      limiters.get(runId)?.close()
      limiters.delete(runId)
    },
  }
}
