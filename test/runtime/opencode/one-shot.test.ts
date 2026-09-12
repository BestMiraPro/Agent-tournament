import { describe, expect, test, vi } from 'vitest'
import { OpenCodeClient, type PromptResponse } from '../../../src/runtime/opencode/client.js'
import { promptOnce } from '../../../src/runtime/opencode/one-shot.js'
import { OpenCodeProvider } from '../../../src/runtime/opencode/provider.js'
import { validateModel } from '../../../src/runtime/opencode/capability.js'

const terminal: PromptResponse = { info: { cost: 0.01 }, parts: [{ type: 'text', text: 'ok' }] }

/**
 * Every remote boundary is replaced. A session is "created" by returning an id, so the
 * test can assert exactly which ids were asked to stop.
 */
function fakeClient(promptImpl: () => Promise<PromptResponse>) {
  const created: string[] = []
  const aborted: string[] = []
  const client = new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 50 })
  vi.spyOn(client, 'createSession').mockImplementation(async () => {
    const id = `session-${created.length + 1}`
    created.push(id)
    return { id }
  })
  vi.spyOn(client, 'prompt').mockImplementation(promptImpl)
  vi.spyOn(client, 'abort').mockImplementation(async (sessionId: string) => {
    aborted.push(sessionId)
  })
  return { client, created, aborted }
}

/** The abort is fire-and-forget, so it lands a turn after the call rejects. */
const settle = () => new Promise((r) => setImmediate(r))

describe('promptOnce', () => {
  test('asks the server to stop a session whose prompt failed', async () => {
    const f = fakeClient(async () => { throw new Error('connection lost') })
    const abandoned: string[] = []

    await expect(
      promptOnce(f.client, '/dir', 'judge-call', { parts: [] } as never, 50, (s) => abandoned.push(s.sessionId)),
    ).rejects.toThrow('connection lost')

    await settle()
    expect(f.created).toEqual(['session-1'])
    expect(f.aborted).toEqual(['session-1'])
    expect(abandoned).toEqual(['session-1'])
  })

  test('a successful call stops nothing and reports nothing abandoned', async () => {
    const f = fakeClient(async () => terminal)
    const abandoned: string[] = []
    expect(await promptOnce(f.client, '/dir', 't', { parts: [] } as never, 50, (s) => abandoned.push(s.sessionId)))
      .toBe(terminal)
    await settle()
    expect(f.aborted).toEqual([])
    expect(abandoned).toEqual([])
  })

  test('a session that was never created is not aborted', async () => {
    const f = fakeClient(async () => terminal)
    vi.spyOn(f.client, 'createSession').mockRejectedValue(new Error('create failed'))
    await expect(promptOnce(f.client, '/dir', 't', { parts: [] } as never, 50)).rejects.toThrow('create failed')
    await settle()
    expect(f.aborted).toEqual([])
  })

  test('a failing or hanging abort neither masks nor delays the real failure', async () => {
    const f = fakeClient(async () => { throw new Error('the real failure') })
    vi.spyOn(f.client, 'abort').mockImplementation(() => new Promise(() => {}))
    // Resolves promptly despite an abort that never comes back: waiting on one would
    // hang a call that has already failed, and an acknowledgement proves nothing anyway.
    await expect(promptOnce(f.client, '/dir', 't', { parts: [] } as never, 50))
      .rejects.toThrow('the real failure')
  })
})

describe('OpenCodeProvider session hygiene', () => {
  test('a failed completion stops its session and is counted as abandoned', async () => {
    const f = fakeClient(async () => { throw new Error('prompt timed out') })
    const provider = new OpenCodeProvider(f.client, '/dir', { timeoutMs: 50 })

    await expect(provider.complete({ purpose: 'judge', prompt: 'p', modelId: 'a/b' }))
      .rejects.toThrow('prompt timed out')

    await settle()
    expect(f.aborted).toEqual(['session-1'])
    expect(provider.usage.abandonedSessions).toBe(1)
    // No response came back, so no spend is attributed to it.
    expect(provider.usage.costUsd).toBe(0)
  })

  test('a successful completion abandons nothing', async () => {
    const f = fakeClient(async () => terminal)
    const provider = new OpenCodeProvider(f.client, '/dir', { timeoutMs: 50 })
    expect(await provider.complete({ purpose: 'judge', prompt: 'p', modelId: 'a/b' })).toBe('ok')
    await settle()
    expect(f.aborted).toEqual([])
    expect(provider.usage.abandonedSessions).toBe(0)
    expect(provider.usage.costUsd).toBeCloseTo(0.01)
  })
})

describe('validateModel session hygiene', () => {
  test('every retried attempt stops the session it abandoned', async () => {
    const f = fakeClient(async () => { throw new Error('probe blew up') })
    const result = await validateModel(f.client, '/dir', 'a/b', 'worker', 50, 3)

    expect(result.ok).toBe(false)
    await settle()
    // One session per attempt, and each one asked to stop rather than left generating.
    expect(f.created).toEqual(['session-1', 'session-2', 'session-3'])
    expect(f.aborted).toEqual(['session-1', 'session-2', 'session-3'])
    // The verdict says what was left unconfirmed instead of implying a clean failure.
    expect(result.reason).toMatch(/3 session\(s\) asked to stop, not confirmed/)
  })

  test('a probe that answers stops nothing', async () => {
    const f = fakeClient(async () => ({ info: {}, parts: [{ type: 'text', text: 'ok' }] }))
    const result = await validateModel(f.client, '/dir', 'a/b', 'worker', 50, 3)
    expect(result.ok).toBe(true)
    await settle()
    expect(f.created).toEqual(['session-1'])
    expect(f.aborted).toEqual([])
  })
})
