import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isSafeCode, isSafeRef } from '../../core/failure.js'
import type { OpenCodeModelRef } from './model-id.js'

export interface TokenUsage {
  total: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface PromptPart {
  type: string
  text?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: unknown
    metadata?: { valid?: boolean }
  }
}

export interface PromptResponse {
  info: {
    cost?: number
    tokens?: TokenUsage
    modelID?: string
    providerID?: string
    error?: { name?: string; data?: { message?: string; statusCode?: number } }
  }
  parts?: PromptPart[]
}

export interface PromptBody {
  model: OpenCodeModelRef
  /** Named agent profile; OpenCode uses its implicit `build` agent when absent. */
  agent?: string
  system?: string
  parts: { type: 'text'; text: string }[]
  format?: { type: 'json_schema'; schema: unknown; retryCount?: number }
}

export interface ProvidersResponse {
  providers: { id: string; models: Record<string, unknown> }[]
  default: Record<string, string>
}

export interface OpenCodeClientOptions {
  baseUrl: string
  /** Per-request timeout. Dead models hang rather than erroring, so this is mandatory. */
  timeoutMs: number
  /** Test seam; production uses `nodeHttpTransport`. */
  transport?: HttpTransport
}

/** One HTTP exchange. Resolves with any status; rejects only for transport failure or abort. */
export type HttpTransport = (req: {
  method: string
  url: URL
  body: string | undefined
  timeoutMs: number
  signal: AbortSignal
}) => Promise<{ status: number; text: string }>

