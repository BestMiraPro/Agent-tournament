import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry, disposeRunRecord } from '../../src/server/runs.js'
import { composeRun } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

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
    const mk = (shardServers: { baseUrl: string; directory: string }[], sandbox: string) => {
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
      [{ baseUrl: 'http://127.0.0.1:1', directory: '/tmp/a' }, { baseUrl: 'http://127.0.0.1:2', directory: '/tmp/b' }],
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
    expect(bad.statusCode).toBe(400)
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

  test('disposeRunRecord stops bridges, then cleanup, then disposeAll', async () => {
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
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]!)
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(disposeAll.mock.invocationCallOrder[0]!)
  })

  test('a docker sweep runs with the live id on the server path, pending id on the CLI path', async () => {
    const seams = () => ({
      startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
      attachHostServer: vi.fn(),
      ensureImageFn: vi.fn(async () => {}),
      readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
      sweepFn: vi.fn(async () => [] as string[]),
      validateModels: vi.fn(async () => {}),
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
    const calls = cliSeams.sweepFn.mock.calls as unknown as { activeRunId: string }[][]
    expect(calls[0]?.[0]?.activeRunId).toMatch(/^pending-/)
  })
})
