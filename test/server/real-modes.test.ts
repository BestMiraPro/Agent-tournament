import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import type { Provider } from '../../src/runtime/provider.js'
import { sweepOrphanContainers } from '../../src/runtime/docker/sweep.js'
import type { OpenCodeClient, PromptBody, PromptResponse } from '../../src/runtime/opencode/client.js'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry, disposeRunRecord } from '../../src/server/runs.js'
import { composeRun, defaultSeams, type ComposedRun } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'
import { toolchainSeams } from './toolchain-stubs.js'

// Spy on disposeRunRecord for the stop-run tests without losing the real
// teardown (the ordering test below still exercises the real implementation).
vi.mock('../../src/server/runs.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/server/runs.js')>()
  return { ...orig, disposeRunRecord: vi.fn(orig.disposeRunRecord) }
})

/** A fake OpenCodeClient that 404s `opencode/bad-worker` and succeeds for everything else. */
function badWorkerClient(): OpenCodeClient {
  return {
    createSession: async () => ({ id: 'ses_1' }),
    prompt: async (_sessionId: string, _directory: string, body: PromptBody): Promise<PromptResponse> => {
      const modelId = `${body.model.providerID}/${body.model.modelID}`
      if (modelId === 'opencode/bad-worker') {
        return { info: { error: { name: 'APIError', data: { statusCode: 404, message: 'Not Found' } } }, parts: [] }
      }
      return body.format
        ? {
            info: {},
            parts: [
              { type: 'tool', tool: 'StructuredOutput', state: { input: { ok: 'ok' }, metadata: { valid: true } } },
            ],
          }
        : { info: {}, parts: [{ type: 'text', text: 'ok' }] }
    },
  } as unknown as OpenCodeClient
}

/** A roster with one good and one bad worker model, for probe-severity tests. */
function probeConfig(): RunConfig {
  return {
    ...DEFAULT_CONFIG,
    roster: [
      { modelId: 'opencode/big-pickle', count: 2, temperature: 0.7 },
      { modelId: 'opencode/bad-worker', count: 2, temperature: 0.7 },
    ],
  }
}

