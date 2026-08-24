import type { OpenCodeClient } from './client.js'
import { extractStructured, extractText } from './client.js'
import { splitModelId } from './model-id.js'

export type ProbeKind = 'text' | 'structured'
export type ModelRole = 'worker' | 'judge' | 'reflect'

export interface ProbeOutcome {
  structured: unknown | null
  text: string
  error: { name?: string; data?: { message?: string; statusCode?: number } } | null
}

export interface ValidationResult {
  modelId: string
  role: ModelRole
  ok: boolean
  reason: string | null
}

const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false,
}

export function classifyProbe(outcome: ProbeOutcome, kind: ProbeKind): { ok: boolean; reason: string | null } {
  if (outcome.error) {
    const code = outcome.error.data?.statusCode ?? outcome.error.name ?? 'error'
    const msg = outcome.error.data?.message ?? ''
    return { ok: false, reason: `provider error ${code}: ${msg}`.trim() }
  }
  if (kind === 'structured') {
    return outcome.structured === null
      ? { ok: false, reason: 'model did not produce structured output' }
      : { ok: true, reason: null }
  }
  return outcome.text.trim().length > 0
    ? { ok: true, reason: null }
    : { ok: false, reason: 'model produced no text output' }
}

export function summarizeValidation(results: ValidationResult[]): {
  usable: string[]
  unusable: { modelId: string; role: ModelRole; reason: string }[]
} {
  return {
    usable: results.filter((r) => r.ok).map((r) => r.modelId),
    unusable: results
      .filter((r) => !r.ok)
      .map((r) => ({ modelId: r.modelId, role: r.role, reason: r.reason ?? 'unknown' })),
  }
}

/** Probes one model for the capability its role requires. */
export async function validateModel(
  client: OpenCodeClient,
  directory: string,
  modelId: string,
  role: ModelRole,
  timeoutMs = 60_000,
): Promise<ValidationResult> {
  const kind: ProbeKind = role === 'worker' ? 'text' : 'structured'
  try {
    const session = await client.createSession(directory, `validate-${modelId}`)
    const res = await client.prompt(
      session.id,
      directory,
      {
        model: splitModelId(modelId),
        parts: [{ type: 'text', text: 'Reply with the single word: ok' }],
        ...(kind === 'structured'
          ? { format: { type: 'json_schema' as const, schema: PROBE_SCHEMA, retryCount: 0 } }
          : {}),
      },
      timeoutMs,
    )
    const { ok, reason } = classifyProbe(
      { structured: extractStructured(res), text: extractText(res), error: res.info?.error ?? null },
      kind,
    )
    return { modelId, role, ok, reason }
  } catch (e) {
    return { modelId, role, ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) }
  }
}
