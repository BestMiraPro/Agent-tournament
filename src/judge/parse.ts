import type { z } from 'zod'

/** Finds a JSON object in model output that may be fenced or wrapped in prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text]

  for (const c of candidates) {
    if (!c) continue
    const trimmed = c.trim()
    try {
      return JSON.parse(trimmed)
    } catch {
      const start = trimmed.indexOf('{')
      const end = trimmed.lastIndexOf('}')
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1))
        } catch {
          /* fall through to the next candidate */
        }
      }
    }
  }
  return null
}

/**
 * Parses model output against a schema, allowing exactly one repair attempt
 * that re-prompts with the parse error. More retries mean unbounded cost.
 *
 * Generic over the schema rather than over a bare value type: `z.ZodType<T>`
 * desugars to `ZodType<T, ZodTypeDef, T>`, which forces T to the schema's
 * INPUT type whenever input and output differ (`.default()`, `.transform()`,
 * `.catch()`, `z.coerce.*`). safeParse returns the OUTPUT type, so binding to
 * the input type mistypes every defaulted field as possibly-undefined.
 */
export async function parseWithRepair<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
  repair: (errorMessage: string) => Promise<string>,
): Promise<z.output<S>> {
  type T = z.output<S>
  const attempt = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    const json = extractJson(text)
    if (json === null) return { ok: false, error: 'no JSON object found in output' }
    const parsed = schema.safeParse(json)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: parsed.error.message }
  }

  const first = attempt(raw)
  if (first.ok) return first.value

  const second = attempt(await repair(first.error))
  if (second.ok) return second.value

  throw new Error(`parseWithRepair: repair attempt failed — ${second.error}`)
}