describe('real-mode wiring', () => {
  test('a composed local run registers bridges and disposes them', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const stop = vi.fn()
    registry.set({
      runId: 'r1', spec: { sandbox: 'local' } as never,
      engine: {} as never, manager: { disposeAll: vi.fn() } as never,
      composed: { cleanup: vi.fn(async () => {}) } as never,
      bridges: [{ stop }],
      warnings: [], capacity: null,
    })
    expect(registry.get('r1')!.bridges).toHaveLength(1)
    for (const b of registry.get('r1')!.bridges) b.stop()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('POST /api/runs with fakes creates a bridged run', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called for specs') }) as never,
      registry: new RunRegistry(),
      composeWith: (async () => ({
        // NOTE: brief sketch said `config: {}`; a real engine.createRun needs a
        // valid config, so the fake carries one (test-only change).
        config: {
          ...DEFAULT_CONFIG, populationSize: 1, sandbox: 'mock',
          roster: [{ modelId: 'mock/model', count: 1, temperature: 0.7 }],
        },
        sandbox: {}, provider: {}, runner: {},
        planFor: null, serverHandle: null, shardServers: [],
        sessionMap: new Map(), sessionHook: () => {}, warnings: [],
        capacity: null, cleanup: async () => {},
      })) as never,
    } as never)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
    })
    expect(res.statusCode).toBe(201)
  })

  test('a local spec persists a RunRecord with one bridge', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const sessionMap = new Map([['ses_1', 'agent-1']])
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called for specs') }) as never,
      registry,
      composeWith: (async () => ({
        config: {
          ...DEFAULT_CONFIG, populationSize: 1, sandbox: 'local',
          roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
        },
        sandbox: {}, provider: {}, runner: {},
        planFor: null,
        serverHandle: { baseUrl: 'http://127.0.0.1:1', client: {}, stop: async () => {} },
        shardServers: [],
        sessionMap, sessionHook: () => {}, warnings: [],
        capacity: null, cleanup: async () => {},
      })) as never,
    } as never)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
    })
    expect(res.statusCode).toBe(201)
    const runId = (JSON.parse(res.body) as { runId: string }).runId
    const record = registry.get(runId)
    expect(record).not.toBeNull()
    expect(record!.bridges).toHaveLength(1)
    expect(record!.composed.sessionMap.get('ses_1')).toBe('agent-1')
    expect(repos.runs.get(runId)).not.toBeNull()
  })

  test('docker starts one bridge per shard; mock starts none', async () => {
    const mk = (shardServers: { baseUrl: string }[], sandbox: string) => {
      const db = openDb(':memory:')
      const repos = makeRepos(db)
      const registry = new RunRegistry()
      const app = buildApi({
        repos,
        manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
        createRun: (() => { throw new Error('must not be called for specs') }) as never,
        registry,
        composeWith: (async () => ({
          config: {
            ...DEFAULT_CONFIG, populationSize: 1, sandbox,
            roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
          },
          sandbox: {}, provider: {}, runner: {},
          planFor: null, serverHandle: null, shardServers,
          sessionMap: new Map(), sessionHook: () => {}, warnings: [],
          capacity: null, cleanup: async () => {},
        })) as never,
      } as never)
      return { app, registry }
    }
    const docker = mk(
      [{ baseUrl: 'http://127.0.0.1:1' }, { baseUrl: 'http://127.0.0.1:2' }],
      'docker',
    )
    const dres = await docker.app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
    })
    expect(dres.statusCode).toBe(201)
    const did = (JSON.parse(dres.body) as { runId: string }).runId
    expect(docker.registry.get(did)!.bridges).toHaveLength(2)

    const mock = mk([], 'mock')
    const mres = await mock.app.inject({
      method: 'POST', url: '/api/runs',
      payload: { name: 'm', goal: 'g', sandbox: 'mock', roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }] },
    })
    expect(mres.statusCode).toBe(201)
    const mid = (JSON.parse(mres.body) as { runId: string }).runId
    expect(mock.registry.get(mid)!.bridges).toHaveLength(0)
  })

  test('docker bridges follow shard endpoints that appear after run creation', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    let publish!: (server: { shardIndex: number; baseUrl: string }) => void
    let subscribed = true
    const stoppedSignals: AbortSignal[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal
      stoppedSignals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const composed = {
      config: {
        ...DEFAULT_CONFIG,
        populationSize: 1,
        sandbox: 'docker',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
      sandbox: new MockSandbox(),
      provider: new MockProvider(42),
      runner: new MockAgentRunner(new MockSandbox(), 42),
      planFor: async () => {},
      serverHandle: null,
      shardServers: [],
      onShardServer: (listener: (server: { shardIndex: number; baseUrl: string }) => void) => {
        publish = listener
        return () => { subscribed = false }
      },
      sessionMap: new Map(), sessionHook: () => {}, warnings: [], capacity: null,
      cleanup: vi.fn(async () => {}),
    } as unknown as ComposedRun
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called for specs') }) as never,
      registry,
      composeWith: async () => composed,
    })

    try {
      const res = await app.inject({
        method: 'POST', url: '/api/runs',
        payload: {
          name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
          roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
        },
      })
      expect(res.statusCode).toBe(201)
      const runId = (JSON.parse(res.body) as { runId: string }).runId
      const record = registry.get(runId)!
      expect(fetchMock).not.toHaveBeenCalled()

      publish({ shardIndex: 0, baseUrl: 'http://127.0.0.1:41000' })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      publish({ shardIndex: 0, baseUrl: 'http://127.0.0.1:41000' })
      await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      publish({ shardIndex: 0, baseUrl: 'http://127.0.0.1:42000' })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      expect(stoppedSignals[0]!.aborted).toBe(true)

      await disposeRunRecord(record)
      expect(subscribed).toBe(false)
      expect(stoppedSignals[1]!.aborted).toBe(true)
      publish({ shardIndex: 1, baseUrl: 'http://127.0.0.1:43000' })
      await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
      await app.close()
    }
  })

  test('API-created rounds plan the full changed active population each time', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const sandbox = new MockSandbox()
    const plans: string[][] = []
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: 6,
      sandbox: 'docker',
      roster: [{ modelId: 'mock/model', count: 6, temperature: 0.7 }],
    }
    const composed: ComposedRun = {
      config,
      sandbox,
      provider: new MockProvider(42),
      runner: new MockAgentRunner(sandbox, 42),
      planFor: async (ids) => { plans.push([...ids]) },
      serverHandle: null,
      shardServers: [],
      sessionMap: new Map(),
      sessionHook: () => {},
      warnings: [],
      capacity: null,
      cleanup: async () => {},
    }
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called for specs') }) as never,
      registry,
      composeWith: async () => composed,
    })
    const create = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'planned', goal: 'g', sandbox: 'docker', isolation: 'shared',
        workspaceRoot: process.platform === 'win32' ? 'C:\\tmp\\arena-planned' : '/tmp/arena-planned',
        authFile: process.platform === 'win32' ? 'C:\\tmp\\auth.json' : '/tmp/auth.json',
        roster: [{ modelId: 'mock/model', count: 6, temperature: 0.7 }],
      },
    })
    expect(create.statusCode).toBe(201)
    const runId = (JSON.parse(create.body) as { runId: string }).runId
    const record = registry.get(runId)!
    const originalIds = repos.agents.listActive(runId).map((agent) => agent.id)

    const first = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' },
    })
    expect(first.statusCode).toBe(202)
    await record.manager.waitForIdle(runId)
    const round1 = repos.rounds.listForRun(runId)[0]!
    expect(repos.scores.forRound(round1.id)).toHaveLength(6)

    const bred = repos.agents.listActive(runId)
    expect(bred.map((agent) => agent.id)).not.toEqual(originalIds)
    const retired = bred[0]!
    repos.agents.retire(retired.id, 2, 'retired')
    const added = repos.agents.create({
      runId,
      label: 'manual-add',
      parentAgentId: null,
      bornRound: 2,
    })
    repos.genomes.create({
      agentId: added.id,
      roundIdx: 2,
      strategyMd: 'manual strategy',
      notesMd: '',
      modelId: 'mock/model',
      temperature: 0.7,
      parentGenomeId: null,
      origin: 'seed',
    })
    const editedIds = repos.agents.listActive(runId).map((agent) => agent.id)

    const second = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' },
    })
    expect(second.statusCode).toBe(202)
    await record.manager.waitForIdle(runId)
    const round2 = repos.rounds.listForRun(runId)[1]!
    const scoredIds = repos.scores.forRound(round2.id).map((score) => score.agentId).sort()

    expect(plans).toEqual([originalIds, editedIds])
    expect(plans[1]).toContain(added.id)
    expect(plans[1]).not.toContain(retired.id)
    expect(scoredIds).toEqual([...editedIds].sort())
    await app.close()
  })

  test('compose failures map to 400/409, never 500', async () => {
    const mk = (error: Error) => {
      const db = openDb(':memory:')
      const repos = makeRepos(db)
      return buildApi({
        repos,
        manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
        createRun: (() => { throw new Error('must not be called') }) as never,
        registry: new RunRegistry(),
        composeWith: (async () => { throw error }) as never,
      } as never)
    }
    const bad = await mk(new Error('docker sandbox: host cannot fit 4 containers')).inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
    })
    // Spec section 3: capacity refusal is 409 (contention), not 400 (validation).
    expect(bad.statusCode).toBe(409)
    expect(JSON.parse(bad.body).error).toMatch(/docker sandbox/)
    const conflict = await mk(new Error('address already in use :::1234')).inject({
      method: 'POST', url: '/api/runs',
      payload: {
        name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      },
    })
    expect(conflict.statusCode).toBe(409)
  })

  test('a createRun failure cleans up the composed run and returns 400', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const cleanup = vi.fn(async () => {})
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called') }) as never,
      registry,
      composeWith: (async () => ({
        // Roster sums to 2 but populationSize is 1: engine.createRun refuses.
        config: {
          ...DEFAULT_CONFIG, populationSize: 1, sandbox: 'mock',
          roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
        },
        sandbox: {}, provider: {}, runner: {},
        planFor: null, serverHandle: null, shardServers: [],
        sessionMap: new Map(), sessionHook: () => {}, warnings: [],
        capacity: null, cleanup,
      })) as never,
    } as never)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: { name: 'm', goal: 'g', sandbox: 'mock', roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }] },
    })
    expect(res.statusCode).toBe(400)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(0)
  })

  test('the compose seam receives a holder set to the live run id', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    let seen: { value: string } | null = null
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called') }) as never,
      registry,
      composeWith: (async (_spec: unknown, opts?: { runIdHolder?: { value: string } }) => {
        seen = opts?.runIdHolder ?? null
        return {
          config: {
            ...DEFAULT_CONFIG, populationSize: 1, sandbox: 'mock',
            roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
          },
          sandbox: {}, provider: {}, runner: {},
          planFor: null, serverHandle: null, shardServers: [],
          sessionMap: new Map(), sessionHook: () => {}, warnings: [],
          capacity: null, cleanup: async () => {},
        }
      }) as never,
    } as never)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: { name: 'm', goal: 'g', sandbox: 'mock', roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }] },
    })
    expect(res.statusCode).toBe(201)
    const runId = (JSON.parse(res.body) as { runId: string }).runId
    expect(seen).not.toBeNull()
    expect(seen!.value).toBe(runId)
  })

  test('disposeRunRecord stops bridges, then awaits in-flight rounds, then cleans up', async () => {
    const stop = vi.fn()
    const cleanup = vi.fn(async () => {})
    const disposeAll = vi.fn(async () => {})
    await disposeRunRecord({
      runId: 'r1', spec: {} as never, engine: {} as never,
      manager: { disposeAll } as never, composed: { cleanup } as never,
      bridges: [{ stop }], warnings: [], capacity: null,
    })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(disposeAll).toHaveBeenCalledTimes(1)
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(disposeAll.mock.invocationCallOrder[0]!)
    expect(disposeAll.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]!)
  })

  test('a docker sweep runs with the live id on the server path, pending id on the CLI path', async () => {
    const seams = () => ({
      startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
      attachHostServer: vi.fn(),
      ensureImageFn: vi.fn(async () => {}), ...toolchainSeams(),
      readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
      sweepFn: vi.fn(async () => [] as string[]),
      validateModels: vi.fn(async () => {}),
      inspectPath: vi.fn(() => 'file' as const),
    })
    const dockerSpec = () => parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
      roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
    })
    const holderSeams = seams()
    await composeRun(dockerSpec(), holderSeams as never, { runIdHolder: { value: '' } })
    expect(holderSeams.sweepFn).not.toHaveBeenCalled()

    const cliSeams = seams()
    await composeRun(dockerSpec(), cliSeams as never)
    expect(cliSeams.sweepFn).toHaveBeenCalledTimes(1)
    const calls = cliSeams.sweepFn.mock.calls as unknown as { activeRunIds: string[] }[][]
    expect(calls[0]?.[0]?.activeRunIds).toEqual([expect.stringMatching(/^pending-/)])
  })

  test('POST /rounds for a registered run routes to the record manager, not the global one', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const globalStart = vi.fn()
    const recordStart = vi.fn()
    const registry = new RunRegistry()
    const row = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
    registry.set({
      runId: row.id, spec: {} as never, engine: {} as never,
      manager: { isBusy: () => false, lastError: () => null, startRound: recordStart } as never,
      composed: { cleanup: async () => {} } as never,
      bridges: [], warnings: [], capacity: null,
    })
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: globalStart } as never,
      createRun: (() => { throw new Error('nope') }) as never,
      registry,
    } as never)
    const res = await app.inject({ method: 'POST', url: `/api/runs/${row.id}/rounds`, payload: { goalMd: 'g' } })
    expect(res.statusCode).toBe(202)
    expect(recordStart).toHaveBeenCalledTimes(1)
    expect(globalStart).not.toHaveBeenCalled()
  })

  test('GET /api/runs/:id reports busy and lastError from the record manager', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const row = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
    registry.set({
      runId: row.id, spec: {} as never, engine: {} as never,
      manager: {
        isBusy: (id: string) => id === row.id,
        lastError: () => 'record error',
        startRound: () => {},
      } as never,
      composed: { cleanup: async () => {} } as never,
      bridges: [], warnings: [], capacity: null,
    })
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('nope') }) as never,
      registry,
    } as never)
    const res = await app.inject({ method: 'GET', url: `/api/runs/${row.id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { busy: boolean; lastError: string | null }
    expect(body.busy).toBe(true)
    expect(body.lastError).toBe('record error')
  })

  test('GET /api/runs/:id surfaces the record capacity and warnings', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const row = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
    registry.set({
      runId: row.id, spec: {} as never, engine: {} as never,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      composed: { cleanup: async () => {} } as never,
      bridges: [],
      warnings: ['1 worker model(s) unusable — agents assigned to them will fail and be culled:'],
      capacity: { committed: 2, maxContainers: 4 },
    })
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('nope') }) as never,
      registry,
    } as never)
    const res = await app.inject({ method: 'GET', url: `/api/runs/${row.id}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { warnings: string[]; capacity: { committed: number; maxContainers: number } | null }
    expect(body.warnings).toHaveLength(1)
    expect(body.capacity).toEqual({ committed: 2, maxContainers: 4 })
  })

  test('defaultSeams carries the real preflight functions, not no-ops', async () => {
    // validateModels now wraps validateRosterModels to thread onWarning through, so
    // identity is gone; prove it still delegates (a no-op wrapper would not warn).
    const warnings: string[] = []
    await expect(
      defaultSeams.validateModels(badWorkerClient(), '/workspace', probeConfig(), (m) => warnings.push(m)),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(typeof defaultSeams.readCapacity).toBe('function')
    expect(typeof defaultSeams.sweepFn).toBe('function')
  })

  test('a failing ensureImage stops the started host server', async () => {
    const stop = vi.fn(async () => {})
    const seams = {
      startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop })),
      attachHostServer: vi.fn(),
      ensureImageFn: vi.fn(async () => { throw new Error('no docker daemon') }), ...toolchainSeams(),
      readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
      sweepFn: vi.fn(async () => [] as string[]),
      validateModels: vi.fn(async () => {}),
      inspectPath: vi.fn(() => 'file' as const),
    }
    await expect(composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker',
      roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
    }), seams as never)).rejects.toThrow(/no docker daemon/)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('a second run\'s sweep spares every registered docker run, not just itself', async () => {
    // The exact derivation index.ts sweepWith performs: registered docker runs +
    // the new run's live id.
    const registry = new RunRegistry()
    registry.set({
      runId: 'run-a', spec: { sandbox: 'docker' } as never,
      engine: {} as never, manager: { disposeAll: vi.fn() } as never,
      composed: { config: { ...DEFAULT_CONFIG, sandbox: 'docker' } } as never,
      bridges: [], warnings: [], capacity: null,
    })
    const activeRunIds = [
      ...registry.list().filter((r) => r.composed.config.sandbox === 'docker').map((r) => r.runId),
      'run-b',
    ]
    expect(activeRunIds).toEqual(['run-a', 'run-b'])

    const calls: string[][] = []
    const run = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'ps') return { stdout: 'arena-run-a-0\narena-run-a-1\narena-dead-0\n', stderr: '', code: 0 }
      if (args[0] === 'rm') return { stdout: '', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const removed = await sweepOrphanContainers({ activeRunIds }, run)
    expect(removed).toEqual(['arena-dead-0'])
    expect(calls.filter((c) => c[0] === 'rm').map((c) => c[c.length - 1])).toEqual(['arena-dead-0'])
  })

  test('composeRun refuses when the probe is fatal even if the message names only workers', async () => {
    // "Every worker model is unusable" contains no "judge"/"reflect" — the old
    // regex misfiled this fatal as a warning and started a run with zero workers.
    const stop = vi.fn(async () => {})
    const seams = {
      startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop })),
      attachHostServer: vi.fn(),
      ensureImageFn: vi.fn(async () => {}), ...toolchainSeams(),
      readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
      sweepFn: vi.fn(async () => [] as string[]),
      validateModels: vi.fn(async () => {
        throw new Error('Model validation failed before the run started — no usable worker remains')
      }),
    }
    await expect(composeRun(parseRunSpec({
      name: 'w', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
      roster: [{ modelId: 'w/bad', count: 2, temperature: 0.7 }],
    }), seams as never)).rejects.toThrow(/no usable worker/i)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('a partially unusable worker roster composes, with the warning on the record', async () => {
    const warning = '1 worker model(s) unusable — agents assigned to them will fail and be culled'
    const seams = {
      startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
      attachHostServer: vi.fn(),
      ensureImageFn: vi.fn(async () => {}), ...toolchainSeams(),
      readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
      sweepFn: vi.fn(async () => [] as string[]),
      validateModels: vi.fn(async (_c: unknown, _d: unknown, _cfg: unknown, onWarning: (m: string) => void) => {
        onWarning(warning)
      }),
    }
    const c = await composeRun(parseRunSpec({
      name: 'w', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
      roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
    }), seams as never)
    expect(c.warnings).toEqual([warning])
    await c.cleanup()
  })

  test('PATCH takes effect from the next round: new judge runs, new caps bind', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const events: EngineEvent[] = []
    const emit = (e: EngineEvent) => events.push(e)

    // Spy provider: records (purpose, modelId) and delegates to a real MockProvider.
    const inner = new MockProvider(42)
    const calls: { purpose: string; modelId: string }[] = []
    const provider: Provider = {
      complete: async (req) => {
        calls.push({ purpose: req.purpose, modelId: req.modelId })
        return inner.complete(req)
      },
    }
    const sandbox = new MockSandbox()
    const composed: ComposedRun = {
      config: {
        ...DEFAULT_CONFIG,
        populationSize: 2,
        sandbox: 'mock',
        roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
      },
      sandbox,
      provider,
      runner: new MockAgentRunner(sandbox, 42),
      planFor: null,
      serverHandle: null,
      shardServers: [],
      sessionMap: new Map(),
      sessionHook: () => {},
      warnings: [],
      capacity: null,
      cleanup: async () => {},
    }
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('must not be called for specs') }) as never,
      registry,
      composeWith: (async () => composed) as never,
      emit,
    })

    const created = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: { name: 'p', goal: 'g', sandbox: 'mock', roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }] },
    })
    expect(created.statusCode).toBe(201)
    const runId = (JSON.parse(created.body) as { runId: string }).runId
    const record = registry.get(runId)!

    // Idle PATCH: a new judge model and a run-token cap one round will blow.
    const patched = await app.inject({
      method: 'PATCH', url: `/api/runs/${runId}/config`,
      payload: { judge: { modelId: 'wandb/new-judge' }, budget: { maxRunTokens: 500 } },
    })
    expect(patched.statusCode).toBe(200)

    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' },
    })
    expect(started.statusCode).toBe(202)
    await record.manager.waitForIdle(runId)

    // The PATCHed judge is the one that ran; the original never did.
    const judgeCalls = calls.filter((c) => c.purpose === 'judge' || c.purpose === 'criteria')
    expect(judgeCalls.length).toBeGreaterThan(0)
    expect(judgeCalls.every((c) => c.modelId === 'wandb/new-judge')).toBe(true)
    expect(calls.some((c) => c.modelId === DEFAULT_CONFIG.judge.modelId)).toBe(false)

    // The PATCHed cap is what the budget enforced: the round completed in breach.
    const done = events.find((e) => e.type === 'round.complete')
    expect(done).toBeDefined()
    expect('budgetBreach' in (done as object) && (done as { budgetBreach?: string | null }).budgetBreach)
      .toMatch(/run token/i)
  })

  test('DELETE /api/runs/:id disposes a registered run, marks it stopped, deregisters it', async () => {
    vi.clearAllMocks()
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const row = repos.runs.create({ name: 'r', config: DEFAULT_CONFIG, seedDir: null })
    const record = {
      runId: row.id, spec: {} as never, engine: {} as never,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {}, disposeAll: vi.fn(async () => {}) } as never,
      composed: { cleanup: vi.fn(async () => {}) } as never,
      bridges: [], warnings: [], capacity: null,
    }
    registry.set(record as never)
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('nope') }) as never,
      registry,
    } as never)
    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${row.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ stopped: true })
    expect(disposeRunRecord).toHaveBeenCalledTimes(1)
    expect(disposeRunRecord).toHaveBeenCalledWith(record)
    expect(registry.size).toBe(0)
    expect(repos.runs.get(row.id)!.status).toBe('stopped')
    // Stopped but still queryable: the snapshot is a db read and the run row remains.
    const snap = await app.inject({ method: 'GET', url: `/api/runs/${row.id}` })
    expect(snap.statusCode).toBe(200)
    // The stopped guards: no new rounds, no config patches.
    const post = await app.inject({ method: 'POST', url: `/api/runs/${row.id}/rounds`, payload: { goalMd: 'g' } })
    expect(post.statusCode).toBe(409)
    expect(JSON.parse(post.body)).toEqual({ error: 'run is stopped' })
    const patch = await app.inject({ method: 'PATCH', url: `/api/runs/${row.id}/config`, payload: {} })
    expect(patch.statusCode).toBe(409)
    expect(JSON.parse(patch.body)).toEqual({ error: 'run is stopped' })
    // Idempotent re-stop: timeout retries and double-clicks succeed without re-disposing.
    const again = await app.inject({ method: 'DELETE', url: `/api/runs/${row.id}` })
    expect(again.statusCode).toBe(200)
    expect(JSON.parse(again.body)).toEqual({ stopped: true })
    expect(disposeRunRecord).toHaveBeenCalledTimes(1)
  })

  test('DELETE /api/runs/:id 404s for a run with no db row', async () => {
    vi.clearAllMocks()
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('nope') }) as never,
      registry: new RunRegistry(),
    } as never)
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/nope' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'no such run' })
    expect(disposeRunRecord).not.toHaveBeenCalled()
  })

  test('DELETE refuses a legacy run (db row, no registry record) and leaves it untouched', async () => {
    vi.clearAllMocks()
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const row = repos.runs.create({ name: 'legacy', config: DEFAULT_CONFIG, seedDir: null })
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => { throw new Error('nope') }) as never,
      registry,
    } as never)
    const res = await app.inject({ method: 'DELETE', url: `/api/runs/${row.id}` })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'run is not stoppable (created outside the dashboard)' })
    expect(disposeRunRecord).not.toHaveBeenCalled()
    expect(repos.runs.get(row.id)!.status).toBe('active')
    const snap = await app.inject({ method: 'GET', url: `/api/runs/${row.id}` })
    expect(snap.statusCode).toBe(200)
  })
})

