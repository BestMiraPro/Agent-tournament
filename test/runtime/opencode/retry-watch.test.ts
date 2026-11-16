import { describe, expect, test } from 'vitest'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { OpenCodeAgentRunner } from '../../../src/runtime/opencode/agent-runner.js'
import { OpenCodeProvider } from '../../../src/runtime/opencode/provider.js'
import { PROVIDER_LIMIT_CODE, ProviderStuckError, RETRY_GIVE_UP_ATTEMPTS, watchRetries } from '../../../src/runtime/opencode/retry-watch.js'

type Retry = { attempt: number; message: string; action?: { title?: string; message?: string } } | null

/** Answers each status read with the next entry, repeating the last. */
const statuses = (...answers: (Retry | Error)[]) => {
  let i = 0
  return {
    reads: () => i,
    sessionRetry: async () => {
      const a = answers[Math.min(i++, answers.length - 1)]!
      if (a instanceof Error) throw a
      return a
    },
  }
}

const FREE_TIER = { attempt: 1, message: 'Free usage limit reached', action: { title: 'Free usage limit reached', message: 'Subscribe to OpenCode Go to keep going' } }

describe('watchRetries', () => {
  test('gives up at once when the provider names an action for a person to take', async () => {
    const s = statuses(null, FREE_TIER)
    const w = watchRetries(s, 'ses', '/d', { pollMs: 1 })
    await expect(w.promise).rejects.toThrow(ProviderStuckError)
    await expect(w.promise).rejects.toThrow('The model provider keeps failing (1 retries): Free usage limit reached: Subscribe to OpenCode Go to keep going')
    expect(s.reads()).toBe(2)
  })

  test('lets ordinary retries run, and gives up only after the limit', async () => {
    const s = statuses(...Array.from({ length: RETRY_GIVE_UP_ATTEMPTS }, (_, i) => ({ attempt: i + 1, message: 'rate limited' })))
    const w = watchRetries(s, 'ses', '/d', { pollMs: 1 })
    await expect(w.promise).rejects.toThrow(`(${RETRY_GIVE_UP_ATTEMPTS} retries): rate limited`)
    expect(s.reads()).toBe(RETRY_GIVE_UP_ATTEMPTS)
  })

  test('a status that cannot be read is not a reason to give up, and a stopped watch never rejects', async () => {
    const s = statuses(new Error('ECONNRESET'))
    const w = watchRetries(s, 'ses', '/d', { pollMs: 1 })
    await new Promise((r) => setTimeout(r, 30))
    w.stop()
    const reads = s.reads()
    expect(reads).toBeGreaterThan(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(s.reads()).toBe(reads)
  })
})

describe('a prompt the provider keeps failing', () => {
  const ctx = { agentId: 'a1', genome: { strategyMd: 's', notesMd: '', modelId: 'opencode/big-pickle', temperature: 0.7 }, goalMd: 'g', timeoutMs: Infinity }

  test('fails the agent with a clear reason and stops its session, even with no time limit', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    const aborted: string[] = []
    const client = {
      ...statuses(null, FREE_TIER),
      async createSession() { return { id: 'ses_1' } },
      prompt: () => new Promise(() => {}),
      async abort(id: string) { aborted.push(id) },
      async sessionStatus() { return 'idle' as const },
    }
    const result = await new OpenCodeAgentRunner(client as never, sb, { retryWatch: { pollMs: 1 } }).run(h, ctx)
    expect(result.status).toBe('error')
    expect(result.failure).toMatchObject({ code: PROVIDER_LIMIT_CODE })
    expect(result.errorText).toContain('Free usage limit reached')
    expect(aborted).toContain('ses_1')
  })

  test('fails a judge or reflection call instead of waiting for good', async () => {
    const aborted: string[] = []
    const client = {
      ...statuses(FREE_TIER),
      async createSession() { return { id: 'ses_2' } },
      prompt: () => new Promise(() => {}),
      async abort(id: string) { aborted.push(id) },
    }
    const p = new OpenCodeProvider(client as never, '/w', { timeoutMs: Infinity, retryWatch: { pollMs: 1 } })
    await expect(p.complete({ purpose: 'reflect', prompt: 'x', modelId: 'opencode/big-pickle' })).rejects.toThrow(ProviderStuckError)
    await new Promise((r) => setTimeout(r, 5))
    expect(aborted).toEqual(['ses_2'])
    expect(p.usage.abandonedSessions).toBe(1)
  })
})
