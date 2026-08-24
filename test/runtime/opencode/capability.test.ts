import { describe, expect, test } from 'vitest'
import {
  classifyProbe,
  PROBE_SCHEMA,
  summarizeValidation,
  validateModel,
} from '../../../src/runtime/opencode/capability.js'
import type { OpenCodeClient } from '../../../src/runtime/opencode/client.js'

describe('PROBE_SCHEMA', () => {
  test('is structurally representative of the real schemas: a nested array of objects', () => {
    // The real capability failure this guards against: wandb/zai-org/GLM-5.2 passed a
    // probe using a flat {ok: string} schema, then failed on the real CRITERIA_JSON_SCHEMA,
    // which nests an array of objects with mixed (string + number) property types. A probe
    // schema simpler than production tells you nothing about production, so this asserts
    // the probe actually exercises nesting and arrays — not just a flat string.
    const properties = (PROBE_SCHEMA as { properties: Record<string, unknown> }).properties
    const arrayProp = Object.values(properties).find(
      (p): p is { type: string; items: { type: string; properties: Record<string, { type: string }> } } =>
        typeof p === 'object' && p !== null && (p as { type?: string }).type === 'array',
    )

    expect(arrayProp).toBeTruthy()
    expect(arrayProp!.items.type).toBe('object')

    const itemPropTypes = Object.values(arrayProp!.items.properties).map((p) => p.type)
    expect(itemPropTypes).toContain('string')
    expect(itemPropTypes).toContain('number')

    // Also has a top-level string property alongside the array, per the fix's shape.
    const topLevelTypes = Object.values(properties).map((p) => (p as { type?: string }).type)
    expect(topLevelTypes).toContain('string')
  })
})

describe('classifyProbe', () => {
  test('reports ok when structured output came back', () => {
    expect(classifyProbe({ structured: { a: 1 }, text: '', error: null }, 'structured')).toEqual({
      ok: true, reason: null,
    })
  })

  test('reports failure when structured output was required but absent', () => {
    const r = classifyProbe({ structured: null, text: 'hello', error: null }, 'structured')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/structured/i)
  })

  test('accepts text-only output for a worker probe', () => {
    expect(classifyProbe({ structured: null, text: 'hello', error: null }, 'text')).toEqual({
      ok: true, reason: null,
    })
  })

  test('reports failure when a worker probe returned nothing', () => {
    const r = classifyProbe({ structured: null, text: '', error: null }, 'text')
    expect(r.ok).toBe(false)
  })

  test('surfaces a provider error with its status code', () => {
    const r = classifyProbe(
      { structured: null, text: '', error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } },
      'text',
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('404')
  })
})

describe('summarizeValidation', () => {
  test('separates usable from unusable models', () => {
    const s = summarizeValidation([
      { modelId: 'a/b', role: 'worker', ok: true, reason: null },
      { modelId: 'c/d', role: 'judge', ok: false, reason: '404' },
    ])
    expect(s.usable).toEqual(['a/b'])
    expect(s.unusable).toEqual([{ modelId: 'c/d', role: 'judge', reason: '404' }])
  })

  test('reports all usable when nothing failed', () => {
    const s = summarizeValidation([{ modelId: 'a/b', role: 'worker', ok: true, reason: null }])
    expect(s.unusable).toEqual([])
  })
})

describe('validateModel', () => {
  const fakeClient = (prompt: OpenCodeClient['prompt']): OpenCodeClient =>
    ({ createSession: async () => ({ id: 'ses_1' }), prompt }) as unknown as OpenCodeClient

  test('retries a transport-level failure and succeeds once the provider responds', async () => {
    let attempts = 0
    const client = fakeClient(async () => {
      attempts++
      if (attempts < 3) throw new Error('fetch failed')
      return { info: {}, parts: [{ type: 'text', text: 'ok' }] } as any
    })
    const result = await validateModel(client, '/w', 'wandb/deepseek-ai/DeepSeek-V3.1', 'worker')
    expect(result.ok).toBe(true)
    expect(attempts).toBe(3)
  })

  test('gives up after exhausting attempts on a persistent transport failure, naming the count', async () => {
    let attempts = 0
    const client = fakeClient(async () => {
      attempts++
      throw new Error('fetch failed')
    })
    const result = await validateModel(client, '/w', 'wandb/meta-llama/Llama-3.1-8B', 'worker')
    expect(result.ok).toBe(false)
    expect(attempts).toBe(3)
    expect(result.reason).toMatch(/after 3 attempts/i)
  })

  test('does not retry a definitive 404 provider error', async () => {
    let attempts = 0
    const client = fakeClient(async () => {
      attempts++
      return {
        info: { error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } },
        parts: [],
      } as any
    })
    const result = await validateModel(client, '/w', 'wandb/moonshotai/Kimi-K3', 'worker')
    expect(result.ok).toBe(false)
    expect(attempts).toBe(1)
  })

  test('does not retry a clean verdict of missing structured output', async () => {
    let attempts = 0
    const client = fakeClient(async () => {
      attempts++
      return { info: {}, parts: [{ type: 'text', text: 'hello' }] } as any
    })
    const result = await validateModel(client, '/w', 'opencode/muse-spark-1.2-contributor-free', 'judge')
    expect(result.ok).toBe(false)
    expect(attempts).toBe(1)
  })
})
