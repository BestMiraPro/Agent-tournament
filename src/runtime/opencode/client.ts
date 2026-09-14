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
}

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
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
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

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.request('POST', `/session/${sessionId}/abort`, { directory, timeoutMs: 5000 })
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
