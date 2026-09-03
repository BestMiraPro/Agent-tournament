import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Repos } from '../db/repos.js'
import type { RunManager } from './run-manager.js'
import type { ComposedRun } from './compose-run.js'
import type { RunRegistry } from './runs.js'
import { parseRunSpec, type RunSpec } from './run-spec.js'
import { buildRunSnapshot } from './state.js'

export interface ApiDeps {
  repos: Repos
  manager: RunManager
  createRun: (name: string, goal: string) => string
  composeRun?: (spec: RunSpec) => Promise<ComposedRun>
  composeWith?: (spec: RunSpec) => Promise<ComposedRun>
  registry?: RunRegistry
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.post('/api/runs', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; goal?: string; sandbox?: unknown; roster?: unknown }
    if (body.sandbox !== undefined || body.roster !== undefined) {
      let spec: RunSpec
      try {
        spec = parseRunSpec(body)
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
      const compose = deps.composeWith ?? deps.composeRun
      if (!compose) {
        return reply.code(400).send({ error: 'real modes unavailable' })
      }
      const composed = await compose(spec)
      const row = deps.repos.runs.create({ name: spec.name, config: composed.config, seedDir: spec.seedDir })
      return reply.code(201).send({ runId: row.id })
    }
    if (!body.name || !body.goal) {
      return reply.code(400).send({ error: 'name and goal are required' })
    }
    const runId = deps.createRun(body.name, body.goal)
    return reply.code(201).send({ runId })
  })

  app.get('/api/runs', async () => ({
    runs: deps.repos.runs.list?.() ?? [],
  }))

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const snapshot = buildRunSnapshot(deps.repos, id)
    if (!snapshot) return reply.code(404).send({ error: 'no such run' })
    return {
      ...snapshot,
      busy: deps.manager.isBusy(id),
      lastError: deps.manager.lastError(id),
    }
  })

  app.post('/api/runs/:id/rounds', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { goalMd?: string; criteriaMd?: string | null }
    if (!deps.repos.runs.get(id)) return reply.code(404).send({ error: 'no such run' })
    if (!body.goalMd) return reply.code(400).send({ error: 'goalMd is required' })
    try {
      deps.manager.startRound(id, { goalMd: body.goalMd, criteriaMd: body.criteriaMd ?? null })
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) })
    }
    return reply.code(202).send({ started: true })
  })

  app.patch('/api/runs/:id/config', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = deps.repos.runs.get(id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    if (deps.manager.isBusy(id)) return reply.code(409).send({ error: 'run is busy' })
    const patchSchema = z.object({
      roster: z.array(z.object({
        modelId: z.string().min(1),
        count: z.number().int().min(1),
        temperature: z.number().min(0).max(2),
      })).min(1).optional(),
      budget: z.object({
        maxRunTokens: z.number().int().positive(),
        maxRoundTokens: z.number().int().positive(),
        maxAgentTokens: z.number().int().positive(),
      }).partial().optional(),
      judge: z.object({
        modelId: z.string().min(1),
        mode: z.enum(['auto', 'single_call', 'batched_finals']),
      }).partial().optional(),
    })
    let patch: z.infer<typeof patchSchema>
    try {
      patch = patchSchema.parse(req.body ?? {})
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
    if (patch.roster) {
      const total = patch.roster.reduce((n, r) => n + r.count, 0)
      if (total !== run.config.populationSize) {
        return reply.code(400).send({
          error: `roster counts sum to ${total} but populationSize is ${run.config.populationSize}`,
        })
      }
    }
    const next = {
      ...run.config,
      roster: patch.roster ?? run.config.roster,
      budget: { ...run.config.budget, ...patch.budget },
      judge: { ...run.config.judge, ...patch.judge },
    }
    deps.repos.runs.updateConfig(id, next)
    const record = deps.registry?.get(id)
    if (record) {
      if (patch.roster) record.spec.roster = patch.roster
      if (patch.budget) record.spec.budget = { ...record.spec.budget, ...patch.budget }
      if (patch.judge) record.spec.judge = { ...record.spec.judge, ...patch.judge }
    }
    return { warnings: record?.warnings ?? [] }
  })

  return app
}
