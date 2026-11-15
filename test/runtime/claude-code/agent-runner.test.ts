import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import type { Genome } from '../../../src/core/types.js'
import { ClaudeCodeAgentRunner, type ClaudeActivity } from '../../../src/runtime/claude-code/agent-runner.js'
import type { ClaudeCredentials } from '../../../src/runtime/claude-code/env.js'
import { SubscriptionLimitGate } from '../../../src/runtime/claude-code/limit-gate.js'
import { ClaudeCliMissingError, type ClaudeLauncher, type ClaudeProcess, type LaunchRequest } from '../../../src/runtime/claude-code/process.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { buildAgentPrompt } from '../../../src/runtime/opencode/agent-runner.js'
import type { AgentHandle } from '../../../src/runtime/sandbox.js'

const FIXTURES = join(import.meta.dirname, '../../fixtures/claude-code-2.1.325')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

const genome = (modelId = 'claude-subscription/claude-haiku-5-5'): Genome => ({ strategyMd: 'Be terse.', notesMd: '', modelId, temperature: 0.7 })

/** A scripted CLI: it answers the first stdin message with a recorded stream. */
class FakeProc implements ClaudeProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  written: unknown[] = []
  stdinEnded = false
  kills = 0
  alive = true
  private resolveExit!: (v: { code: number | null; signal: string | null; error?: NodeJS.ErrnoException }) => void
  exited = new Promise<{ code: number | null; signal: string | null; error?: NodeJS.ErrnoException }>((r) => { this.resolveExit = r })

  constructor(opts: { stream?: string; exitOnStdinEnd?: boolean; dieOnKill?: boolean; exitCode?: number }) {
    let buffer = ''
    this.stdin.on('data', (d: Buffer) => {
      buffer += d.toString()
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        this.written.push(JSON.parse(buffer.slice(0, i)))
        buffer = buffer.slice(i + 1)
        if (this.written.length === 1 && opts.stream) setImmediate(() => this.stdout.write(opts.stream))
      }
    })
    this.stdin.on('finish', () => {
      this.stdinEnded = true
      if (opts.exitOnStdinEnd !== false) setTimeout(() => this.exit(opts.exitCode ?? 0), 5)
    })
    this.dieOnKill = opts.dieOnKill ?? true
  }

  private dieOnKill: boolean

  exit(code: number | null, error?: NodeJS.ErrnoException): void {
    this.alive = false
    this.stdout.end()
    this.resolveExit({ code, signal: null, ...(error ? { error } : {}) })
  }

  async kill(): Promise<void> {
    this.kills++
    if (this.dieOnKill && this.alive) this.exit(null)
  }

  async probe(): Promise<'running' | 'stopped' | 'unknown'> {
    return this.alive ? 'running' : 'stopped'
  }
}

function setup(opts: {
  proc?: () => FakeProc
  launch?: (req: LaunchRequest) => ClaudeProcess
  credentials?: () => Promise<ClaudeCredentials>
  gate?: SubscriptionLimitGate
  runtimeState?: () => Promise<'running' | 'stopped' | 'unknown'>
} = {}) {
  const sandbox = new MockSandbox()
  const requests: LaunchRequest[] = []
  const procs: FakeProc[] = []
  const sessions: [string, string][] = []
  const activity: ClaudeActivity[] = []
  const launcher: ClaudeLauncher = {
    launch: (_handle, req) => {
      requests.push(req)
      if (opts.launch) return opts.launch(req)
      const p = (opts.proc ?? (() => new FakeProc({ stream: fixture('genuine-haiku-ok.jsonl') })))()
      procs.push(p)
      return p
    },
  }
  const runner = new ClaudeCodeAgentRunner(sandbox, {
    launcher,
    credentials: opts.credentials ?? (async () => ({ mode: 'token', token: 'sk-ant-oat01-test-token-value' })),
    tokenTransport: 'fd',
    readableDirs: ['/ctx'],
    contextPath: '/ctx',
    onSessionCreated: (a, s) => sessions.push([a, s]),
    onActivity: (_a, x) => activity.push(x),
    limitGate: opts.gate ?? new SubscriptionLimitGate(),
    newSessionId: () => '11111111-2222-4333-8444-555555555555',
    ...(opts.runtimeState ? { runtimeState: opts.runtimeState } : {}),
  })
  return { sandbox, runner, requests, procs, sessions, activity }
}

async function handleFor(sandbox: MockSandbox, agentId = 'a1'): Promise<AgentHandle> {
  return sandbox.provision(agentId, {})
}

