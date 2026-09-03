import { describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import type { EngineEvent } from '../../src/engine/events.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockAgentRunner } from '../../src/runtime/agent-runner.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import { buildApi } from '../../src/server/api.js'
import { RunManager } from '../../src/server/run-manager.js'
import { EventBroadcaster } from '../../src/server/ws.js'

describe('dashboard end to end', () => {
  test('a browser client sees a round play out over the websocket', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const population = 4
    const config: RunConfig = {
      ...DEFAULT_CONFIG,
      populationSize: population,
      sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
    }

    const broadcaster = new EventBroadcaster()
    const emit = (e: EngineEvent) => broadcaster.broadcast(e)
    const provider = new MockProvider(42)
    const sandbox = new MockSandbox()
    const engine = new TournamentEngine({
      repos, config, sandbox,
      runner: new MockAgentRunner(sandbox, 42),
      judge: new Judge(provider, config.judge, 42),
      reflector: new Reflector(provider, config.reflect, ['mock/model']),
      seedStrategy: (i) => `attempt the goal, variant ${i}`,
      onEvent: emit,
    })
    const manager = new RunManager(engine, emit)
    const app = buildApi({ repos, manager, createRun: (name) => engine.createRun(name, '').id })

    const wss = new WebSocketServer({ server: app.server, path: '/ws' })
    broadcaster.attach(wss)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const received: EngineEvent[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((r) => socket.on('open', r))
    socket.on('message', (raw) => received.push(JSON.parse(String(raw))))

    const created = await app.inject({
      method: 'POST', url: '/api/runs', payload: { name: 'e2e', goal: 'g' },
    })
    const { runId } = JSON.parse(created.body)

    const started = await app.inject({
      method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a good answer' },
    })
    expect(started.statusCode).toBe(202)

    await manager.waitForIdle(runId)
    await new Promise((r) => setTimeout(r, 200))

    const snapshot = await app.inject({ method: 'GET', url: `/api/runs/${runId}` })

    socket.close()
    await app.close()

    const types = new Set(received.map((e) => e.type))
    expect(types.has('round.status')).toBe(true)
    expect(types.has('agent.status')).toBe(true)
    expect(types.has('round.scored')).toBe(true)
    expect(types.has('round.complete')).toBe(true)

    const scored = received.find((e) => e.type === 'round.scored')
    expect(scored && 'scores' in scored ? scored.scores : []).toHaveLength(population)

    expect(JSON.parse(snapshot.body).lastRoundIdx).toBe(1)
  }, 60_000)
})
