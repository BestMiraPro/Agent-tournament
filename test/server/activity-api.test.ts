import { afterEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { ActivityCache } from '../../src/server/activity.js'
import { buildApi } from '../../src/server/api.js'
import { RunRegistry, disposeRunRecord } from '../../src/server/runs.js'

afterEach(() => vi.unstubAllGlobals())

const sse = (frames: unknown[]) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`))
    },
  })
}

const toolFrame = {
  directory: '/w/agent-1',
  payload: {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_1',
      part: { id: 'prt_1', sessionID: 'ses_1', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'node backtest.mjs' } } },
    },
  },
}

function localApi(emitted: EngineEvent[], registry: RunRegistry) {
  const repos = makeRepos(openDb(':memory:'))
  const app = buildApi({
    repos,
    manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
    createRun: (() => { throw new Error('must not be called for specs') }) as never,
    registry,
    emit: (e: EngineEvent) => emitted.push(e),
    composeWith: (async () => ({
      config: { ...DEFAULT_CONFIG, populationSize: 1, sandbox: 'local', roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }] },
      sandbox: {}, provider: {}, runner: {}, planFor: null,
      serverHandle: { baseUrl: 'http://127.0.0.1:4096' }, shardServers: [],
      sessionMap: new Map([['ses_1', 'agent-1']]), sessionHook: () => {}, warnings: [],
      capacity: null, cleanup: async () => {},
    })) as never,
  } as never)
  return { app, repos }
}

describe('live activity in the run snapshot', () => {
  test('bridge activity is cached before it is broadcast, and the snapshot restores it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: sse([toolFrame]) })))
    const emitted: EngineEvent[] = []
    const registry = new RunRegistry()
    const { app } = localApi(emitted, registry)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: { name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w', roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }] },
    })
    const { runId } = JSON.parse(res.body) as { runId: string }
    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'agent.activity')).toBe(true))

    const broadcast = emitted.find((e) => e.type === 'agent.activity') as Extract<EngineEvent, { type: 'agent.activity' }>
    expect(broadcast.item).toMatchObject({ id: 'call_1', runId, agentId: 'agent-1', status: 'running' })
    expect(broadcast.item!.revision).toBeGreaterThan(0)
    expect(emitted.some((e) => e.type === 'bridge.status' && e.state === 'connected')).toBe(true)

    const snap = JSON.parse((await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body)
    expect(snap.activity.agents['agent-1'].items[0]).toMatchObject({ id: 'call_1', summary: 'bash: node backtest.mjs' })
    expect(snap.activity.streams.server.state).toBe('connected')
    await disposeRunRecord(registry.get(runId)!)
  })

  test('a lost upstream stream is reported as telemetry, not as an agent failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, body: sse([]) })))
    const emitted: EngineEvent[] = []
    const registry = new RunRegistry()
    const { app } = localApi(emitted, registry)
    const res = await app.inject({
      method: 'POST', url: '/api/runs',
      payload: { name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w', roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }] },
    })
    const { runId } = JSON.parse(res.body) as { runId: string }
    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'bridge.status' && e.state === 'reconnecting')).toBe(true))
    expect(emitted.some((e) => e.type === 'agent.status')).toBe(false)
    const snap = JSON.parse((await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body)
    expect(snap.activity.streams.server).toMatchObject({ state: 'reconnecting' })
    await disposeRunRecord(registry.get(runId)!)
  })

  test('a run the server no longer holds says its transient activity is unavailable', async () => {
    const repos = makeRepos(openDb(':memory:'))
    const run = repos.runs.create({ name: 'old', config: DEFAULT_CONFIG, seedDir: null })
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: (() => '') as never,
      registry: new RunRegistry(),
    } as never)
    const snap = JSON.parse((await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).body)
    expect(snap.activity).toBeNull()
  })

  test('a registered record serves its own cache', async () => {
    const repos = makeRepos(openDb(':memory:'))
    const run = repos.runs.create({ name: 'live', config: DEFAULT_CONFIG, seedDir: null })
    const activity = new ActivityCache()
    activity.record({ type: 'agent.activity', runId: run.id, agentId: 'a', kind: 'tool', detail: 'x', item: { id: 'call_9', sessionId: 's', kind: 'tool', summary: 'bash: ls', observedAt: 1 } })
    const registry = new RunRegistry()
    registry.set({
      runId: run.id, spec: {} as never, engine: {} as never,
      manager: { isBusy: () => true, lastError: () => null, disposeAll: async () => {} } as never,
      composed: { cleanup: async () => {} } as never, bridges: [], warnings: [], capacity: null, activity,
    })
    const app = buildApi({
      repos, manager: { isBusy: () => false, lastError: () => null } as never, createRun: (() => '') as never, registry,
    } as never)
    const snap = JSON.parse((await app.inject({ method: 'GET', url: `/api/runs/${run.id}` })).body)
    expect(snap.activity.agents.a.items[0].id).toBe('call_9')
  })
})