const ctx = (agentId = 'a1', extra: Partial<{ timeoutMs: number; steerAfterMs: number; modelId: string }> = {}) => ({
  agentId, genome: genome(extra.modelId), goalMd: 'Write a haiku.', timeoutMs: extra.timeoutMs ?? Infinity,
  ...(extra.steerAfterMs !== undefined ? { steerAfterMs: extra.steerAfterMs } : {}),
})

describe('ClaudeCodeAgentRunner', () => {
  test('runs the GOAL as a streamed message and reports the result like the OpenCode path', async () => {
    const { sandbox, runner, requests, procs, sessions, activity } = setup()
    const handle = await handleFor(sandbox)
    await sandbox.writeFile(handle, 'SUBMISSION.md', '# done')
    const result = await runner.run(handle, ctx())
    expect(result).toMatchObject({
      status: 'ok', errorText: null, usageKnown: true,
      tokensIn: 2, tokensOut: 4, tokensCacheRead: 0, tokensCacheWrite: 2552, costUsd: 0,
    })
    const req = requests[0]!
    expect(req.args).toContain('--model=claude-haiku-5-5')
    expect(req.args).toContain('--append-system-prompt=Be terse.')
    expect(req.args).toContain('--add-dir=/ctx')
    expect(req.cwd).toBe(handle.workspacePath)
    expect(procs[0]!.written[0]).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: buildAgentPrompt('Write a haiku.', '/ctx', null) }] } })
    expect(procs[0]!.stdinEnded).toBe(true)
    expect(sessions).toEqual([['a1', '557654c9-3f8a-4d53-83d1-a39f26411f32']])
    expect(activity.some((a) => a.kind === 'text' && a.item.summary === 'OK')).toBe(true)
    expect(await runner.quiesce(handle)).toBe('stopped')
  })

  test('the token travels on its own descriptor, never in argv or a variable', async () => {
    const { sandbox, runner, requests } = setup()
    await runner.run(await handleFor(sandbox), ctx())
    const req = requests[0]!
    expect(req.token).toBe('sk-ant-oat01-test-token-value')
    expect(JSON.stringify([req.args, req.settings, req.secrets])).not.toContain('sk-ant-oat01-test-token-value')
  })

  test('no SUBMISSION.md is no_submission, not an error', async () => {
    const { sandbox, runner } = setup()
    expect((await runner.run(await handleFor(sandbox), ctx())).status).toBe('no_submission')
  })

  test('steering and send deliver further messages while the agent works; send after the result rejects', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { sandbox, runner, procs } = setup({ proc: () => new FakeProc({}) })
    const handle = await handleFor(sandbox)
    const running = runner.run(handle, ctx('a1', { steerAfterMs: 10 }))
    await new Promise((r) => setTimeout(r, 40))
    await runner.send(handle, 'CHANNEL: a teammate wrote to you')
    const p = procs[0]!
    const texts = p.written.map((m) => (m as { message: { content: { text: string }[] } }).message.content[0]!.text)
    expect(texts[1]).toMatch(/Time to submit/)
    expect(texts[2]).toBe('CHANNEL: a teammate wrote to you')
    void gate
    release()
    p.stdout.write(fixture('genuine-haiku-ok.jsonl'))
    await running
    await expect(runner.send(handle, 'late')).rejects.toThrow(/not running/)
  })

  test('a timeout kills the process group and reports what was observed', async () => {
    const { sandbox, runner, procs } = setup({ proc: () => new FakeProc({ exitOnStdinEnd: false }) })
    const handle = await handleFor(sandbox)
    const result = await runner.run(handle, ctx('a1', { timeoutMs: 30 }))
    expect(result).toMatchObject({ status: 'timeout', failure: { code: 'AGENT_TIMEOUT' }, usageKnown: false, costUsd: 0 })
    expect(procs[0]!.kills).toBeGreaterThan(0)
    expect(await runner.quiesce(handle)).toBe('stopped')
  })

  test('an exhausted subscription is its own failure and closes the gate for later attempts', async () => {
    const gate = new SubscriptionLimitGate(() => 1794700000_000)
    const { sandbox, runner, requests } = setup({ gate, proc: () => new FakeProc({ stream: fixture('fake-upstream-429.jsonl'), exitCode: 1 }) })
    const first = await runner.run(await handleFor(sandbox, 'a1'), ctx('a1'))
    expect(first).toMatchObject({ status: 'error', failure: { code: 'SUBSCRIPTION_LIMIT' } })
    expect(first.errorText).toMatch(/not the agent's failure/)
    const second = await runner.run(await handleFor(sandbox, 'a2'), ctx('a2'))
    expect(second).toMatchObject({ status: 'error', failure: { code: 'SUBSCRIPTION_LIMIT' }, tokensIn: 0 })
    expect(requests).toHaveLength(1)
  })

  test('an expired sign-in is reported as such', async () => {
    const { sandbox, runner } = setup({ proc: () => new FakeProc({ stream: fixture('fake-upstream-401.jsonl'), exitCode: 1 }) })
    expect(await runner.run(await handleFor(sandbox), ctx())).toMatchObject({ status: 'error', failure: { code: 'CLAUDE_AUTH_EXPIRED', httpStatus: 401 } })
  })

  test('a missing CLI, missing credentials and an invalid model fail before anything runs', async () => {
    const missing = setup({ launch: () => { throw new ClaudeCliMissingError('no `claude` executable on PATH') } })
    expect(await missing.runner.run(await handleFor(missing.sandbox), ctx())).toMatchObject({ status: 'error', failure: { code: 'CLAUDE_CLI_MISSING' } })

    const enoent = setup({
      proc: () => {
        const p = new FakeProc({})
        setTimeout(() => p.exit(null, Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })), 1)
        return p
      },
    })
    expect(await enoent.runner.run(await handleFor(enoent.sandbox), ctx())).toMatchObject({ failure: { code: 'CLAUDE_CLI_MISSING' } })

    const unsigned = setup({ credentials: async () => { throw new Error('Claude subscription is not signed in') } })
    expect(await unsigned.runner.run(await handleFor(unsigned.sandbox), ctx())).toMatchObject({ failure: { code: 'CLAUDE_AUTH_EXPIRED' } })
    expect(unsigned.requests).toHaveLength(0)

    const bad = setup()
    expect(await bad.runner.run(await handleFor(bad.sandbox), ctx('a1', { modelId: 'claude-subscription/--resume' }))).toMatchObject({ failure: { code: 'CLAUDE_MODEL_UNAVAILABLE' } })
    expect(bad.requests).toHaveLength(0)
  })

  test('an attempt is retained until its process is confirmed gone', async () => {
    const { sandbox, runner, procs } = setup({ proc: () => new FakeProc({ exitOnStdinEnd: false, dieOnKill: false }) })
    const handle = await handleFor(sandbox)
    expect((await runner.run(handle, ctx('a1', { timeoutMs: 20 }))).status).toBe('timeout')
    await expect(runner.assertReadyForRound()).rejects.toThrow(/could not be confirmed stopped/)
    await expect(runner.run(handle, ctx())).rejects.toThrow(/still active/)
    procs[0]!.exit(null)
    await new Promise((r) => setTimeout(r, 10))
    await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
  })

  test('a container confirmed gone releases an attempt whose process never reported back', async () => {
    let state: 'running' | 'stopped' = 'running'
    const { sandbox, runner } = setup({ proc: () => new FakeProc({ exitOnStdinEnd: false, dieOnKill: false }), runtimeState: async () => state })
    const handle = await handleFor(sandbox)
    await runner.run(handle, ctx('a1', { timeoutMs: 20 }))
    await expect(runner.assertReadyForRound()).rejects.toThrow(/container is still running/)
    state = 'stopped'
    await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
  })

  test('a stop while credentials are still being read starts nothing', async () => {
    let release!: () => void
    const pending = new Promise<void>((r) => { release = r })
    const { sandbox, runner, requests } = setup({ credentials: async () => { await pending; return { mode: 'host' } } })
    const handle = await handleFor(sandbox)
    const running = runner.run(handle, ctx())
    expect(await runner.quiesce(handle)).toBe('stopped')
    release()
    expect(await running).toMatchObject({ status: 'error', failure: { code: 'AGENT_STOPPED' } })
    expect(requests).toHaveLength(0)
  })

  test('abortAll stops every live attempt', async () => {
    const { sandbox, runner, procs } = setup({ proc: () => new FakeProc({ exitOnStdinEnd: false }) })
    const h1 = await handleFor(sandbox, 'a1')
    const running = runner.run(h1, ctx('a1'))
    await new Promise((r) => setTimeout(r, 10))
    await runner.abortAll()
    expect(procs[0]!.kills).toBeGreaterThan(0)
    await running
    expect(await runner.quiesce(h1)).toBe('stopped')
  })
})
