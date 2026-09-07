import { describe, expect, test } from 'vitest'
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
