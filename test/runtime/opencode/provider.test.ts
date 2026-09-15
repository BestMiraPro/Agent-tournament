import { describe, expect, test } from 'vitest'
import { OpenCodeProvider } from '../../../src/runtime/opencode/provider.js'
import type { PromptBody, PromptResponse } from '../../../src/runtime/opencode/client.js'

class FakeClient {
  public lastBody: PromptBody | null = null
  public lastDirectory: string | null = null
  constructor(private response: PromptResponse) {}
  async createSession() { return { id: 'ses_1' } }
  async prompt(_s: string, directory: string, body: PromptBody) {
    this.lastBody = body
    this.lastDirectory = directory
    return this.response
  }
  async abort() {}
}

const structured = (obj: unknown): PromptResponse => ({
  info: {},
  parts: [{ type: 'tool', tool: 'StructuredOutput', state: { input: obj, metadata: { valid: true } } }],
})
const textOnly = (t: string): PromptResponse => ({ info: {}, parts: [{ type: 'text', text: t }] })

const make = (res: PromptResponse) => {
  const c = new FakeClient(res)
  return { c, p: new OpenCodeProvider(c as never, '/work', { timeoutMs: 1000 }) }
}

describe('OpenCodeProvider', () => {
  test('returns structured output as a JSON string', async () => {
    const { p } = make(structured({ a: 1 }))
    const out = await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b', schema: { type: 'object' } })
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })

  test('sends json_schema format when a schema is supplied', async () => {
    const { c, p } = make(structured({ a: 1 }))
    await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b', schema: { type: 'object' } })
    expect(c.lastBody?.format?.type).toBe('json_schema')
  })

  test('omits format when no schema is supplied', async () => {
    const { c, p } = make(textOnly('plain'))
    const out = await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b' })
    expect(c.lastBody?.format).toBeUndefined()
    expect(out).toBe('plain')
  })

  test('criteria and judge calls run as the grader in its directory; reflect does not', async () => {
    const c = new FakeClient(structured({ a: 1 }))
    const p = new OpenCodeProvider(c as never, '/work', { timeoutMs: 1000, graderDirectory: '/work/.arena-grader' })
    for (const purpose of ['criteria', 'judge'] as const) {
      await p.complete({ purpose, prompt: 'x', modelId: 'a/b', schema: {} })
      expect(c.lastBody?.agent).toBe('grader')
      expect(c.lastDirectory).toBe('/work/.arena-grader')
    }
    await p.complete({ purpose: 'reflect', prompt: 'x', modelId: 'a/b', schema: {} })
    expect(c.lastBody?.agent).toBeUndefined()
    expect(c.lastDirectory).toBe('/work')
  })

  test('without a grader directory every call keeps the implicit agent', async () => {
    const { c, p } = make(structured({ a: 1 }))
    await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b', schema: {} })
    expect(c.lastBody?.agent).toBeUndefined()
    expect(c.lastDirectory).toBe('/work')
  })

  test('splits the model id on the first slash only', async () => {
    const { c, p } = make(structured({ a: 1 }))
    await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash', schema: {} })
    expect(c.lastBody?.model).toEqual({ providerID: 'wandb', modelID: 'deepseek-ai/DeepSeek-V4-Flash' })
  })

  test('falls back to text when a schema was requested but no structured part came back', async () => {
    const { p } = make(textOnly('{"a":1}'))
    const out = await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b', schema: {} })
    expect(out).toBe('{"a":1}')
  })

  test('throws when the provider reported an error', async () => {
    const { p } = make({ info: { error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } }, parts: [] })
    await expect(p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b' })).rejects.toThrow(/404/)
  })

  test('accumulates cost and tokens across calls', async () => {
    const c = new FakeClient({
      info: { cost: 0.25, tokens: { total: 10, input: 6, output: 2, reasoning: 1, cache: { read: 1, write: 0 } } },
      parts: [{ type: 'text', text: 'hi' }],
    })
    const p = new OpenCodeProvider(c as never, '/work', { timeoutMs: 1000 })
    await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b' })
    await p.complete({ purpose: 'judge', prompt: 'x', modelId: 'a/b' })
    expect(p.usage.costUsd).toBeCloseTo(0.5)
    expect(p.usage.tokensIn).toBe(12)
    expect(p.usage.tokensCacheRead).toBe(2)
  })
})
