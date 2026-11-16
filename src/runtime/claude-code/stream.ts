import type { AgentFailure } from '../../core/failure.js'
import { redactSecrets } from '../../core/redact.js'
import type { ActivityItemInput, ActivityKind } from '../../engine/events.js'

/**
 * Translates `claude -p --output-format stream-json --verbose` into the activity the OpenCode bridge
 * produces, plus the usage, rate-limit reading and terminal result the runner needs. Pure: fed one
 * parsed line at a time, so it is tested against recorded streams.
 *
 * Shapes are those of Claude Code 2.1.325 (test/fixtures/claude-code-2.1.325/).
 */

const MAX_SUMMARY_CHARS = 300
const MAX_ITEM_BYTES = 8 * 1024
/** Input fields that name what a tool acted on; the rest of a tool's input stays private. */
const TOOL_TARGET_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query']

export interface ClaudeUsage {
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

export interface RateLimitReading {
  status: string
  rateLimitType: string | null
  /** Unix seconds. */
  resetsAt: number | null
  /** Highest utilisation across the reported windows, 0–1, when reported. */
  utilization: number | null
}

export interface ClaudeResult {
  isError: boolean
  subtype: string
  apiErrorStatus: number | null
  terminalReason: string | null
  text: string
  usage: ClaudeUsage | null
  structured: unknown
}

export type StreamEffect =
  | { type: 'session'; sessionId: string }
  | { type: 'activity'; kind: ActivityKind; detail: string; item: ActivityItemInput }
  | { type: 'rate_limit'; reading: RateLimitReading }
  | { type: 'result'; result: ClaudeResult }

/** Strips credentials, Claude tokens included, before anything is relayed or stored. */
export function redactClaude(text: string): string {
  return redactSecrets(text).replace(/\bsk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
}

function capChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function capBytes(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false }
  return { text: Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, ''), truncated: true }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function toolSummary(name: string, input: unknown): string {
  const fields = record(input)
  const target = TOOL_TARGET_KEYS.map((k) => fields[k]).find((v): v is string => typeof v === 'string' && v.length > 0)
  return capChars(redactClaude(target ? `${name}: ${target}` : name), MAX_SUMMARY_CHARS)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = record(part)
        if (p.type === 'text' && typeof p.text === 'string') return p.text
        if (p.type === 'image') return '[image]'
        return ''
      })
      .filter((s) => s.length > 0)
      .join('\n')
  }
  return ''
}

export function usageOf(raw: unknown): ClaudeUsage {
  const u = record(raw)
  return {
    tokensIn: num(u.input_tokens),
    tokensOut: num(u.output_tokens),
    tokensCacheRead: num(u.cache_read_input_tokens),
    tokensCacheWrite: num(u.cache_creation_input_tokens),
  }
}

function readingOf(raw: unknown): RateLimitReading {
  const r = record(raw)
  const windows = record(r.unifiedWindows)
  let utilization: number | null = null
  for (const w of Object.values(windows)) {
    const u = record(w).utilization
    if (typeof u === 'number' && Number.isFinite(u)) utilization = Math.max(utilization ?? 0, u)
  }
  return {
    status: typeof r.status === 'string' ? r.status : 'unknown',
    rateLimitType: typeof r.rateLimitType === 'string' ? r.rateLimitType : null,
    resetsAt: typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) ? r.resetsAt : null,
    utilization,
  }
}

export class ClaudeStreamTranslator {
  sessionId: string | null = null
  result: ClaudeResult | null = null
  rateLimit: RateLimitReading | null = null
  /** Per request (`message.id`): the CLI repeats a message's usage on each of its content lines. */
  private perMessage = new Map<string, ClaudeUsage>()
  private toolSummaries = new Map<string, string>()
  private textCount = 0

  constructor(private now: () => number = Date.now) {}

