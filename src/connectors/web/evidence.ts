import { redactSecrets } from '../../core/redact.js'
import type { FallbackReason, SearchProviderId } from './search.js'

/**
 * What the host keeps about one web tool call: allowlisted metadata, never page text, snippets or a
 * provider's error body. Search targets are the query, fetch targets host + path (query strings and
 * fragments often carry tokens), both redacted and bounded.
 */

export type WebTool = 'web_search' | 'web_fetch'

export interface WebCallRecord {
  /** `W<n>`, numbered per run. */
  id: string
  runId: string
  agentId: string
  tool: WebTool
  target: string
  /** Fetch: where redirects ended, when somewhere else. */
  finalTarget?: string
  outcome: 'completed' | 'denied' | 'failed'
  /** Search: who answered. */
  provider?: SearchProviderId
  /** Search: why LangSearch did not answer. */
  fallbackReason?: FallbackReason
  status: number | null
  /** Bytes received: the fetched body, or the answering provider's response. */
  bytes: number
  results?: number
  contentType?: string
  truncated?: boolean
  startedAt: number
  durationMs: number
  /** A fixed code: a limit, a blocked address, a timeout. */
  error?: string
}

export type WebEvidenceSink = (record: WebCallRecord) => void

const MAX_TARGET = 200

export function searchTarget(query: string): string {
  return redactSecrets(query.replace(/\s+/g, ' ').trim()).slice(0, MAX_TARGET)
}

export function fetchTarget(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '(invalid URL)'
  }
  const target = redactSecrets(`${url.host}${url.pathname}`)
  return target.length > MAX_TARGET ? `${target.slice(0, MAX_TARGET)}…` : target
}

const PROVIDER_NAME: Record<SearchProviderId, string> = { langsearch: 'LangSearch', exa: 'Exa' }

export function describeWebCall(r: WebCallRecord): { summary: string; detail: string } {
  const subject = r.tool === 'web_search' ? `web_search "${r.target}"` : `web_fetch ${r.target}`
  let summary: string
  if (r.outcome === 'denied') {
    summary = `${subject} refused: ${r.error ?? 'denied'}`
  } else if (r.outcome === 'failed') {
    const why = r.tool === 'web_search' && r.fallbackReason ? `LangSearch ${r.fallbackReason}, ${r.error ?? 'failed'}` : r.error ?? 'failed'
    summary = `${subject} failed: ${why}`
  } else if (r.tool === 'web_search') {
    const via = r.provider ? ` via ${PROVIDER_NAME[r.provider]}` : ''
    const fallback = r.fallbackReason ? ` (LangSearch ${r.fallbackReason})` : ''
    summary = `${subject}${via}${fallback}: ${r.results ?? 0} results`
  } else {
    const redirected = r.finalTarget ? ` → ${r.finalTarget}` : ''
    summary = `${subject}${redirected}: ${r.status ?? '?'}, ${r.bytes} bytes${r.truncated ? ', truncated' : ''}`
  }
  const fields: [string, unknown][] = [
    ['outcome', r.outcome], ['provider', r.provider], ['fallback_reason', r.fallbackReason], ['final_target', r.finalTarget],
    ['status', r.status], ['content_type', r.contentType], ['bytes', r.bytes], ['results', r.results], ['truncated', r.truncated],
    ['duration_ms', r.durationMs], ['error', r.error],
  ]
  const detail = fields.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${String(v)}`).join(' ')
  return { summary, detail }
}
