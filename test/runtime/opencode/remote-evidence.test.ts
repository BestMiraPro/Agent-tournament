import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OpenCodeAgentRunner, QUIESCE_GRACE_MS } from '../../../src/runtime/opencode/agent-runner.js'
import { OpenCodeClient, type HttpTransport, type PromptResponse } from '../../../src/runtime/opencode/client.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { DockerSandbox } from '../../../src/runtime/docker/sandbox.js'
import { captureSubmission, quiesceAgent, verifyCapture } from '../../../src/engine/capture.js'
import { TournamentEngine } from '../../../src/engine/driver.js'
import { Judge } from '../../../src/judge/judge.js'
import { MockProvider } from '../../../src/runtime/mock-provider.js'
import { makeMockEngine } from '../../helpers/mock-engine.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const terminal: PromptResponse = { info: {}, parts: [{ type: 'text', text: 'done' }] }
const context = (agentId = 'a1', timeoutMs = 50) => ({
  agentId,
  genome: { strategyMd: 's', notesMd: '', modelId: 'mock/model', temperature: 0.7 },
  goalMd: 'goal', timeoutMs,
})

// Every remote boundary is overridden. Unexpected fetches fail instead of reaching a provider.
class DeferredClient extends OpenCodeClient {
  response = deferred<PromptResponse>()
  creation: Promise<{ id: string }> = Promise.resolve({ id: 'session' })
  abortResponse: Promise<void> = Promise.resolve()
  prompts = 0
  sessions = 0
  aborts = 0
  constructor() { super({ baseUrl: 'http://fake.invalid', timeoutMs: 50 }) }
  override async createSession() { this.sessions++; return this.creation }
  override async prompt() { this.prompts++; return this.response.promise }
  override async abort() { this.aborts++; return this.abortResponse }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', () => { throw new Error('unexpected external fetch') })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function fixture() {
  const sandbox = new MockSandbox()
  const handle = await sandbox.provision('a1', {})
  const client = new DeferredClient()
  const runner = new OpenCodeAgentRunner(client, sandbox)
  return { sandbox, handle, client, runner }
}

async function grace<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(QUIESCE_GRACE_MS)
  return promise
}

