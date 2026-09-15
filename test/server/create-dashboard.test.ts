import { WebSocket } from 'ws'
import { describe, expect, test, vi } from 'vitest'
import { createDashboard } from '../../src/server/create-dashboard.js'

describe('createDashboard initial goals', () => {
  test.each([
    ['legacy', { name: 'legacy goal', goal: 'keep this exact legacy goal' }],
    ['full-spec', {
      name: 'spec goal', goal: 'keep this exact spec goal', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }],
  ])('POST then GET returns the supplied %s initial goal before a round', async (_kind, payload) => {
    const dashboard = createDashboard({ population: 2 })
    try {
      const created = await dashboard.app.inject({ method: 'POST', url: '/api/runs', payload })
      expect(created.statusCode).toBe(201)
      const { runId }: { runId: string } = JSON.parse(created.body)

      const snapshot = await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}` })
      expect(snapshot.statusCode).toBe(200)
      expect(JSON.parse(snapshot.body).goalMd).toBe(payload.goal)
    } finally {
      await dashboard.shutdown()
    }
  })
})

describe('createDashboard round audit', () => {
  test('a finished round has a frozen audit on its endpoint, and the export carries the same record', async () => {
    const dashboard = createDashboard({ population: 2 })
    try {
      const created = await dashboard.app.inject({
        method: 'POST', url: '/api/runs',
        payload: { name: 'audit', goal: 'g', sandbox: 'mock', roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }] },
      })
      const { runId }: { runId: string } = JSON.parse(created.body)
      expect((await dashboard.app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' } })).statusCode).toBe(202)
      await vi.waitFor(async () => {
        const snap = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body)
        expect(snap.busy).toBe(false)
      }, { timeout: 10_000 })

      const audit = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/1/audit` })).body)
      expect(audit.status).toBe('recorded')
      expect(audit.digestMatches).toBe(true)
      expect(Object.keys(audit.frozen.agents)).toHaveLength(2)
      expect(audit.frozen.provenance).toEqual({ sandbox: 'mock', isolation: null, toolchainId: null })

      const dump = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=json` })).body)
      expect(dump.rounds[0].audit).toEqual(audit)
      expect((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/9/audit` })).statusCode).toBe(404)

      // The grading record: which evaluator ran, on which rubric and evidence, with every call.
      const judging = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/1/judging` })).body)
      expect(judging.judging).toMatchObject({
        kind: 'original',
        evaluator: { modelId: expect.any(String), runtime: 'mock' },
        evidence: { status: 'recorded', digest: audit.frozen.digest },
        rubric: { source: 'generated', digest: expect.stringMatching(/^sha256:/) },
      })
      expect(judging.judging.calls.map((c: { stage: string }) => c.stage)).toEqual(['criteria', 'single'])
      expect(Object.keys(judging.judging.agents)).toHaveLength(2)
      expect(judging.audit.frozen.digest).toBe(audit.frozen.digest)
      expect(dump.rounds[0].judging).toEqual([judging.judging])

      // A rejudge is a labelled preview: it never replaces the stored record.
      const preview = JSON.parse((await dashboard.app.inject({
        method: 'POST', url: `/api/runs/${runId}/rounds/1/rejudge`, payload: { judgeModelId: 'mock/model' },
      })).body)
      expect(preview.preview).toMatchObject({ kind: 'rejudge_preview', evidence: { status: 'recorded', digest: audit.frozen.digest } })
      const after = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/1/judging` })).body)
      expect(after.judging).toEqual(judging.judging)
    } finally {
      await dashboard.shutdown()
    }
  })
})

describe('createDashboard shutdown', () => {
  test('releases the database so nothing can be written afterwards', async () => {
    // A shutdown that leaves the handle open keeps a file lock (and, on a real path,
    // the WAL) alive for as long as the process runs.
    const dashboard = createDashboard({ population: 2 })
    await dashboard.shutdown()
    expect(() => dashboard.repos.runs.list()).toThrow()
  })

  test('shutdown is safe to call twice', async () => {
    const dashboard = createDashboard({ population: 2 })
    await dashboard.shutdown()
    await expect(dashboard.shutdown()).resolves.toBeUndefined()
  })

  test('closes websocket clients instead of leaving the process held open', async () => {
    const dashboard = createDashboard({ population: 2 })
    dashboard.attachWebSocket()
    await dashboard.app.listen({ port: 0, host: '127.0.0.1' })
    const address = dashboard.app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((resolve, reject) => {
      socket.on('open', resolve)
      socket.on('error', reject)
    })
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))

    // An upgraded connection is not the HTTP server's to close: app.close() returns
    // while the socket is still open, and Node will not exit with it held.
    await dashboard.shutdown()
    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  }, 20_000)
})