/** A socket-level failure talking to OpenCode. Its `cause` carries the Node error and its code. */
export class OpenCodeTransportError extends Error {
  constructor(cause: unknown) {
    super(`OpenCode transport failure: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'OpenCodeTransportError'
  }
}

/**
 * How long a socket may sit idle before the transport gives up on its own.
 *
 * Always longer than the request's own deadline, so the application deadline is the one
 * that decides. Node's built-in fetch cannot promise that: it carries a fixed 300s
 * headers timeout, and an OpenCode prompt sends no headers until the agent is done — so
 * every agent that worked past five minutes lost its response ("fetch failed" at ~307s on
 * September 13) while the configured deadline was 600s. The margin only backstops a
 * socket that a missed abort would otherwise leave open forever.
 */
export function transportAllowanceMs(timeoutMs: number): number {
  return timeoutMs + 30_000
}

/** For a request with no deadline: no local abort and no socket idle cut. */
const unbounded = (ms: number) => !Number.isFinite(ms)

/**
 * `node:http(s)` with no deadline of its own beyond the idle backstop above; the caller's
 * AbortSignal ends the exchange and destroys the socket. Adds no dependency.
 */
export const nodeHttpTransport: HttpTransport = ({ method, url, body, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const headers: Record<string, string | number> = { 'content-type': 'application/json' }
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      // An abort surfaces as its own AbortError so the client can classify its deadline.
      reject(signal.aborted ? error : new OpenCodeTransportError(error))
    }
    const req = send(url, { method, headers, signal }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
      })
      res.on('error', fail)
      // A response cut off mid-body closes without completing; `aborted` is deprecated.
      res.on('close', () => {
        if (!res.complete) fail(Object.assign(new Error('response closed before it completed'), { code: 'ECONNRESET' }))
      })
    })
    // An agent prompt with no limit may legitimately stay silent for a long step; setTimeout with
    // Infinity would instead fire at once.
    if (!unbounded(timeoutMs)) {
      req.setTimeout(transportAllowanceMs(timeoutMs), () => {
        req.destroy(Object.assign(new Error(`socket idle beyond ${transportAllowanceMs(timeoutMs)}ms`), { code: 'OPENCODE_SOCKET_IDLE' }))
      })
    }
    req.on('error', fail)
    req.end(body)
  })

/** Our HTTP deadline expired; this says nothing about remote execution stopping. */
export class OpenCodeTimeoutError extends Error {
  constructor(timeoutMs: number, cause: unknown) {
    super(`OpenCode request exceeded ${timeoutMs}ms`, { cause })
    this.name = 'OpenCodeTimeoutError'
  }
}

/**
 * A non-2xx response from OpenCode, kept structured.
 *
 * The message keeps its long-standing readable form. The fields exist because a 500's
 * error name and `ref` are what map a generic failure to the server's own log — the
 * September 13 W&B failures were HTTP 500 UnknownError whose refs resolved to
 * ProviderModelNotFoundError — and flattening them into a string lost that. Only
 * validated values are stored; the raw body never becomes a field.
 */
export class OpenCodeHttpError extends Error {
  readonly httpStatus: number
  readonly errorName: string | undefined
  readonly ref: string | undefined

  constructor(input: { method: string; path: string; status: number; bodyText: string }) {
    super(`OpenCode ${input.method} ${input.path} failed: ${input.status} ${input.bodyText.slice(0, 300)}`)
    this.name = 'OpenCodeHttpError'
    this.httpStatus = input.status
    let name: unknown
    let ref: unknown
    try {
      const parsed = JSON.parse(input.bodyText) as { name?: unknown; data?: { ref?: unknown } }
      name = parsed?.name
      ref = parsed?.data?.ref
    } catch {
      /* not JSON: the status alone is what is known */
    }
    this.errorName = isSafeCode(name) ? name : undefined
    this.ref = isSafeRef(ref) ? ref : undefined
  }
}

export class OpenCodeClient {
  constructor(private opts: OpenCodeClientOptions) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { directory?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = new URL(this.opts.baseUrl + path)
    if (opts.directory) url.searchParams.set('directory', opts.directory)

    const controller = new AbortController()
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs
    const timer = unbounded(timeoutMs) ? undefined : setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await (this.opts.transport ?? nodeHttpTransport)({
        method,
        url,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        timeoutMs,
        signal: controller.signal,
      })
      const text = res.text
      if (res.status < 200 || res.status >= 300) {
        throw new OpenCodeHttpError({ method, path, status: res.status, bodyText: text })
      }
      return (text ? JSON.parse(text) : null) as T
    } catch (error) {
      if (controller.signal.aborted) throw new OpenCodeTimeoutError(timeoutMs, error)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.request('GET', '/global/health', { timeoutMs: 3000 })
      return true
    } catch {
      return false
    }
  }

  /**
   * The runtime's own reported version, or null when it reports none usable.
   *
   * Used to name the runtime in a "model unavailable" failure: host and shard can differ,
   * so the message must say which runtime refused the model.
   */
  async version(): Promise<string | null> {
    try {
      const body = await this.request<{ version?: unknown } | null>('GET', '/global/health', { timeoutMs: 3000 })
      const version = body?.version
      return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(version) ? version : null
    } catch {
      return null
    }
  }

  async providers(): Promise<ProvidersResponse> {
    return this.request<ProvidersResponse>('GET', '/config/providers')
  }

  async createSession(directory: string, title: string): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/session', { directory, body: { title } })
  }

  async prompt(
    sessionId: string,
    directory: string,
    body: PromptBody,
    timeoutMs?: number,
  ): Promise<PromptResponse> {
    return this.request<PromptResponse>('POST', `/session/${sessionId}/message`, {
      directory,
      body,
      timeoutMs,
    })
  }

  /**
   * Queues a message for a session and returns at once (204), without waiting for a reply.
   *
   * Verified against opencode 1.18.21 on September 16 2026: sent while the session was busy, the
   * message waited for the running tool call to finish and the agent acted on it at its next
   * step; the original blocking prompt returned only when the session went idle.
   */
  async promptAsync(sessionId: string, directory: string, body: PromptBody): Promise<void> {
    await this.request('POST', `/session/${sessionId}/prompt_async`, { directory, body, timeoutMs: 30_000 })
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.request('POST', `/session/${sessionId}/abort`, { directory, timeoutMs: 5000 })
  }

  /**
   * Whether the server says this session is still working. `busy` and `retry` are working;
   * a session absent from the status map, or reported `idle`, is not. Any failure to read it
   * is `unknown`, never idle.
   *
   * The directory is required: verified against opencode 1.18.21 on September 15 2026, the
   * status map without it came back empty while the session was busy.
   */
  async sessionStatus(sessionId: string, directory: string): Promise<'busy' | 'idle' | 'unknown'> {
    try {
      const map = await this.request<Record<string, { type?: unknown }> | null>('GET', '/session/status', { directory, timeoutMs: 5000 })
      if (map === null || typeof map !== 'object' || Array.isArray(map)) return 'unknown'
      const entry = map[sessionId]
      if (entry === undefined || entry?.type === 'idle') return 'idle'
      return 'busy'
    } catch {
      return 'unknown'
    }
  }
}

/**
 * Structured output does NOT appear in text parts. It arrives as a tool part named
 * `StructuredOutput`, already validated server-side. Verified against a live server.
 */
export function extractStructured(res: PromptResponse): unknown | null {
  const part = res.parts?.find((p) => p.type === 'tool' && p.tool === 'StructuredOutput')
  if (!part) return null
  if (part.state?.metadata?.valid === false) return null
  return part.state?.input ?? null
}

export function extractText(res: PromptResponse): string {
  return (res.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
}
