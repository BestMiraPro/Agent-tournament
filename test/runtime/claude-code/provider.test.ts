import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { ClaudeCodeProvider } from '../../../src/runtime/claude-code/provider.js'
import { SubscriptionLimitGate } from '../../../src/runtime/claude-code/limit-gate.js'
import type { ClaudeLauncher, ClaudeProcess, LaunchRequest } from '../../../src/runtime/claude-code/process.js'
import { DispatchingAgentRunner, RoutingProvider } from '../../../src/runtime/dispatch.js'
import type { AgentRunner, AgentRunResult } from '../../../src/runtime/agent-runner.js'
import type { Provider } from '../../../src/runtime/provider.js'

const FIXTURES = join(import.meta.dirname, '../../fixtures/claude-code-2.1.325')

/** Answers the prompt on stdin with one recorded `--output-format json` result. */
function oneShot(stdout: string, stdinSeen: string[], exitCode = 0): ClaudeProcess {
  const stdin = new PassThrough()
  const out = new PassThrough()
  let chunks = ''
  let resolveExit!: (v: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolveExit = r })
  stdin.on('data', (d) => { chunks += String(d) })
  stdin.on('finish', () => {
    stdinSeen.push(chunks)
    out.end(stdout)
    setImmediate(() => resolveExit({ code: exitCode, signal: null }))
  })
  return { stdin, stdout: out, stderr: new PassThrough(), exited, kill: async () => {}, probe: async () => 'stopped' }
}

function provider(stdout: string, opts: { gate?: SubscriptionLimitGate; contextDir?: string | null } = {}) {
  const requests: LaunchRequest[] = []
  const stdin: string[] = []
  const launcher: ClaudeLauncher = { launch: (_h, req) => { requests.push(req); return oneShot(stdout, stdin) } }
  const p = new ClaudeCodeProvider({
    launcher,
    credentials: async () => ({ mode: 'token', token: 'sk-ant-oat01-provider-token-xyz' }),
    directory: '/runs/grader',
    contextDir: opts.contextDir ?? null,
    timeoutMs: 60_000,
    limitGate: opts.gate ?? new SubscriptionLimitGate(),
  })
  return { p, requests, stdin }
}

describe('ClaudeCodeProvider', () => {
  test('returns structured output as JSON text and counts tokens at no cost', async () => {
    const { p, requests, stdin } = provider(readFileSync(join(FIXTURES, 'fake-upstream-structured.json'), 'utf8'), { contextDir: '/ctx' })
    const text = await p.complete({ purpose: 'judge', prompt: 'Rank these.', modelId: 'claude-subscription/opus', schema: { type: 'object' } })
    expect(JSON.parse(text)).toEqual({ summary: 'fine', items: [{ label: 'ok', value: 1 }] })
    expect(stdin).toEqual(['Rank these.'])
    expect(requests[0]!.args).toEqual(expect.arrayContaining(['--model=opus', '--json-schema={"type":"object"}', '--tools=Read,Glob,Grep', '--add-dir=/ctx']))
    expect(requests[0]!.token).toBe('sk-ant-oat01-provider-token-xyz')
    expect(p.usage).toMatchObject({ calls: 1, costUsd: 0, tokensIn: 120, tokensOut: 42 })
    expect(p.describe()).toBe('claude-code')
  })

  test('reflect calls get no tools and plain text back', async () => {
    const lines = readFileSync(join(FIXTURES, 'genuine-haiku-ok.jsonl'), 'utf8').trim().split('\n')
    const { p, requests } = provider(lines.at(-1)!, { contextDir: '/ctx' })
    expect(await p.complete({ purpose: 'reflect', prompt: 'Rewrite.', modelId: 'claude-subscription/haiku' })).toBe('OK')
    expect(requests[0]!.args).toContain('--tools=')
    expect(requests[0]!.args.some((a) => a.startsWith('--add-dir'))).toBe(false)
  })

  test('an exhausted subscription throws a classified error and closes the gate', async () => {
    const gate = new SubscriptionLimitGate(() => 1794700000_000)
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your 5-hour limit" })
    const { p, requests } = provider(result, { gate })
    await expect(p.complete({ purpose: 'judge', prompt: 'x', modelId: 'claude-subscription/opus' })).rejects.toThrow(/usage limit reached/)
    await expect(p.complete({ purpose: 'judge', prompt: 'x', modelId: 'claude-subscription/opus' })).rejects.toThrow(/usage limit reached/)
    expect(requests).toHaveLength(1)
  })

  test('refuses an invalid model id before argv', async () => {
    const { p, requests } = provider('{}')
    await expect(p.complete({ purpose: 'reflect', prompt: 'x', modelId: 'claude-subscription/-p' })).rejects.toThrow(/not a valid Claude subscription model id/)
    expect(requests).toHaveLength(0)
  })
})

