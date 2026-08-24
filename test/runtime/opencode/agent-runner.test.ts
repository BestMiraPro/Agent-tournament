import { describe, expect, test } from 'vitest'
import { OpenCodeAgentRunner, buildAgentPrompt } from '../../../src/runtime/opencode/agent-runner.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import type { PromptBody, PromptResponse } from '../../../src/runtime/opencode/client.js'

class FakeClient {
  public lastBody: PromptBody | null = null
  public aborted = false
  constructor(private response: PromptResponse | 'hang') {}
  async createSession() { return { id: 'ses_1' } }
  async prompt(_s: string, _d: string, body: PromptBody): Promise<PromptResponse> {
    this.lastBody = body
    if (this.response === 'hang') return new Promise(() => {})
    return this.response
  }
  async abort() { this.aborted = true }
}

const okResponse: PromptResponse = {
  info: { cost: 0.5, tokens: { total: 100, input: 60, output: 30, reasoning: 5, cache: { read: 5, write: 1 } } },
  parts: [{ type: 'text', text: 'done' }],
}

const ctx = (strategy: string, timeoutMs = 5000) => ({
  agentId: 'a1',
  genome: { strategyMd: strategy, notesMd: '', modelId: 'opencode/big-pickle', temperature: 0.7 },
  goalMd: 'write something good',
  timeoutMs,
})

describe('buildAgentPrompt', () => {
  test('includes the goal and the submission contract', () => {
    const p = buildAgentPrompt('write a poem')
    expect(p).toContain('write a poem')
    expect(p).toContain('SUBMISSION.md')
  })
})

describe('OpenCodeAgentRunner', () => {
  test('injects the strategy as the system field', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const c = new FakeClient(okResponse)
    await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('BE CONCISE'))
    expect(c.lastBody?.system).toBe('BE CONCISE')
  })

  test('splits the model id on the first slash only', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const c = new FakeClient(okResponse)
    const g = { ...ctx('s'), genome: { ...ctx('s').genome, modelId: 'wandb/deepseek-ai/DeepSeek-V4-Flash' } }
    await new OpenCodeAgentRunner(c as never, sb).run(h, g)
    expect(c.lastBody?.model).toEqual({ providerID: 'wandb', modelID: 'deepseek-ai/DeepSeek-V4-Flash' })
  })

  test('reports ok and carries cost and cache tokens through', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'the answer')
    const res = await new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('ok')
    expect(res.costUsd).toBe(0.5)
    expect(res.tokensIn).toBe(60)
    expect(res.tokensCacheRead).toBe(5)
  })

  test('reports no_submission when SUBMISSION.md was not written', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const res = await new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('no_submission')
  })

  test('reports error when the provider returned an error', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const c = new FakeClient({ info: { error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } }, parts: [] })
    const res = await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('error')
    expect(res.errorText).toContain('404')
  })

  test('times out, aborts the session, and reports timeout', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const c = new FakeClient('hang')
    const res = await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('s', 50))
    expect(res.status).toBe('timeout')
    expect(c.aborted).toBe(true)
  })
})
