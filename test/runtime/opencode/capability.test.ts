import { describe, expect, test } from 'vitest'
import { classifyProbe, summarizeValidation, validateModel } from '../../../src/runtime/opencode/capability.js'
import type { OpenCodeClient } from '../../../src/runtime/opencode/client.js'

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
