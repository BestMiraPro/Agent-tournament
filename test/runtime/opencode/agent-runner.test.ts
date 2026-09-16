import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { COMPETITOR_AGENT, OpenCodeAgentRunner, QUIESCE_GRACE_MS, buildAgentPrompt } from '../../../src/runtime/opencode/agent-runner.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import type { PromptBody, PromptResponse } from '../../../src/runtime/opencode/client.js'
import { OpenCodeHttpError } from '../../../src/runtime/opencode/client.js'

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

  test('points at the tool manifest only when the runtime provides one', () => {
    expect(buildAgentPrompt('g')).not.toContain('TOOLS.md')
    expect(buildAgentPrompt('g', null, '/run/arena/TOOLS.md'))
      .toContain('The tools already installed here are listed in /run/arena/TOOLS.md. Read it before you install or set anything up.')
  })

  test('names the reference folder only when there is one', () => {
    expect(buildAgentPrompt('g')).not.toContain('Reference material')
    expect(buildAgentPrompt('g', '/context')).toContain('Reference material (read-only) is in /context.')
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

  test('selects the competitor profile by name, using a field the pinned runtime accepts', async () => {
    // Without it every session ran as OpenCode's implicit `build` agent (the September 13
    // logs say agent=build), so the profile's temperature and permissions never applied.
    const contract = JSON.parse(readFileSync('test/fixtures/opencode-1.18.21/permission-contract.json', 'utf8'))
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const c = new FakeClient(okResponse)
    await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('BE CONCISE'))
    expect(c.lastBody?.agent).toBe(COMPETITOR_AGENT)
    expect(COMPETITOR_AGENT).toBe(contract.competitorAgent.name)
    expect(contract.promptBodyProperties).toContain('agent')
    expect(c.lastBody?.system).toBe('BE CONCISE')
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

  test('clears the race timer after a fast run', async () => {
    vi.useFakeTimers()
    try {
      const sb = new MockSandbox()
      const h = await sb.provision('a1', {})
      await sb.writeFile(h, 'SUBMISSION.md', 'x')
      const res = await new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb).run(h, ctx('s', 600_000))
      expect(res.status).toBe('ok')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OpenCodeAgentRunner model availability', () => {
  class CountingClient extends FakeClient {
    sessions = 0
    async createSession() { this.sessions++; return { id: 'ses_1' } }
  }
  const reason = 'Model unavailable in Docker runtime (OpenCode 1.18.21, shard 0): wandb/x/y is not in its model catalogue'
  const onModel = (modelId: string) => ({ ...ctx('s'), genome: { ...ctx('s').genome, modelId } })

  test('refuses a model the runtime does not list before any session or prompt', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const c = new CountingClient(okResponse)
    const checked: string[] = []
    const runner = new OpenCodeAgentRunner(c as never, sb, {
      modelUnavailable: (handle, modelId) => { checked.push(`${handle.agentId} ${modelId}`); return reason },
    })
    const res = await runner.run(h, onModel('wandb/x/y'))

    expect(checked).toEqual(['a1 wandb/x/y'])
    expect(c.sessions).toBe(0)
    expect(c.lastBody).toBeNull()
    expect(res.status).toBe('error')
    expect(res.failure).toEqual({ message: reason, code: 'MODEL_UNAVAILABLE' })
    expect(res.errorText).toBe(reason)
    // Nothing was dispatched, so zero usage is a fact rather than a placeholder.
    expect(res.usageKnown).not.toBe(false)
    expect(res.tokensIn + res.tokensOut + res.costUsd).toBe(0)
    await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
  })

  test('runs normally when the runtime lists the model', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const c = new CountingClient(okResponse)
    const res = await new OpenCodeAgentRunner(c as never, sb, { modelUnavailable: () => null }).run(h, onModel('wandb/x/y'))
    expect(c.sessions).toBe(1)
    expect(res.status).toBe('ok')
  })
})

describe('abortAll', () => {
  // Sessions need distinct ids and a prompt that stays in flight until the test
  // says otherwise — otherwise there is nothing tracked for abortAll to abort.
  class DeferredClient {
    sessions = 0
    abortedIds: string[] = []
    private release: ((v: PromptResponse) => void)[] = []
    async createSession() {
      this.sessions++
      return { id: `ses_${this.sessions}` }
    }
    async prompt(): Promise<PromptResponse> {
      return new Promise<PromptResponse>((resolve) => {
        this.release.push(resolve)
      })
    }
    async abort(sessionId: string) {
      this.abortedIds.push(sessionId)
    }
    resolveAll(r: PromptResponse) {
      this.release.splice(0).forEach((f) => f(r))
    }
  }

  const ctxFor = (agentId: string) => ({
    agentId,
    genome: { strategyMd: 's', notesMd: '', modelId: 'opencode/big-pickle', temperature: 0.7 },
    goalMd: 'write something good',
    timeoutMs: 60_000,
  })

  test('aborts every tracked session and no-ops after terminal responses arrive', async () => {
    // Fake timers keep the concurrent grace from costing wall clock time. The runs'
    // own race timers sit at 60s, beyond the single quiescence grace.
    vi.useFakeTimers()
    try {
      const sb = new MockSandbox()
      const h1 = await sb.provision('a1', {})
      const h2 = await sb.provision('a2', {})
      await sb.writeFile(h1, 'SUBMISSION.md', 'one')
      await sb.writeFile(h2, 'SUBMISSION.md', 'two')
      const c = new DeferredClient()
      const runner = new OpenCodeAgentRunner(c as never, sb)
      const p1 = runner.run(h1, ctxFor('a1'))
      const p2 = runner.run(h2, ctxFor('a2'))
      // Sessions are registered after a microtask hop; without this the map holds
      // entries with null sessionIds and quiesce would (correctly) abort nothing.
      await vi.advanceTimersByTimeAsync(0)
      expect(c.sessions).toBe(2)

      const abortP = runner.abortAll()
      await vi.advanceTimersByTimeAsync(QUIESCE_GRACE_MS)
      await abortP
      // Both tracked sessions aborted via the client spy, in map order. Runs never
      // settled, so both entries were still tracked when their turn came.
      expect(c.abortedIds).toEqual(['ses_1', 'ses_2'])

      c.resolveAll(okResponse)
      expect((await p1).status).toBe('ok')
      expect((await p2).status).toBe('ok')

      // Terminal responses confirmed both stopped: another call aborts nothing.
      await runner.abortAll()
      expect(c.abortedIds).toEqual(['ses_1', 'ses_2'])
    } finally {
      vi.useRealTimers()
    }
  })

  test('empty map is a no-op success', async () => {
    const sb = new MockSandbox()
    const c = new DeferredClient()
    await new OpenCodeAgentRunner(c as never, sb).abortAll()
    expect(c.abortedIds).toEqual([])
  })
})

describe('per-shard client resolution', () => {
  test('uses the client for the handle base url', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const a = new FakeClient(okResponse)
    const b = new FakeClient(okResponse)
    const runner = new OpenCodeAgentRunner(
      (handle) => (handle.baseUrl === h.baseUrl ? (b as never) : (a as never)),
      sb,
    )
    await runner.run(h, ctx('s'))
    expect(b.lastBody).not.toBeNull()
    expect(a.lastBody).toBeNull()
  })

  test('accepts a plain client for the single-server case', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const c = new FakeClient(okResponse)
    const res = await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('ok')
  })
})

