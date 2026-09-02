import { describe, expect, test } from 'vitest'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'

const ctx = (strategy: string) => ({
  agentId: 'a1',
  genome: { strategyMd: strategy, notesMd: '', modelId: 'm', temperature: 0.7 },
  goalMd: 'write something good',
  timeoutMs: 1000,
})

describe('MockAgentRunner', () => {
  test('writes SUBMISSION.md into the workspace', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const runner = new MockAgentRunner(sb, 1)
    const res = await runner.run(h, ctx('verify and test'))
    expect(res.status).toBe('ok')
    expect(await sb.readFile(h, 'SUBMISSION.md')).toContain('FITNESS=')
  })

  test('encodes higher fitness for stronger strategies', async () => {
    const sb = new MockSandbox()
    const runner = new MockAgentRunner(sb, 1)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    await runner.run(h1, { ...ctx('verify test iterate concise'), agentId: 'a1' })
    await runner.run(h2, { ...ctx('nothing'), agentId: 'a2' })
    const f = async (h: any) =>
      Number(/FITNESS=([\d.]+)/.exec((await sb.readFile(h, 'SUBMISSION.md'))!)![1])
    expect(await f(h1)).toBeGreaterThan(await f(h2))
  })

  test('reports token usage and duration', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const before = Date.now()
    const res = await new MockAgentRunner(sb, 1).run(h, ctx('verify'))
    const elapsed = Date.now() - before
    expect(res.tokensIn).toBeGreaterThan(0)
    // `durationMs` must reflect real wall-clock time actually spent inside `run`,
    // not just be non-negative (which `Date.now() - x` always is). Bound it above
    // by the wall-clock time the call actually took, with a small tolerance for
    // timer resolution — a hardcoded or otherwise bogus duration would exceed it.
    expect(Number.isFinite(res.durationMs)).toBe(true)
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    expect(res.durationMs).toBeLessThanOrEqual(elapsed + 5)
  })

  test('simulates failure for a strategy marked to fail', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const res = await new MockAgentRunner(sb, 1).run(h, ctx('__FAIL__'))
    expect(res.status).toBe('error')
    expect(await sb.readFile(h, 'SUBMISSION.md')).toBeNull()
  })
})

describe('AgentRunResult shape', () => {
  test('MockAgentRunner reports zeroed cost and cache fields', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const res = await new MockAgentRunner(sb, 1).run(h, ctx('verify'))
    expect(res.costUsd).toBe(0)
    expect(res.tokensCacheRead).toBe(0)
    expect(res.tokensCacheWrite).toBe(0)
  })
})