  /** What has been observed so far: the result's totals once it arrived, else the per-request sum. */
  usage(): ClaudeUsage | null {
    if (this.result?.usage) return this.result.usage
    if (this.perMessage.size === 0) return null
    const total: ClaudeUsage = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }
    for (const u of this.perMessage.values()) {
      total.tokensIn += u.tokensIn
      total.tokensOut += u.tokensOut
      total.tokensCacheRead += u.tokensCacheRead
      total.tokensCacheWrite += u.tokensCacheWrite
    }
    return total
  }

  feed(raw: unknown): StreamEffect[] {
    const o = record(raw)
    const out: StreamEffect[] = []
    const sessionId = typeof o.session_id === 'string' ? o.session_id : this.sessionId ?? ''
    switch (o.type) {
      case 'system': {
        if (o.subtype === 'init' && typeof o.session_id === 'string' && this.sessionId === null) {
          this.sessionId = o.session_id
          out.push({ type: 'session', sessionId: o.session_id })
        }
        return out
      }
      case 'assistant': {
        const message = record(o.message)
        if (typeof message.id === 'string' && message.usage) this.perMessage.set(message.id, usageOf(message.usage))
        const blocks = Array.isArray(message.content) ? message.content : []
        for (const raw of blocks) {
          const block = record(raw)
          if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            const body = capBytes(redactClaude(block.text), MAX_ITEM_BYTES)
            const id = typeof o.uuid === 'string' ? `text:${o.uuid}` : `text:${sessionId}:${++this.textCount}`
            out.push({
              type: 'activity', kind: 'text', detail: body.text.slice(0, 200),
              item: { id, sessionId, kind: 'text', summary: body.text, ...(body.truncated ? { truncated: true } : {}), observedAt: this.now() },
            })
          } else if (block.type === 'tool_use' && typeof block.id === 'string') {
            const summary = toolSummary(typeof block.name === 'string' ? block.name : 'tool', block.input)
            this.toolSummaries.set(block.id, summary)
            out.push({
              type: 'activity', kind: 'tool', detail: summary,
              item: { id: block.id, sessionId, kind: 'tool', status: 'running', summary, observedAt: this.now() },
            })
          }
          // Thinking stays private, as reasoning parts do on the OpenCode path.
        }
        return out
      }
      case 'user': {
        const message = record(o.message)
        const blocks = Array.isArray(message.content) ? message.content : []
        for (const raw of blocks) {
          const block = record(raw)
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          const summary = this.toolSummaries.get(block.tool_use_id) ?? 'tool'
          const output = capBytes(redactClaude(resultText(block.content)), MAX_ITEM_BYTES)
          out.push({
            type: 'activity', kind: 'tool', detail: summary,
            item: {
              id: block.tool_use_id, sessionId, kind: 'tool', status: block.is_error === true ? 'error' : 'completed', summary,
              ...(output.text ? { output: output.text, ...(output.truncated ? { truncated: true } : {}) } : {}),
              observedAt: this.now(),
            },
          })
        }
        return out
      }
      case 'rate_limit_event': {
        this.rateLimit = readingOf(o.rate_limit_info)
        out.push({ type: 'rate_limit', reading: this.rateLimit })
        return out
      }
      case 'result': {
        const result: ClaudeResult = {
          isError: o.is_error === true || (typeof o.subtype === 'string' && o.subtype.startsWith('error')),
          subtype: typeof o.subtype === 'string' ? o.subtype : 'unknown',
          apiErrorStatus: typeof o.api_error_status === 'number' ? o.api_error_status : null,
          terminalReason: typeof o.terminal_reason === 'string' ? o.terminal_reason : null,
          text: typeof o.result === 'string' ? o.result : '',
          usage: o.usage ? usageOf(o.usage) : null,
          structured: o.structured_output ?? null,
        }
        this.result = result
        out.push({ type: 'result', result })
        if (result.isError) {
          const failure = classifyClaudeFailure({ result, rateLimit: this.rateLimit })
          const summary = capChars(redactClaude(failure.message), MAX_SUMMARY_CHARS)
          out.push({
            type: 'activity', kind: 'error', detail: summary,
            item: { id: `error:${sessionId}`, sessionId, kind: 'error', status: 'error', summary, observedAt: this.now() },
          })
        }
        return out
      }
      default:
        return out
    }
  }
}

const AUTH_HINTS = [
  'failed to authenticate', 'oauth token has expired', 'oauth token is invalid', 'authentication_error',
  'invalid api key', 'not logged in', 'please run /login', 'claude setup-token', 'invalid bearer token',
]
const LIMIT_HINTS = ['usage limit', 'rate limit', 'hit your', 'limit reached', 'rate_limit_error']