describe('remote execution evidence', () => {
  test('timeout and abort acknowledgement cannot certify capture; late terminal response can', async () => {
    const { sandbox, handle, client, runner } = await fixture()
    await sandbox.writeFile(handle, 'SUBMISSION.md', 'still changing')
    const run = runner.run(handle, context())
    await vi.advanceTimersByTimeAsync(50)
    expect((await run).status).toBe('timeout')
    expect(client.aborts).toBeGreaterThan(0)
    const stopped = await grace(quiesceAgent(runner, handle))
    expect(stopped).toBe('unconfirmed')
    const capture = await captureSubmission(sandbox, handle, { executionStopped: stopped === 'stopped' })
    const verdict = await verifyCapture(sandbox, handle, capture, { executionStopped: stopped === 'stopped' })
    expect(capture.sealed).toBe(false)
    expect(verdict.verified).toBe(false)
    client.response.resolve(terminal)
    await vi.advanceTimersByTimeAsync(0)
    expect(await runner.quiesce(handle)).toBe('stopped')
  })

  test('transport rejection remains unconfirmed after abortAll and blocks repeat invocation', async () => {
    const { handle, client, runner } = await fixture()
    const run = runner.run(handle, context())
    await vi.advanceTimersByTimeAsync(0)
    client.response.reject(new TypeError('connection lost'))
    expect((await run).status).toBe('error')
    await grace(runner.abortAll())
    expect(await grace(runner.quiesce(handle))).toBe('unconfirmed')
    await expect(runner.run(handle, context())).rejects.toThrow(/unconfirmed|still active/i)
    expect(client.sessions).toBe(1)
  })

  test('repeat invocation cannot overwrite an in-flight agent or workspace record', async () => {
    const { handle, client, runner } = await fixture()
    const original = runner.run(handle, context('a1', 60_000))
    await vi.advanceTimersByTimeAsync(0)
    const duplicate = runner.run(handle, context()).catch((error: unknown) => error)
    const sameWorkspace = runner.run({ ...handle, agentId: 'a2' }, context('a2')).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.sessions).toBe(1)
    client.response.resolve(terminal)
    expect(await duplicate).toBeInstanceOf(Error)
    expect(await sameWorkspace).toBeInstanceOf(Error)
    await original
    expect(await runner.quiesce(handle)).toBe('stopped')
    expect((await runner.run(handle, context())).status).toBe('no_submission')
  })

  test('equivalent workspace paths cannot evade the live workspace guard', async () => {
    const { handle, client, runner } = await fixture()
    const original = runner.run(handle, context('a1', 60_000))
    await vi.advanceTimersByTimeAsync(0)
    const duplicate = runner.run({ ...handle, agentId: 'a2', workspacePath: `${handle.workspacePath}/.` }, context('a2'))
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.sessions).toBe(1)
    client.response.resolve(terminal)
    expect(await duplicate).toBeInstanceOf(Error)
    await original
  })

  test('run timeout and quiesce remain bounded even if abort never responds', async () => {
    const { handle, client, runner } = await fixture()
    client.abortResponse = new Promise(() => {})
    let result: string | undefined
    const run = runner.run(handle, context()).then((r) => { result = r.status })
    await vi.advanceTimersByTimeAsync(50)
    expect(result).toBe('timeout')
    let stopped: string | undefined
    const quiesce = runner.quiesce(handle).then((s) => { stopped = s })
    await vi.advanceTimersByTimeAsync(QUIESCE_GRACE_MS)
    expect(stopped).toBe('unconfirmed')
    await Promise.all([run, quiesce])
  })

  test('abortAll bounds multiple uncertain sessions to one concurrent grace and retains them', async () => {
    const { sandbox, handle, client, runner } = await fixture()
    const second = await sandbox.provision('a2', {})
    const firstRun = runner.run(handle, context('a1', 60_000))
    const secondRun = runner.run(second, context('a2', 60_000))
    await vi.advanceTimersByTimeAsync(0)
    let finished = false
    const abort = runner.abortAll().then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(QUIESCE_GRACE_MS)
    expect(finished).toBe(true)
    expect(client.aborts).toBe(2)
    await abort
    expect(await grace(runner.quiesce(handle))).toBe('unconfirmed')
    expect(await grace(runner.quiesce(second))).toBe('unconfirmed')
    client.response.resolve(terminal)
    await Promise.all([firstRun, secondRun])
  })

  test('abort during pending creation prevents a late create response from dispatching a prompt', async () => {
    const { handle, client, runner } = await fixture()
    const creation = deferred<{ id: string }>()
    client.creation = creation.promise
    const run = runner.run(handle, context())
    await grace(runner.abortAll())
    creation.resolve({ id: 'late-session' })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.prompts).toBe(0)
    expect((await run).status).toBe('error')
    expect(await runner.quiesce(handle)).toBe('stopped')
  })

  test('session creation failure and terminal provider error response are safe to reuse', async () => {
    const { handle, client, runner } = await fixture()
    client.creation = Promise.reject(new Error('create failed'))
    expect((await runner.run(handle, context())).status).toBe('error')
    expect(await runner.quiesce(handle)).toBe('stopped')
    client.creation = Promise.resolve({ id: 'next' })
    client.response.resolve({ info: { cost: 0.2, error: { name: 'APIError', data: { message: 'provider failed' } } } })
    const result = await runner.run(handle, context())
    expect(result.status).toBe('error')
    expect(result.costUsd).toBe(0.2)
    expect(await runner.quiesce(handle)).toBe('stopped')
  })

  test('real client fetch deadline is a timeout even when AbortSignal rejects before the runner timer', async () => {
    const { sandbox, handle } = await fixture()
    let aborts = 0
    const transport: HttpTransport = async ({ url, signal }) => {
      const path = url.pathname
      if (path === '/session') return { status: 200, text: JSON.stringify({ id: 'session' }) }
      if (path.endsWith('/abort')) { aborts++; return { status: 200, text: 'null' } }
      if (path.endsWith('/message')) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
      throw new Error(`unexpected request ${path}`)
    }
    const runner = new OpenCodeAgentRunner(new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 50, transport }), sandbox)
    const run = runner.run(handle, context())
    await vi.advanceTimersByTimeAsync(50)
    expect((await run).status).toBe('timeout')
    expect(aborts).toBe(1)
    expect(await grace(runner.quiesce(handle))).toBe('unconfirmed')
  })

  describe('after a timeout, the server\'s own session status', () => {
    const timedOutRunner = async (status: () => unknown) => {
      const { sandbox, handle } = await fixture()
      let statusReads = 0
      const transport: HttpTransport = async ({ url, signal }) => {
        const path = url.pathname
        if (path === '/session') return { status: 200, text: JSON.stringify({ id: 'session' }) }
        if (path.endsWith('/abort')) return { status: 200, text: 'true' }
        if (path === '/session/status') {
          statusReads++
          expect(url.searchParams.get('directory')).toBe(handle.workspacePath)
          return { status: 200, text: JSON.stringify(status()) }
        }
        if (path.endsWith('/message')) return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
        throw new Error(`unexpected request ${path}`)
      }
      const runner = new OpenCodeAgentRunner(new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 50, transport }), sandbox)
      const run = runner.run(handle, context())
      await vi.advanceTimersByTimeAsync(50)
      expect((await run).status).toBe('timeout')
      return { runner, handle, reads: () => statusReads }
    }

    test('reporting the session idle confirms the stop, so the next round is not blocked forever', async () => {
      let busy = 2
      const { runner, handle, reads } = await timedOutRunner(() => (busy-- > 0 ? { session: { type: 'busy' } } : {}))
      expect(await grace(runner.quiesce(handle))).toBe('stopped')
      expect(reads()).toBeGreaterThanOrEqual(3)
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
    })

    test('still busy, or unreadable, confirms nothing', async () => {
      const busy = await timedOutRunner(() => ({ session: { type: 'busy' } }))
      expect(await grace(busy.runner.quiesce(busy.handle))).toBe('unconfirmed')
      await expect(busy.runner.assertReadyForRound()).rejects.toThrow(/unconfirmed/)
      const garbled = await timedOutRunner(() => ['not', 'a', 'map'])
      expect(await grace(garbled.runner.quiesce(garbled.handle))).toBe('unconfirmed')
    })
  })

  test.each([null, {}])('malformed successful HTTP response %j is not terminal evidence', async (response) => {
    const { sandbox, handle } = await fixture()
    const transport: HttpTransport = async ({ url }) => {
      const path = url.pathname
      if (path === '/session') return { status: 200, text: JSON.stringify({ id: 'session' }) }
      if (path.endsWith('/abort')) return { status: 200, text: 'null' }
      if (path.endsWith('/message')) return { status: 200, text: JSON.stringify(response) }
      throw new Error(`unexpected request ${path}`)
    }
    const runner = new OpenCodeAgentRunner(new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 50, transport }), sandbox)
    expect((await runner.run(handle, context())).status).toBe('error')
    expect(await grace(runner.quiesce(handle))).toBe('unconfirmed')
  })

  describe('authoritative runtime termination', () => {
    const oomFailure = { code: 'CONTAINER_OOM', message: 'Container fake-0 was stopped for exceeding its 1g memory limit.' }

    async function terminatedFixture(states: Map<string, 'running' | 'stopped' | 'unknown'>, diagnose: boolean) {
      const sandbox = new MockSandbox()
      const handle = await sandbox.provision('a1', {})
      const client = new DeferredClient()
      const consulted: (string | undefined)[] = []
      const runner = new OpenCodeAgentRunner(client, sandbox, {
        resourceFailure: async () => (diagnose ? oomFailure : null),
        runtimeState: async (h) => {
          consulted.push(h.runtimeId)
          return states.get(h.runtimeId ?? '') ?? 'unknown'
        },
      })
      return { sandbox, handle, client, runner, consulted }
    }

    test('a stopped original container unblocks the next round and keeps the original evidence', async () => {
      const states = new Map([['cid-1', 'stopped' as const]])
      const { sandbox, handle, client, runner, consulted } = await terminatedFixture(states, true)
      const run = runner.run({ ...handle, runtimeId: 'cid-1' }, context())
      await vi.advanceTimersByTimeAsync(0)
      client.response.reject(new TypeError('connection lost'))
      const result = await run
      expect(result.status).toBe('error')
      // The OOM classification and the unknown usage survive reconciliation,
      // and no submission is manufactured for the dead worker.
      expect(result.failure).toMatchObject({ code: 'CONTAINER_OOM' })
      expect(result.usageKnown).toBe(false)
      expect(await sandbox.readFile(handle, 'SUBMISSION.md')).toBeNull()
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
      // Termination resolved against the invocation's original container ID.
      expect(consulted).toContain('cid-1')
    })

    test('a confirmed exit without OOM evidence keeps the original failure, not a resource one', async () => {
      const states = new Map([['cid-1', 'stopped' as const]])
      const { handle, client, runner } = await terminatedFixture(states, false)
      const run = runner.run({ ...handle, runtimeId: 'cid-1' }, context())
      await vi.advanceTimersByTimeAsync(0)
      client.response.reject(new TypeError('connection lost'))
      const result = await run
      expect(result.failure?.code).not.toBe('CONTAINER_OOM')
      expect(result.usageKnown).toBe(false)
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
    })

    test('the refusal names the blocking agent and distinguishes the three unresolved cases', async () => {
      const states = new Map<string, 'running' | 'stopped' | 'unknown'>([['cid-1', 'unknown']])
      const { handle, client, runner } = await terminatedFixture(states, true)
      // Locally pending first: the invocation has not returned at all.
      const run = runner.run({ ...handle, runtimeId: 'cid-1' }, context('a1', 60_000))
      await vi.advanceTimersByTimeAsync(0)
      await expect(runner.assertReadyForRound()).rejects.toThrow(/agent a1.*has not returned locally/)
      // A transport failure ends the local run while remote termination stays
      // unconfirmed: the refusal must now distinguish the runtime evidence.
      client.response.reject(new TypeError('connection lost'))
      await run
      // Original container still running.
      states.set('cid-1', 'running')
      await expect(runner.assertReadyForRound()).rejects.toThrow(/agent a1.*original container.*is still running/)
      // Runtime evidence unreadable.
      states.set('cid-1', 'unknown')
      await expect(runner.assertReadyForRound()).rejects.toThrow(/agent a1.*could not establish whether the original container.*stopped/)
      // And resolved once the container is confirmed stopped.
      states.set('cid-1', 'stopped')
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
    })

    test('without a runtime callback the legacy refusal is kept', async () => {
      const { handle, client, runner } = await fixture()
      const run = runner.run(handle, context())
      await vi.advanceTimersByTimeAsync(0)
      client.response.reject(new TypeError('connection lost'))
      await run
      await expect(runner.assertReadyForRound()).rejects.toThrow(
        'previous round is still active or remote termination is unconfirmed',
      )
    })

    test('quiesce confirms an OOM-killed worker without waiting for its dead server', async () => {
      const states = new Map([['cid-1', 'stopped' as const]])
      const { handle, client, runner } = await terminatedFixture(states, true)
      const run = runner.run({ ...handle, runtimeId: 'cid-1' }, context())
      await vi.advanceTimersByTimeAsync(0)
      client.response.reject(new TypeError('connection lost'))
      await run
      // No grace advance: the status endpoint stays unreachable, and runtime
      // evidence answers at once.
      expect(await runner.quiesce(handle)).toBe('stopped')
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
    })

    test('a late terminal response from an old invocation never clears a newer one', async () => {
      class TwoShotClient extends OpenCodeClient {
        first = deferred<PromptResponse>()
        second = deferred<PromptResponse>()
        calls = 0
        constructor() { super({ baseUrl: 'http://fake.invalid', timeoutMs: 50 }) }
        override async createSession() { return { id: 's' } }
        override async prompt() { return ++this.calls === 1 ? this.first.promise : this.second.promise }
        override async abort() {}
      }
      const sandbox = new MockSandbox()
      const handle = await sandbox.provision('a1', {})
      const client = new TwoShotClient()
      const states = new Map([['cid-1', 'stopped' as const]])
      const runner = new OpenCodeAgentRunner(client, sandbox, {
        runtimeState: async (h) => states.get(h.runtimeId ?? '') ?? 'unknown',
      })
      // The old invocation times out locally while its prompt stays pending.
      const old = runner.run({ ...handle, runtimeId: 'cid-1' }, context('a1', 50))
      await vi.advanceTimersByTimeAsync(50)
      expect((await old).status).toBe('timeout')
      // Runtime evidence reconciles it away, so the same agent runs again.
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
      const next = runner.run({ ...handle, runtimeId: 'cid-2' }, context('a1', 60_000))
      await vi.advanceTimersByTimeAsync(0)
      // The old prompt finally answers terminally — long after its invocation
      // was forgotten. The newer invocation must be untouched.
      client.first.resolve(terminal)
      await vi.advanceTimersByTimeAsync(0)
      await expect(runner.assertReadyForRound()).rejects.toThrow(/has not returned locally/)
      client.second.resolve(terminal)
      await next
      await expect(runner.assertReadyForRound()).resolves.toBeUndefined()
    })
  })

  test('engine capture stays unverified and a second round cannot reset an uncertain workspace', async () => {
    const base = makeMockEngine({ seed: 1, populationSize: 2, isolatedWorkspaces: true })
    const client = new DeferredClient()
    const runner = new OpenCodeAgentRunner(client, base.sandbox)
    const engine = new TournamentEngine({
      repos: base.repos, config: { ...base.config, agentTimeoutMs: 50 }, sandbox: base.sandbox,
      runner, judge: new Judge(new MockProvider(1), base.config.judge, 1), reflector: base.reflector,
      seedStrategy: () => 'strategy',
    })
    try {
      const run = engine.createRun('remote', 'original goal')
      const first = engine.runRound(run.id, { goalMd: 'original goal', criteriaMd: null })
      await vi.advanceTimersByTimeAsync(50 + QUIESCE_GRACE_MS)
      await first
      const captures = base.repos.events.forRun(run.id).filter((e) => e.type === 'submission.captured')
      expect(captures).toHaveLength(2)
      expect(captures.every((e) => e.payload.quiesce === 'unconfirmed' && e.payload.verified === false)).toBe(true)
      const agent = base.repos.agents.listActive(run.id)[0]!
      const handle = { agentId: agent.id, workspacePath: `/mock/${agent.id}`, baseUrl: '' }
      await base.sandbox.writeFile(handle, 'SUBMISSION.md', 'remote writer still owns this')
      const provision = vi.spyOn(base.sandbox, 'provision')
      const reset = vi.spyOn(base.sandbox, 'reset')
      const second = engine.runRound(run.id, { goalMd: 'replacement goal', criteriaMd: null })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(50 + QUIESCE_GRACE_MS)
      expect(provision).not.toHaveBeenCalled()
      expect(reset).not.toHaveBeenCalled()
      expect(await second).toBeInstanceOf(Error)
      // The refused preflight happens before any round row is inserted: no round
      // number consumed, no spurious failed round left behind.
      expect(base.repos.rounds.listForRun(run.id)).toHaveLength(1)
      expect(await base.sandbox.readFile(handle, 'SUBMISSION.md')).toBe('remote writer still owns this')
      expect(await base.sandbox.readFile(handle, 'GOAL.md')).toBe('original goal')
    } finally { base.db.close() }
  })

  test('a culled uncertain writer blocks the next shared-shard round until its terminal response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arena-remote-round-'))
    const base = makeMockEngine({ seed: 1, populationSize: 2 })
    // Real shared-shard bookkeeping/files, but no container process or remote calls.
    const startContainer = vi.fn(async (shardIndex: number) => ({
      name: `fake-shard-${shardIndex}`, baseUrl: 'http://fake.invalid', shardIndex,
    }))
    const sandbox = new DockerSandbox({
      runId: 'fake', root, maxContainers: 1, image: 'fake', memory: '1g', cpus: 1,
      authFile: null, startContainer, stopContainer: async () => {},
    })
    const client = new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 50 })
    vi.spyOn(client, 'createSession').mockImplementation(async (directory) => ({ id: directory }))
    vi.spyOn(client, 'abort').mockResolvedValue(undefined)
    const runner = new OpenCodeAgentRunner(client, sandbox)
    const planning = vi.fn((ids: readonly string[]) => sandbox.planFor(ids))
    const bothPrompted = deferred<void>()
    const survivorReturned = deferred<void>()
    const uncertain = deferred<PromptResponse>()
    const survivor = deferred<PromptResponse>()
    let uncertainId = ''
    let survivorId = ''
    let firstPrompts = 0
    const handleFor = (agentId: string) => ({
      agentId, workspacePath: `/work/${agentId}`, baseUrl: 'http://fake.invalid',
    })
    vi.spyOn(client, 'prompt').mockImplementation(async (_sessionId, directory) => {
      const agentId = directory.slice('/work/'.length)
      if (firstPrompts < 2) {
        firstPrompts++
        if (firstPrompts === 2) bothPrompted.resolve()
        if (agentId === uncertainId) return uncertain.promise
        await survivor.promise
      }
      await sandbox.writeFile(handleFor(agentId), 'SUBMISSION.md', '# Submission\nFITNESS=0.9\n')
      return terminal
    })
    const engine = new TournamentEngine({
      repos: base.repos,
      config: {
        ...base.config, agentTimeoutMs: 50, concurrency: 2,
        selection: { ...base.config.selection, topPct: 0.5, bottomPct: 0.5 },
      },
      sandbox, runner, judge: new Judge(new MockProvider(1), base.config.judge, 1),
      reflector: base.reflector, seedStrategy: () => 'strategy', preparePopulation: planning,
      onEvent: (event) => {
        if (event.type === 'agent.status' && event.agentId === survivorId && event.status === 'done') {
          survivorReturned.resolve()
        }
      },
    })
    try {
      const run = engine.createRun('shared remote', 'original goal')
      const originalIds = base.repos.agents.listActive(run.id).map((agent) => agent.id)
      uncertainId = originalIds[0]!
      survivorId = originalIds[1]!
      const first = engine.runRound(run.id, { goalMd: 'original goal', criteriaMd: null })
      // Both current-round workers must enter while the other prompt is still pending.
      await bothPrompted.promise
      expect(firstPrompts).toBe(2)
      expect(sandbox.isolatedWorkspace(handleFor(survivorId))).toBe(false)
      survivor.resolve(terminal)
      await survivorReturned.promise
      await vi.advanceTimersByTimeAsync(50 + QUIESCE_GRACE_MS)
      await first

      const activeIds = base.repos.agents.listActive(run.id).map((agent) => agent.id)
      expect(activeIds).toHaveLength(2)
      expect(activeIds).toContain(survivorId)
      expect(activeIds).not.toContain(uncertainId)
      expect(activeIds.some((id) => !originalIds.includes(id))).toBe(true)
      for (const id of activeIds) expect(await runner.quiesce(handleFor(id))).toBe('stopped')
      const captures = base.repos.events.forRun(run.id).filter((event) => event.type === 'submission.captured')
      expect(captures.find((event) => event.agentId === uncertainId)?.payload.quiesce).toBe('unconfirmed')
      expect(captures.find((event) => event.agentId === survivorId)?.payload.quiesce).toBe('stopped')

      await sandbox.writeFile(handleFor(survivorId), 'SUBMISSION.md', 'preserve prior workspace')
      planning.mockClear()
      const provision = vi.spyOn(sandbox, 'provision')
      const reset = vi.spyOn(sandbox, 'reset')
      const refused = await engine.runRound(run.id, { goalMd: 'replacement goal', criteriaMd: null })
        .catch((error: unknown) => error)
      expect(planning).not.toHaveBeenCalled()
      expect(provision).not.toHaveBeenCalled()
      expect(reset).not.toHaveBeenCalled()
      expect(refused).toBeInstanceOf(Error)
      // The refused preflight happens before any round row is inserted.
      expect(base.repos.rounds.listForRun(run.id)).toHaveLength(1)
      expect(await sandbox.readFile(handleFor(survivorId), 'SUBMISSION.md')).toBe('preserve prior workspace')
      expect(await sandbox.readFile(handleFor(survivorId), 'GOAL.md')).toBe('original goal')

      uncertain.resolve(terminal)
      await vi.advanceTimersByTimeAsync(0)
      expect(await runner.quiesce(handleFor(uncertainId))).toBe('stopped')
      await engine.runRound(run.id, { goalMd: 'replacement goal', criteriaMd: null })
      expect(planning).toHaveBeenCalledOnce()
      expect(provision).toHaveBeenCalledTimes(2)
      expect(reset).toHaveBeenCalledTimes(2)
      expect(startContainer).toHaveBeenCalledOnce()
      expect(await sandbox.readFile(handleFor(survivorId), 'GOAL.md')).toBe('replacement goal')
    } finally {
      await sandbox.disposeAll()
      base.db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
