import { describe, expect, test } from 'vitest'
import { createDashboard } from '../../src/server/create-dashboard.js'

const roster = [{ modelId: 'mock/model', count: 3, temperature: 0.7 }]

async function teamRun(rounds = 1) {
  const dashboard = createDashboard({ population: 2 })
  const created = await dashboard.app.inject({
    method: 'POST', url: '/api/runs',
    payload: { name: 'team', goal: 'write a study', sandbox: 'mock', workflow: 'collaboration', roster },
  })
  expect(created.statusCode).toBe(201)
  const { runId } = JSON.parse(created.body) as { runId: string }
  for (let i = 0; i < rounds; i++) {
    const started = await dashboard.app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a study' } })
    expect(started.statusCode).toBe(202)
    await dashboard.registry.get(runId)!.manager.waitForIdle(runId)
  }
  const get = async (url: string) => {
    const res = await dashboard.app.inject({ method: 'GET', url })
    return { status: res.statusCode, body: JSON.parse(res.body) }
  }
  return { dashboard, runId, get }
}

describe('collaboration through the API', () => {
  test('the snapshot names the workflow and the round detail and stats carry the team score', async () => {
    const { dashboard, runId, get } = await teamRun()
    try {
      const snap = await get(`/api/runs/${runId}`)
      expect(snap.body.workflow).toBe('collaboration')
      expect(snap.body.lastError).toBeNull()
      const detail = await get(`/api/runs/${runId}/rounds/1`)
      expect(detail.body.team).toMatchObject({ status: 'ok' })
      expect(detail.body.team.score).toBeGreaterThan(0)
      expect(detail.body.entries.every((e: { score: number }) => e.score === detail.body.team.score)).toBe(true)
      const stats = await get(`/api/runs/${runId}/rounds`)
      expect(stats.body[0].team).toEqual({ score: detail.body.team.score, status: 'ok' })
    } finally {
      await dashboard.shutdown()
    }
  })

  test('the sealed output can be listed and each file opened; the channel is readable per round', async () => {
    const { dashboard, runId, get } = await teamRun()
    try {
      const output = await get(`/api/runs/${runId}/rounds/1/output`)
      expect(output.status).toBe(200)
      expect(output.body).toMatchObject({ status: 'ok', sealed: true })
      expect(output.body.files.map((f: { path: string }) => f.path)).toContain('output/README.md')
      expect(output.body.channelMd).toBeUndefined()
      expect(Object.values(output.body.contributions as Record<string, { label: string }>).map((c) => c.label).sort())
        .toEqual(['agent-01', 'agent-02', 'agent-03'])
      const readme = await get(`/api/runs/${runId}/rounds/1/output/file?path=${encodeURIComponent('output/README.md')}`)
      expect(readme.body).toMatchObject({ path: 'output/README.md', stored: true, binary: false })
      expect(readme.body.content).toContain('# Team output')
      expect((await get(`/api/runs/${runId}/rounds/1/output/file?path=GOAL.md`)).status).toBe(404)
      expect((await get(`/api/runs/${runId}/rounds/1/output/file`)).status).toBe(400)
      const channel = await get(`/api/runs/${runId}/rounds/1/channel`)
      expect(channel.body.messages.length).toBeGreaterThanOrEqual(6)
      expect(channel.body.messages[0]).toMatchObject({ seq: 1 })
    } finally {
      await dashboard.shutdown()
    }
  })

  test('the JSON export carries each round\'s team: score, output manifest and channel', async () => {
    const { dashboard, runId, get } = await teamRun()
    try {
      const dump = await get(`/api/runs/${runId}/export?format=json`)
      const team = dump.body.rounds[0].team
      expect(team.score).toMatchObject({ status: 'ok' })
      expect(team.output.files.length).toBe(4)
      expect(team.output.digest).toMatch(/^sha256:/)
      expect(team.channel.length).toBeGreaterThanOrEqual(6)
      expect(dump.body.config.workflow).toBe('collaboration')
    } finally {
      await dashboard.shutdown()
    }
  })

  test('the markdown report gives the team result and its folder, not a winner', async () => {
    const { dashboard, runId } = await teamRun()
    try {
      const res = await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/export?format=md` })
      expect(res.body).toMatch(/## Team result \(round 1, score [\d.]+\)/)
      expect(res.body).toContain('- output/README.md (')
      expect(res.body).toContain('### output/README.md\n\n# Team output')
      expect(res.body).toContain('#### agent-03')
      expect(res.body).not.toContain('## Winner')
    } finally {
      await dashboard.shutdown()
    }
  })

  test('a rejudge regrades the sealed artifact without storing anything', async () => {
    const { dashboard, runId } = await teamRun()
    try {
      const before = dashboard.repos.teamScores.forRound(dashboard.repos.rounds.listForRun(runId)[0]!.id)
      const res = await dashboard.app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds/1/rejudge`, payload: { judgeModelId: 'mock/other' } })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { entries: { newScore: number; newRank: number; label: string }[]; preview: { kind: string; agents: Record<string, unknown> } }
      expect(body.entries.map((e) => e.label)).toEqual(['agent-01', 'agent-02', 'agent-03'])
      expect(new Set(body.entries.map((e) => e.newScore)).size).toBe(1)
      expect(body.entries.every((e) => e.newRank === 1)).toBe(true)
      expect(body.preview.kind).toBe('rejudge_preview')
      expect(Object.keys(body.preview.agents)).toHaveLength(3)
      expect(dashboard.repos.teamScores.forRound(dashboard.repos.rounds.listForRun(runId)[0]!.id)).toEqual(before)
    } finally {
      await dashboard.shutdown()
    }
  })

  test('agents added between rounds are teammates, and the team keeps growing in its folder', async () => {
    const { dashboard, runId, get } = await teamRun()
    try {
      const add = await dashboard.app.inject({
        method: 'POST', url: `/api/runs/${runId}/agents`,
        payload: { modelId: 'mock/model', temperature: 0.7, strategy: { mode: 'blank' } },
      })
      expect(add.statusCode).toBe(201)
      expect(JSON.parse(add.body).label).toMatch(/^agent-r2-manual-/)
      await dashboard.app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'write a study' } })
      await dashboard.registry.get(runId)!.manager.waitForIdle(runId)
      const output = await get(`/api/runs/${runId}/rounds/2/output`)
      expect(Object.keys(output.body.contributions)).toHaveLength(4)
    } finally {
      await dashboard.shutdown()
    }
  })

  test('a tournament round has no team output', async () => {
    const dashboard = createDashboard({ population: 2 })
    try {
      const created = await dashboard.app.inject({
        method: 'POST', url: '/api/runs', payload: { name: 't', goal: 'g', sandbox: 'mock', workflow: 'tournament', roster },
      })
      const { runId } = JSON.parse(created.body) as { runId: string }
      await dashboard.app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' } })
      await dashboard.registry.get(runId)!.manager.waitForIdle(runId)
      const res = await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/1/output` })
      expect(res.statusCode).toBe(404)
      const detail = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}/rounds/1` })).body)
      expect(detail.team).toBeNull()
      const snap = JSON.parse((await dashboard.app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body)
      expect(snap.workflow).toBe('tournament')
    } finally {
      await dashboard.shutdown()
    }
  })
})
