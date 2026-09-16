import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../../src/core/types.js'
import { deadlineTimer } from '../../../src/runtime/agent-runner.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { buildSteeringPrompt, COMPETITOR_AGENT, OpenCodeAgentRunner } from '../../../src/runtime/opencode/agent-runner.js'
import { OpenCodeClient, type HttpTransport, type PromptBody, type PromptResponse } from '../../../src/runtime/opencode/client.js'
import { makeMockEngine } from '../../helpers/mock-engine.js'

const HOUR = 3_600_000

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

class SteerableClient extends OpenCodeClient {
  response = deferred<PromptResponse>()
  steers: { sessionId: string; directory: string; body: PromptBody }[] = []
  constructor() { super({ baseUrl: 'http://fake.invalid', timeoutMs: 50 }) }
  override async createSession() { return { id: 'ses_1' } }
  override async prompt() { return this.response.promise }
  override async promptAsync(sessionId: string, directory: string, body: PromptBody) { this.steers.push({ sessionId, directory, body }) }
  override async abort() {}
}

const ctx = (over: Record<string, unknown> = {}) => ({
  agentId: 'a1',
  genome: { strategyMd: 'my strategy', notesMd: '', modelId: 'wandb/zai-org/GLM-5.3-Flash', temperature: 0.7 },
  goalMd: 'goal',
  timeoutMs: Infinity,
  steerAfterMs: HOUR,
  ...over,
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('no agent time limit', () => {
  test('by default agents are never cut off, and are steered to submit after one hour', () => {
    expect(DEFAULT_CONFIG.agentTimeoutMs).toBe(Infinity)
    expect(DEFAULT_CONFIG.agentSteerAfterMs).toBe(HOUR)
  })

  test('a non-finite deadline arms no timer: setTimeout(fn, Infinity) would fire at once', () => {
    const fired = vi.fn()
    expect(deadlineTimer(Infinity, fired)).toBeUndefined()
    vi.advanceTimersByTime(10 * HOUR)
    expect(fired).not.toHaveBeenCalled()
    clearTimeout(deadlineTimer(5, fired))
  })

  test('an OpenCode request with no deadline is neither aborted nor given a socket idle limit', async () => {
    let seen: { timeoutMs: number; signal: AbortSignal } | null = null
    const reply = deferred<{ status: number; text: string }>()
    const transport: HttpTransport = (req) => { seen = req; return reply.promise }
    const client = new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 1000, transport })
    const prompt = client.prompt('ses', '/work/a1', { model: { providerID: 'p', modelID: 'm' }, parts: [] }, Infinity)
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(seen!.timeoutMs).toBe(Infinity)
    expect(seen!.signal.aborted).toBe(false)
    reply.resolve({ status: 200, text: JSON.stringify({ info: {} }) })
    await expect(prompt).resolves.toEqual({ info: {} })
  })

  test('the engine hands runners no limit and the steering time, and arms no timer of its own', async () => {
    const seen: { timeoutMs: number; steerAfterMs?: number }[] = []
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    vi.useRealTimers()
    const { engine } = makeMockEngine({
      seed: 1, populationSize: 2,
      wrapRunner: (inner) => ({ ...inner, run: (h, c) => { seen.push(c); return inner.run(h, c) }, abortAll: () => inner.abortAll(), quiesce: inner.quiesce?.bind(inner) }),
    })
    const run = engine.createRun('t', 'goal')
    await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    expect(seen.map((c) => [c.timeoutMs, c.steerAfterMs])).toEqual([[Infinity, HOUR], [Infinity, HOUR]])
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === Infinity || ms === DEFAULT_CONFIG.agentTimeoutMs)).toBe(false)
  })
})

describe('steering a long-running agent', () => {
  test('after the steering time the agent is told once to submit what it has, under its own profile', async () => {
    const sandbox = new MockSandbox()
    const handle = await sandbox.provision('a1', {})
    const client = new SteerableClient()
    const runner = new OpenCodeAgentRunner(client, sandbox)
    let status: string | undefined
    const run = runner.run(handle, ctx()).then((r) => { status = r.status })

    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(client.steers).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.steers).toHaveLength(1)
    expect(client.steers[0]).toMatchObject({
      sessionId: 'ses_1',
      directory: handle.workspacePath,
      body: {
        model: { providerID: 'wandb', modelID: 'zai-org/GLM-5.3-Flash' },
        agent: COMPETITOR_AGENT,
        system: 'my strategy',
        parts: [{ type: 'text', text: buildSteeringPrompt(HOUR) }],
      },
    })

    // Still working hours later: never cut off, never steered twice.
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    expect(status).toBeUndefined()
    expect(client.steers).toHaveLength(1)

    await sandbox.writeFile(handle, 'SUBMISSION.md', 'what I have')
    client.response.resolve({ info: {} })
    await run
    expect(status).toBe('ok')
  })

  test('an agent that finishes before the steering time is never steered', async () => {
    const sandbox = new MockSandbox()
    const handle = await sandbox.provision('a1', {})
    const client = new SteerableClient()
    const runner = new OpenCodeAgentRunner(client, sandbox)
    const run = runner.run(handle, ctx())
    await vi.advanceTimersByTimeAsync(1000)
    client.response.resolve({ info: {} })
    await run
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(client.steers).toHaveLength(0)
  })

  test('an agent being stopped is not steered', async () => {
    const sandbox = new MockSandbox()
    const handle = await sandbox.provision('a1', {})
    const client = new SteerableClient()
    const runner = new OpenCodeAgentRunner(client, sandbox)
    const run = runner.run(handle, ctx())
    await vi.advanceTimersByTimeAsync(1000)
    void runner.quiesce(handle)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(client.steers).toHaveLength(0)
    client.response.resolve({ info: {} })
    await run
  })

  test('the message names the elapsed time and asks for SUBMISSION.md, stating what is unfinished', () => {
    expect(buildSteeringPrompt(HOUR)).toBe([
      'You have been working for 1 hour. Time to submit.',
      'Do not start anything new. Write your final answer to SUBMISSION.md now with what you have,',
      'saying plainly what is finished and what is not, then stop.',
    ].join('\n'))
    expect(buildSteeringPrompt(90 * 60_000)).toContain('working for 90 minutes')
    expect(buildSteeringPrompt(2 * HOUR)).toContain('working for 2 hours')
  })
})
