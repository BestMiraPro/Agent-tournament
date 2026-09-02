import Fastify, { type FastifyInstance } from 'fastify'
import type { Repos } from '../db/repos.js'
import type { RunManager } from './run-manager.js'
import { buildRunSnapshot } from './state.js'

export interface ApiDeps {
  repos: Repos
  manager: RunManager
  createRun: (name: string, goal: string) => string
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.post('/api/runs', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; goal?: string }
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

  return app
}