describe('session id exposure', () => {
  test('reports the session id as soon as the session is created', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const seen: { agentId: string; sessionId: string }[] = []
    const runner = new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb, {
      onSessionCreated: (agentId, sessionId) => seen.push({ agentId, sessionId }),
    })
    await runner.run(h, ctx('s'))
    expect(seen).toEqual([{ agentId: 'a1', sessionId: 'ses_1' }])
  })

  test('a throwing hook does not fail the run', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const runner = new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb, {
      onSessionCreated: () => { throw new Error('hook exploded') },
    })
    const res = await runner.run(h, ctx('s'))
    expect(res.status).toBe('ok')
  })

  test('works without the hook', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'x')
    const res = await new OpenCodeAgentRunner(new FakeClient(okResponse) as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('ok')
  })
})

/** A client whose prompt rejects, the way a real HTTP failure or dropped socket does. */
class RejectingClient {
  constructor(private error: unknown) {}
  async createSession() { return { id: 'ses_1' } }
  async prompt(): Promise<PromptResponse> { throw this.error }
  async abort() {}
}

describe('OpenCodeAgentRunner failure details', () => {
  // The exact body stored for run 6eb22c7c on September 13.
  const BODY_500 =
    '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_0672e772"}}'

  test('an OpenCode 500 keeps status, name and ref in the result, with usage marked unknown', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const error = new OpenCodeHttpError({ method: 'POST', path: '/session/ses_1/message', status: 500, bodyText: BODY_500 })
    const res = await new OpenCodeAgentRunner(new RejectingClient(error) as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('error')
    expect(res.failure).toEqual({
      message: 'OpenCode returned HTTP 500 UnknownError (ref err_0672e772)',
      httpStatus: 500, code: 'UnknownError', ref: 'err_0672e772',
    })
    expect(res.usageKnown).toBe(false)
    expect(res.errorText).toContain('err_0672e772')
  })

  test('a transport rejection keeps its cause code in the result and in the persisted text', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const error = new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
    const res = await new OpenCodeAgentRunner(new RejectingClient(error) as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('error')
    expect(res.failure?.code).toBe('UND_ERR_HEADERS_TIMEOUT')
    expect(res.failure?.httpStatus).toBeUndefined()
    expect(res.errorText).toContain('UND_ERR_HEADERS_TIMEOUT')
    expect(res.usageKnown).toBe(false)
  })

  test('a provider error inside a terminal response is structured, and its usage stays known', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const c = new FakeClient({
      info: { cost: 0.1, error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } }, parts: [],
    })
    const res = await new OpenCodeAgentRunner(c as never, sb).run(h, ctx('s'))
    expect(res.status).toBe('error')
    expect(res.failure).toMatchObject({ httpStatus: 404, code: 'APIError' })
    // The response arrived, so its usage is a fact rather than an unknown.
    expect(res.usageKnown).not.toBe(false)
    expect(res.costUsd).toBe(0.1)
  })
})
