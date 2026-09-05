import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import type { EngineEvent } from '../../src/engine/events.js'
import { createDashboard } from '../../src/server/create-dashboard.js'

/**
 * The dashboard's real-sandbox path, driven the way a browser drives it: create a run
 * over HTTP, start a round over HTTP, watch it over the websocket, read the result back
 * from the snapshot.
 *
 * Gated because it starts a real opencode server and spends money. It exists because
 * every other real-mode guarantee in this project is exercised through the CLI, while
 * the dashboard reaches the same engine through its own composition root — which is
 * exactly where this project shipped divergence before: the servers kept a keyword-free
 * seed strategy long after the CLI was fixed, so the dashboard's mean fitness was
 * exactly flat while the CLI climbed, and nothing failed.
 *
 * It builds the real `createDashboard` graph rather than wiring an engine by hand,
 * because a test with its own wiring cannot catch that class of drift.
 *
 *   ARENA_DASHBOARD_E2E=1 npx vitest run test/e2e/dashboard-real.test.ts
 */
const ENABLED = process.env.ARENA_DASHBOARD_E2E === '1'
const d = describe.skipIf(!ENABLED)

const WORKER = process.env.ARENA_E2E_WORKER ?? 'wandb/deepseek-ai/DeepSeek-V4-Flash'
const JUDGE = process.env.ARENA_E2E_JUDGE ?? 'wandb/zai-org/GLM-5.2'
const REFLECT = process.env.ARENA_E2E_REFLECT ?? 'wandb/deepseek-ai/DeepSeek-V4-Flash'
const GOAL = 'Write a single clear sentence defining what a tournament is.'

let workspace = ''
afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

d('dashboard real mode (ARENA_DASHBOARD_E2E=1)', () => {
  test('creates a run, runs a round with real agents, and streams it to a client', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'arena-dash-e2e-'))
    const dashboard = createDashboard({ population: 2, workspaceRoot: workspace })
    dashboard.attachWebSocket()
    await dashboard.app.listen({ port: 0, host: '127.0.0.1' })

    const address = dashboard.app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const received: EngineEvent[] = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((r) => socket.on('open', r))
    socket.on('message', (raw) => {
      try {
        received.push(JSON.parse(String(raw)) as EngineEvent)
      } catch {
        /* ignore malformed frames */
      }
    })

    try {
      const created = await dashboard.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: {
          name: 'dashboard-e2e',
          goal: GOAL,
          sandbox: 'local',
          roster: [{ modelId: WORKER, count: 2, temperature: 0.7 }],
          judge: { modelId: JUDGE, mode: 'auto' },
          reflect: { modelId: REFLECT },
          workspaceRoot: workspace,
          authFile: null,
          criteria: 'clarity, accuracy, concision',
          selection: { eliteCount: 1, topPct: 0.5, bottomPct: 0, crossoverPct: 0 },
          concurrency: 2,
          pricing: {},
        },
      })
      expect(created.statusCode).toBe(201)
      const { runId } = JSON.parse(created.body) as { runId: string }

      const started = await dashboard.app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/rounds`,
        payload: { goalMd: GOAL },
      })
      expect(started.statusCode).toBe(202)

      // Poll the snapshot the way the browser does, rather than reaching into the engine.
      const deadline = Date.now() + 900_000
      let snapshot: { busy: boolean; lastRoundIdx: number; scores: { score: number }[] } | null = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const res = await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}` })
        snapshot = JSON.parse(res.body)
        if (snapshot && !snapshot.busy && snapshot.lastRoundIdx >= 1) break
      }

      expect(snapshot).not.toBeNull()
      expect(snapshot!.lastRoundIdx).toBe(1)
      // A flat zero means the agents never produced anything — the exact failure the
      // dashboard silently shipped before.
      expect(Math.max(...snapshot!.scores.map((s) => s.score))).toBeGreaterThan(0)

      const types = new Set(received.map((e) => e.type))
      expect(types.has('round.status')).toBe(true)
      expect(types.has('agent.status')).toBe(true)
      expect(types.has('round.scored')).toBe(true)
    } finally {
      socket.close()
      await dashboard.shutdown().catch(() => {})
    }
  }, 1_200_000)
})