describe('container names carry the live run id', () => {
  /**
   * A sweep excludes live runs BY RUN ID, so the id inside a container name is the only
   * thing that makes a name ownership evidence. The CLI discarded its runIdHolder, so its
   * containers were called `arena-pending-<timestamp>-<shard>` and no other orchestrator
   * on the host could match them against a run it knows is alive — it would see them as
   * orphans and force-remove a paid, in-flight tournament.
   *
   * The mechanism is composeRun reading the holder at container START time, which is long
   * after createRun has filled it in. This asserts that contract from both sides.
   */
  const seams = (started: string[]) => ({
    startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
    attachHostServer: vi.fn(),
    ensureImageFn: vi.fn(async () => {}), ...toolchainSeams(),
    readCapacity: vi.fn(async () => ({
      totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1024 ** 3, cpus: 8,
    })),
    sweepFn: vi.fn(async () => [] as string[]),
    validateModels: vi.fn(async () => {}),
    inspectPath: vi.fn(() => 'file' as const),
    startShardContainerFn: vi.fn(async (spec: { runId: string; shardIndex: number }) => {
      started.push(`arena-${spec.runId}-${spec.shardIndex}`)
      return {
        name: `arena-${spec.runId}-${spec.shardIndex}`,
        baseUrl: 'http://127.0.0.1:1',
        shardIndex: spec.shardIndex,
      }
    }),
  })

  const dockerSpec = () => parseRunSpec({
    name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
    roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
  })

  test('a holder filled in after compose reaches the container name', async () => {
    const started: string[] = []
    const holder = { value: '' }
    const composed = await composeRun(dockerSpec(), seams(started) as never, { runIdHolder: holder })
    // Exactly what createRun does before the first round provisions anything.
    holder.value = 'run-live-42'
    await composed.planFor?.(['a1'])
    await composed.sandbox.provision('a1', {})
    expect(started).toEqual(['arena-run-live-42-0'])
    await composed.cleanup().catch(() => {})
  })

  test('without a holder the name falls back to a pending id', async () => {
    const started: string[] = []
    const composed = await composeRun(dockerSpec(), seams(started) as never)
    await composed.planFor?.(['a1'])
    await composed.sandbox.provision('a1', {})
    expect(started[0]).toMatch(/^arena-pending-\d+-0$/)
    await composed.cleanup().catch(() => {})
  })

  test('the CLI passes its holder through instead of discarding it', () => {
    // buildRealDeps is not exported and the hooks do not reach the container seam, so the
    // wiring itself is what is checked. A discarded holder is invisible to every other
    // test in this file, which is exactly how it survived.
    const source = readFileSync('src/cli.ts', 'utf8')
    expect(source).toMatch(/\{\s*runIdHolder,/)
    expect(source).not.toMatch(/void runIdHolder/)
  })
})