describe('routing by model', () => {
  const result = (status: AgentRunResult['status']): AgentRunResult => ({ status, errorText: null, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0, durationMs: 0 })
  const fakeRunner = (name: string, log: string[], withSend = true): AgentRunner => ({
    run: async (h) => { log.push(`${name}:run:${h.agentId}`); return result('ok') },
    abortAll: async () => { log.push(`${name}:abortAll`) },
    assertReadyForRound: async () => { log.push(`${name}:ready`) },
    quiesce: async (h) => { log.push(`${name}:quiesce:${h.agentId}`); return 'stopped' },
    ...(withSend ? { send: async (h: { agentId: string }, t: string) => { log.push(`${name}:send:${h.agentId}:${t}`); return true } } : {}),
  })
  const genome = (modelId: string) => ({ strategyMd: '', notesMd: '', modelId, temperature: 0.5 })

  test('a mixed roster runs each agent on its own harness and keeps ownership for quiesce and send', async () => {
    const log: string[] = []
    const d = new DispatchingAgentRunner({ claude: fakeRunner('claude', log), other: fakeRunner('opencode', log, false) })
    const h1 = { agentId: 'c1', workspacePath: '/w/c1', baseUrl: '' }
    const h2 = { agentId: 'o1', workspacePath: '/w/o1', baseUrl: '' }
    await d.run(h1, { agentId: 'c1', genome: genome('claude-subscription/opus'), goalMd: 'g', timeoutMs: Infinity })
    await d.run(h2, { agentId: 'o1', genome: genome('openai/gpt-5.5'), goalMd: 'g', timeoutMs: Infinity })
    expect(await d.quiesce(h1)).toBe('stopped')
    expect(await d.quiesce(h2)).toBe('stopped')
    expect(await d.send(h1, 'hello')).toBe(true)
    expect(await d.send(h2, 'hello')).toBe(false)
    await d.assertReadyForRound()
    await d.abortAll()
    expect(log).toEqual([
      'claude:run:c1', 'opencode:run:o1', 'claude:quiesce:c1', 'opencode:quiesce:o1', 'claude:send:c1:hello',
      'opencode:ready', 'claude:ready', 'opencode:abortAll', 'claude:abortAll',
    ])
    expect(await d.quiesce({ agentId: 'never', workspacePath: '/w/x', baseUrl: '' })).toBe('stopped')
  })

  test('judge and reflect calls go to the provider of their model, and the audit names that runtime', async () => {
    const calls: string[] = []
    const fake = (name: string): Provider => ({ complete: async (r) => { calls.push(`${name}:${r.modelId}`); return name }, describe: () => name })
    const p = new RoutingProvider({ claude: fake('claude-code'), other: fake('opencode') })
    expect(await p.complete({ purpose: 'judge', prompt: '', modelId: 'claude-subscription/opus' })).toBe('claude-code')
    expect(await p.completeRich({ purpose: 'reflect', prompt: '', modelId: 'wandb/x/y' })).toEqual({ text: 'opencode', reasoning: null })
    expect(p.describe('claude-subscription/opus')).toBe('claude-code')
    expect(p.describe('openai/gpt-5.5')).toBe('opencode')
    expect(calls).toEqual(['claude-code:claude-subscription/opus', 'opencode:wandb/x/y'])
  })
})
