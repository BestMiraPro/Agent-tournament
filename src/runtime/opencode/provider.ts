import type { CompleteRequest, Provider } from '../provider.js'
import type { OpenCodeClient } from './client.js'
import { extractStructured, extractText } from './client.js'
import { splitModelId } from './model-id.js'
import { promptOnce } from './one-shot.js'

export interface ProviderUsage {
  costUsd: number
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  calls: number
  /**
   * Calls whose session could not be confirmed stopped — a timeout or transport failure
   * after the prompt was dispatched. An abort was requested, but B15 settled that an
   * acknowledgement is not proof, so these are counted rather than assumed cleaned up.
   * Spend attributable to them never reaches `costUsd`, because no response came back.
   */
  abandonedSessions: number
}

export interface OpenCodeProviderOptions {
  timeoutMs: number
  retryCount?: number
}

/**
 * Non-agentic model calls (judge, reflect, criteria) against a real OpenCode server.
 *
 * When the caller supplies a JSON Schema, the request uses OpenCode's `json_schema`
 * output format, which validates and retries server-side, and the validated object is
 * returned as a JSON string so callers can keep parsing exactly as they did with the mock.
 * If the model has no structured-output capability, the raw text is returned instead and
 * the caller's existing `parseWithRepair` path handles it.
 */
export class OpenCodeProvider implements Provider {
  public usage: ProviderUsage = {
    costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, calls: 0,
    abandonedSessions: 0,
  }

  constructor(
    private client: OpenCodeClient,
    private directory: string,
    private opts: OpenCodeProviderOptions,
  ) {}

  async complete(req: CompleteRequest): Promise<string> {
    // A failed prompt used to leave its session live on the server, still generating and
    // still spending, and the judge's retry loop made three of them per failed call.
    const res = await promptOnce(
      this.client,
      this.directory,
      `${req.purpose}-call`,
      {
        model: splitModelId(req.modelId),
        parts: [{ type: 'text', text: req.prompt }],
        ...(req.schema
          ? { format: { type: 'json_schema' as const, schema: req.schema, retryCount: this.opts.retryCount ?? 2 } }
          : {}),
      },
      this.opts.timeoutMs,
      () => { this.usage.abandonedSessions++ },
    )

    this.record(res)

    if (res.info?.error) {
      const code = res.info.error.data?.statusCode ?? res.info.error.name ?? 'error'
      throw new Error(`OpenCodeProvider ${req.purpose} on ${req.modelId} failed: ${code} ${res.info.error.data?.message ?? ''}`)
    }

    if (req.schema) {
      const structured = extractStructured(res)
      if (structured !== null) return JSON.stringify(structured)
      // Model lacks structured output — fall through to text and let parseWithRepair try.
    }
    return extractText(res)
  }

  private record(res: { info?: { cost?: number; tokens?: { input: number; output: number; cache: { read: number; write: number } } } }): void {
    this.usage.calls++
    this.usage.costUsd += res.info?.cost ?? 0
    const t = res.info?.tokens
    if (t) {
      this.usage.tokensIn += t.input ?? 0
      this.usage.tokensOut += t.output ?? 0
      this.usage.tokensCacheRead += t.cache?.read ?? 0
      this.usage.tokensCacheWrite += t.cache?.write ?? 0
    }
  }
}