export const CLAUDE_FAILURE_CODES = {
  cliMissing: 'CLAUDE_CLI_MISSING',
  authExpired: 'CLAUDE_AUTH_EXPIRED',
  limit: 'SUBSCRIPTION_LIMIT',
  modelUnavailable: 'CLAUDE_MODEL_UNAVAILABLE',
  error: 'CLAUDE_ERROR',
} as const

function resetText(resetsAt: number | null): string {
  if (resetsAt === null) return 'it resets on Claude\'s schedule'
  return `it resets at ${new Date(resetsAt * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`
}

/** A usage-limit failure, worded so nobody reads it as the agent's own failure. */
export function subscriptionLimitFailure(reading: Pick<RateLimitReading, 'rateLimitType' | 'resetsAt'> | null): AgentFailure {
  const window = reading?.rateLimitType ? ` (${reading.rateLimitType.replace(/_/g, '-')} window)` : ''
  return {
    code: CLAUDE_FAILURE_CODES.limit,
    httpStatus: 429,
    message: capChars(`Claude subscription usage limit reached${window}; ${resetText(reading?.resetsAt ?? null)}. ` +
      'This is the subscription\'s limit, not the agent\'s failure.', 300),
  }
}

/**
 * Why a Claude call failed, as a publishable failure: an expired sign-in, an exhausted subscription
 * and a missing model are told apart, because each asks the operator for something different.
 */
export function classifyClaudeFailure(input: {
  result?: ClaudeResult | null
  rateLimit?: RateLimitReading | null
  /** stderr tail or other text when there was no result. */
  text?: string
}): AgentFailure {
  const status = input.result?.apiErrorStatus ?? null
  const text = `${input.result?.text ?? ''}\n${input.text ?? ''}`
  const low = text.toLowerCase()
  if (input.rateLimit?.status === 'rejected' || status === 429 || LIMIT_HINTS.some((h) => low.includes(h))) {
    return subscriptionLimitFailure(input.rateLimit ?? null)
  }
  if (status === 401 || status === 403 || AUTH_HINTS.some((h) => low.includes(h))) {
    return {
      code: CLAUDE_FAILURE_CODES.authExpired,
      ...(status !== null ? { httpStatus: status } : {}),
      message: 'Claude subscription sign-in is missing or expired. Paste a fresh `claude setup-token` value under ' +
        'Subscriptions, or run `claude auth login` on this machine.',
    }
  }
  if (low.includes('model') && (low.includes('not found') || low.includes('not available') || low.includes('invalid model') || low.includes('issue with the selected model'))) {
    return {
      code: CLAUDE_FAILURE_CODES.modelUnavailable,
      ...(status !== null ? { httpStatus: status } : {}),
      message: capChars(redactClaude(`Claude model unavailable on this subscription: ${text.trim()}`), 300),
    }
  }
  const detail = text.trim()
  return {
    code: CLAUDE_FAILURE_CODES.error,
    ...(status !== null ? { httpStatus: status } : {}),
    message: capChars(redactClaude(`Claude Code failed${status !== null ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`), 300),
  }
}

/** Splits a byte stream into lines; a line over `maxLine` is dropped rather than buffered without bound. */
export function createJsonLineReader(onObject: (obj: unknown) => void, maxLine = 32 * 1024 * 1024) {
  let buffer = ''
  let skipping = false
  return {
    push(chunk: string): void {
      buffer += chunk
      for (;;) {
        const i = buffer.indexOf('\n')
        if (i < 0) break
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 1)
        if (skipping) {
          skipping = false
          continue
        }
        parse(line)
      }
      if (buffer.length > maxLine) {
        buffer = ''
        skipping = true
      }
    },
    end(): void {
      if (!skipping && buffer.trim().length > 0) parse(buffer)
      buffer = ''
    },
  }
  function parse(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    try {
      onObject(JSON.parse(trimmed))
    } catch {
      /* not a JSON line: the CLI prints nothing else on stdout, so it is ignored */
    }
  }
}
