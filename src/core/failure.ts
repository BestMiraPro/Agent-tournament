/**
 * Why one agent's attempt failed, in a form that is safe to publish.
 *
 * `message` is a short human summary. The optional fields keep apart failures that used to
 * collapse into the same text: an OpenCode HTTP error (`httpStatus`, error `code`, and the
 * `ref` that maps it to the server's own log) versus a transport failure whose `code` is the
 * socket-level cause (`UND_ERR_HEADERS_TIMEOUT`, `ECONNRESET`, ...).
 *
 * Nothing here may carry credentials, request headers or a provider response dump: every
 * field is validated or redacted before it leaves this module.
 */
export interface AgentFailure {
  message: string
  httpStatus?: number
  code?: string
  ref?: string
}

const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SAFE_REF = /^err_[A-Za-z0-9]{1,64}$/
const MAX_MESSAGE = 300
const MAX_TEXT = 500

export function isSafeCode(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CODE.test(value)
}

export function isSafeRef(value: unknown): value is string {
  return typeof value === 'string' && SAFE_REF.test(value)
}

/** Removes userinfo from anything URL-shaped: `scheme://user:pass@host` -> `scheme://[redacted]@host`. */
function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** A socket-level cause code, e.g. undici's `UND_ERR_HEADERS_TIMEOUT` under `TypeError('fetch failed')`. */
function causeCode(e: unknown): string | undefined {
  const cause = (e as { cause?: unknown } | null | undefined)?.cause
  const code = (cause as { code?: unknown } | null | undefined)?.code
  return isSafeCode(code) ? code : undefined
}

function field<T>(e: unknown, key: string): T | undefined {
  return typeof e === 'object' && e !== null ? (e as Record<string, T>)[key] : undefined
}

export function describeFailure(e: unknown): AgentFailure {
  // Matched by shape rather than by importing the runtime client, so core stays runtime-free.
  if (e instanceof Error && e.name === 'OpenCodeHttpError') {
    const httpStatus = field<number>(e, 'httpStatus')
    const name = field<unknown>(e, 'errorName')
    const ref = field<unknown>(e, 'ref')
    const code = isSafeCode(name) ? name : undefined
    const safeRef = isSafeRef(ref) ? ref : undefined
    return {
      message: cap(`OpenCode returned HTTP ${httpStatus}${code ? ` ${code}` : ''}${safeRef ? ` (ref ${safeRef})` : ''}`, MAX_MESSAGE),
      ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
      ...(code ? { code } : {}),
      ...(safeRef ? { ref: safeRef } : {}),
    }
  }
  if (e instanceof Error && e.name === 'OpenCodeTimeoutError') {
    return { message: cap(redact(e.message), MAX_MESSAGE), code: 'OPENCODE_TIMEOUT' }
  }
  if (e instanceof Error) {
    const code = causeCode(e)
    if (code) {
      // Undici reports every network-level failure as TypeError('fetch failed') and puts the
      // actual reason in `cause`; without the code, a headers timeout and a refused
      // connection read identically.
      const prefix = e instanceof TypeError && /fetch failed/i.test(e.message) ? 'Transport failure: ' : ''
      return { message: cap(redact(`${prefix}${e.message} (${code})`), MAX_MESSAGE), code }
    }
    return { message: cap(redact(e.message || String(e)), MAX_MESSAGE) }
  }
  return { message: cap(redact(String(e)), MAX_MESSAGE) }
}

/** A provider error that arrived inside a terminal prompt response. */
export function describeProviderError(error: { name?: unknown; statusCode?: unknown; message?: unknown }): AgentFailure {
  const code = isSafeCode(error.name) ? error.name : undefined
  const httpStatus = typeof error.statusCode === 'number' ? error.statusCode : undefined
  const detail = typeof error.message === 'string' ? error.message : ''
  const label = `Provider error${code ? ` ${code}` : ''}${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ''}`
  return {
    message: cap(redact(detail ? `${label}: ${detail}` : label), MAX_MESSAGE),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(code ? { code } : {}),
  }
}

/** A failure the engine only has as text, such as a provisioning error. */
export function failureFromText(text: string, code?: string): AgentFailure {
  return { message: cap(redact(text), MAX_MESSAGE), ...(isSafeCode(code) ? { code } : {}) }
}

/**
 * The text persisted to `submissions.error_text`, which is all a reopened run has.
 *
 * Keeps the transport cause that `String(error)` drops: two agents in the September 13 run
 * were stored as nothing more than "TypeError: fetch failed".
 */
export function errorTextFor(e: unknown): string {
  const base = String(e)
  const code = causeCode(e)
  return cap(redact(code && !base.includes(code) ? `${base} (cause ${code})` : base), MAX_TEXT)
}
