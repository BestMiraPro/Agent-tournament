import type { OpenCodeClient } from './client.js'
import { extractStructured, extractText } from './client.js'
import { splitModelId } from './model-id.js'
import { promptOnce } from './one-shot.js'

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

/**
 * Structurally representative of the real schemas (RANKING_JSON_SCHEMA /
 * CRITERIA_JSON_SCHEMA): a top-level string alongside a nested array of objects
 * with mixed string/number properties. A probe schema simpler than what production
 * actually asks for proves nothing about production — wandb/zai-org/GLM-5.2 once
 * passed a flat `{ok: string}` probe and then failed on the real, nested schema.
 * Kept small (one array item requested) to stay cheap while still exercising
 * nesting and arrays.
 */
export const PROBE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'number' },
        },
        required: ['label', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'items'],
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

/**
 * Probes one model for the capability its role requires.
 *
 * Provider transport failures (thrown errors: `fetch failed`, aborts, socket errors) are
 * frequently transient, so they are retried up to `attempts` times. A clean provider verdict
 * (a 404, a 400, "model did not produce structured output") is definitive and reachable —
 * retrying it wastes time and money and cannot change the result, so it is never retried.
 */
export async function validateModel(
  client: OpenCodeClient,
  directory: string,
  modelId: string,
  role: ModelRole,
  timeoutMs = 120_000,
  attempts = 3,
): Promise<ValidationResult> {
  const kind: ProbeKind = role === 'worker' ? 'text' : 'structured'
  let lastError: unknown = null
  // Recorded so the reason a probe failed can name the sessions left unconfirmed.
  const abandonedSessions: string[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Each failed attempt used to abandon its own live session, so a flaky server left
      // three per model behind — all still generating against a paid endpoint.
      const res = await promptOnce(
        client,
        directory,
        `validate-${modelId}`,
        {
          model: splitModelId(modelId),
          parts: [
            {
              type: 'text',
              text:
                kind === 'structured'
                  ? 'Reply with a one-sentence summary and exactly one item with label "ok" and value 1.'
                  : 'Reply with the single word: ok',
            },
          ],
          ...(kind === 'structured'
            ? { format: { type: 'json_schema' as const, schema: PROBE_SCHEMA, retryCount: 0 } }
            : {}),
        },
        timeoutMs,
        (abandoned) => abandonedSessions.push(abandoned.sessionId),
      )
      const { ok, reason } = classifyProbe(
        { structured: extractStructured(res), text: extractText(res), error: res.info?.error ?? null },
        kind,
      )
      // A clean provider verdict (ok or a definitive failure) is final — don't retry it.
      return { modelId, role, ok, reason }
    } catch (e) {
      lastError = e
    }
  }
  const message = lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError)
  // Named, not swallowed: an abort was requested for each, but an acknowledgement is not
  // proof it stopped, so the reason says what was left behind rather than implying none was.
  const left = abandonedSessions.length > 0
    ? ` (${abandonedSessions.length} session(s) asked to stop, not confirmed)`
    : ''
  return { modelId, role, ok: false, reason: `after ${attempts} attempts: ${message}${left}` }
}
