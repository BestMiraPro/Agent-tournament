import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { buildApi, collectRunUsage, specForResume } from '../../src/server/api.js'
import { createDashboard } from '../../src/server/create-dashboard.js'
import { RunRegistry } from '../../src/server/runs.js'
import { makeMockEngine } from '../helpers/mock-engine.js'

describe('specForResume', () => {
  test('round-trips the stored config and takes workspace paths from server defaults', () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const run = repos.runs.create({
      name: 'r',
      config: {
        ...DEFAULT_CONFIG,
        sandbox: 'local',
        populationSize: 3,
        roster: [{ modelId: 'w/m', count: 3, temperature: 0.5 }],
      },
      seedDir: null,
    })
    const spec = specForResume(repos.runs.get(run.id)!, {
      workspaceRoot: '/tmp/w',
      authFile: null,
      serverUrl: null,
    })
    expect(spec.sandbox).toBe('local')
    expect(spec.roster).toEqual([{ modelId: 'w/m', count: 3, temperature: 0.5 }])
    expect(spec.population).toBe(3)
    expect(spec.workspaceRoot).toBe('/tmp/w')
  })
})

describe('budget recovery', () => {
  test('replaying stored submissions restores cumulative run tokens', async () => {
    const { repos, engine } = makeMockEngine({ seed: 1, populationSize: 2 })
    const run = engine.createRun('r', 'g')
    await engine.runRound(run.id, { goalMd: 'g', criteriaMd: null })
    const usages = collectRunUsage(repos, run.id)
    expect(usages.length).toBe(2)
    expect(usages.reduce((n, u) => n + u.tokensIn + u.tokensOut, 0)).toBeGreaterThan(0)

    // Same config, fresh tracker: attach the recorded spend.
    const { engine: engine2 } = makeMockEngine({ seed: 1, populationSize: 2 })
    engine2.attachExistingRun(run.id, usages)
    const status = engine2.budgetStatus(run.id)
    expect(status).not.toBeNull()
    expect(status!.runTokens).toBe(usages.reduce((n, u) => n + u.tokensIn + u.tokensOut + u.tokensCacheRead + u.tokensCacheWrite, 0))
  })
})

describe('resuming a run after a restart', () => {
  test('a mock spec run continues on the next round instead of refusing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-'))
    const dbPath = join(dir, 'dashboard.db')
    try {
      const first = createDashboard({ population: 2, dbPath })
      let runId: string
      try {
        const created = await first.app.inject({
          method: 'POST', url: '/api/runs',
          payload: {
            name: 'resume me', goal: 'g', sandbox: 'mock',
            roster: [{ modelId: 'mock/model', count: 3, temperature: 0.7 }],
          },
        })
        expect(created.statusCode).toBe(201)
        runId = (JSON.parse(created.body) as { runId: string }).runId
        expect(await first.app.inject({ method: 'POST', url: `/api/runs/${runId}/rounds`, payload: { goalMd: 'g' } })).toMatchObject({ statusCode: 202 })
        await vi.waitFor(async () => {
          const snap = JSON.parse((await first.app.inject({ method: 'GET', url: `/api/runs/${runId}` })).body)
          expect(snap.busy).toBe(false)
        }, { timeout: 10_000 })
        expect(first.repos.rounds.listForRun(runId)).toHaveLength(1)
      } finally {
        await first.shutdown()
      }

      const second = createDashboard({ population: 2, dbPath })
      try {
        const snap = JSON.parse((await second.app.inject({ method: 'GET', url: `/api/runs/${runId!}` })).body)
        expect(snap.lastRoundIdx).toBe(1)
        expect(snap.agents).toHaveLength(3)

        const resumed = await second.app.inject({ method: 'POST', url: `/api/runs/${runId!}/rounds`, payload: { goalMd: 'g2' } })
        expect(resumed.statusCode).toBe(202)
        await vi.waitFor(async () => {
          const s = JSON.parse((await second.app.inject({ method: 'GET', url: `/api/runs/${runId!}` })).body)
          expect(s.busy).toBe(false)
        }, { timeout: 10_000 })
        const rounds = second.repos.rounds.listForRun(runId!)
        expect(rounds).toHaveLength(2)
        expect(rounds[1]!.status).toBe('complete')
        expect(rounds[1]!.goalMd).toBe('g2')
      } finally {
        await second.shutdown()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a persisted local run without a workspace root fails fast with no round written', async () => {
    const db = openDb(':memory:')
    const repos = makeRepos(db)
    const registry = new RunRegistry()
    const run = repos.runs.create({
      name: 'local run',
      config: { ...DEFAULT_CONFIG, sandbox: 'local' },
      seedDir: null,
    })
    const app = buildApi({
      repos,
      manager: { isBusy: () => false, lastError: () => null, startRound: () => {} } as never,
      createRun: () => run.id,
      registry,
      composeWith: (async () => { throw new Error('must not compose without a workspace root') }) as never,
      specDefaults: { workspaceRoot: null, authFile: null, serverUrl: null },
    } as never)
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/rounds`, payload: { goalMd: 'g' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/workspaceRoot/i)
    expect(repos.rounds.listForRun(run.id)).toHaveLength(0)
  })
})
