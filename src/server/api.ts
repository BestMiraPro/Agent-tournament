import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RunConfig } from '../core/types.js'
import type { Repos } from '../db/repos.js'
import { TournamentEngine } from '../engine/driver.js'
import type { EventSink } from '../engine/events.js'
import { Reflector } from '../evolution/reflect.js'
import { Judge } from '../judge/judge.js'
import { runConfigFor, type ComposedRun, type RunIdHolder } from './compose-run.js'
import { startEventBridge } from './event-bridge.js'
import type { RunRecord, RunRegistry } from './runs.js'
import { parseRunSpec, type RunSpec } from './run-spec.js'
import { buildRunSnapshot } from './state.js'
import { RunManager } from './run-manager.js'

export interface ApiDeps {
  repos: Repos
  manager: RunManager
  createRun: (name: string, goal: string) => string
  composeRun?: (spec: RunSpec, opts?: { runIdHolder?: RunIdHolder }) => Promise<ComposedRun>
  composeWith?: (spec: RunSpec, opts?: { runIdHolder?: RunIdHolder }) => Promise<ComposedRun>
  registry?: RunRegistry
  emit?: EventSink
  sweepWith?: (config: RunConfig, runId: string, onWarning: (message: string) => void) => Promise<string[]>
}

/** Compose/create failures are client or contention problems, never 500s. */
function specErrorCode(e: unknown): 400 | 409 {
  const message = e instanceof Error ? e.message : String(e)
  // `docker sandbox: ` is thrown only by the capacity preflight (assertHostCapacity);
  // spec section 3 maps capacity refusals to 409, not validation's 400.
  return /EADDRINUSE|already in use|already running|conflict|busy|docker sandbox: /i.test(message)
    ? 409
    : 400
}

function specErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
      // Mutable carrier for the live run id (mirrors cli.ts): compose runs
      // before the run row exists, containers start during the first round and
      // read it live, and the orphan sweep below runs with it — so a
      // pending-timestamp id never reaches a sweep exclusion or container name.
      const holder: RunIdHolder = { value: '' }
      let composed: ComposedRun
      try {
        composed = await compose(spec, { runIdHolder: holder })
      } catch (e) {
        return reply.code(specErrorCode(e)).send({ error: specErrorMessage(e) })
      }
      const emit: EventSink = deps.emit ?? (() => {})
      // Engine construction mirrors src/server/index.ts: composed pieces in
      // place of the mock literals, Judge/Reflector over the composed provider.
      const engine = new TournamentEngine({
        repos: deps.repos,
        config: composed.config,
        sandbox: composed.sandbox,
        runner: composed.runner,
        judge: new Judge(composed.provider, composed.config.judge, 42),
        reflector: new Reflector(
          composed.provider,
          composed.config.reflect,
          composed.config.roster.map((r) => r.modelId),
        ),
        seedStrategy: (i) => `attempt the goal, variant ${i}`,
        onEvent: emit,
      })
      let runId: string
      try {
        runId = engine.createRun(spec.name, spec.goal).id
      } catch (e) {
        await composed.cleanup().catch(() => {})
        return reply.code(specErrorCode(e)).send({ error: specErrorMessage(e) })
      }
      holder.value = runId
      // Deliberately after createRun: the sweep must exclude the live run, and
      // nothing is provisioned yet (containers start in the first round), so
      // this is the same safe window the CLI sweeps in.
      if (composed.config.sandbox === 'docker' && deps.sweepWith) {
        await deps.sweepWith(composed.config, runId, (m) => composed.warnings.push(m)).catch(() => {})
      }
      const manager = new RunManager(engine, emit)
      const record: RunRecord = {
        runId, spec, engine, manager, composed,
        bridges: [], warnings: composed.warnings, capacity: composed.capacity,
      }
      deps.registry?.set(record)
      const lookupAgent = (sessionId: string): string | null =>
        composed.sessionMap.get(sessionId) ?? null
      if (spec.sandbox === 'local' && spec.workspaceRoot) {
        record.bridges.push(startEventBridge({
          baseUrl: composed.serverHandle?.baseUrl ?? spec.serverUrl ?? '',
          runId, lookupAgent, emit,
        }))
      } else if (spec.sandbox === 'docker') {
        for (const shard of composed.shardServers) {
          record.bridges.push(startEventBridge({
            baseUrl: shard.baseUrl, runId, lookupAgent, emit,
          }))
        }
      }
      return reply.code(201).send({ runId, warnings: composed.warnings })
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
    // Runtime capacity/warnings only exist on the per-run record (composed
    // runs); legacy runs fall through to the config defaults in the snapshot.
    const record = deps.registry?.get(id)
    const snapshot = buildRunSnapshot(
      deps.repos, id,
      record ? { capacity: record.capacity, warnings: record.warnings } : undefined,
    )
    if (!snapshot) return reply.code(404).send({ error: 'no such run' })
    // Composed runs have their own manager/engine; the global one never sees them.
    const mgr = record?.manager ?? deps.manager
    return {
      ...snapshot,
      busy: mgr.isBusy(id),
      lastError: mgr.lastError(id),
    }
  })

  app.post('/api/runs/:id/rounds', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { goalMd?: string; criteriaMd?: string | null }
    if (!deps.repos.runs.get(id)) return reply.code(404).send({ error: 'no such run' })
    if (!body.goalMd) return reply.code(400).send({ error: 'goalMd is required' })
    const mgr = deps.registry?.get(id)?.manager ?? deps.manager
    try {
      mgr.startRound(id, { goalMd: body.goalMd, criteriaMd: body.criteriaMd ?? null })
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) })
    }
    return reply.code(202).send({ started: true })
  })

  app.patch('/api/runs/:id/config', async (req, reply) => {
    const { id } = req.params as { id: string }
    const run = deps.repos.runs.get(id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    const record = deps.registry?.get(id)
    if ((record?.manager ?? deps.manager).isBusy(id)) return reply.code(409).send({ error: 'run is busy' })
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
    if (record) {
      // Spec section 2: a PATCH takes effect from the NEXT round, so the whole merged
      // spec is re-validated (cross-field rules included) and the per-run engine is
      // reconfigured in place — the busy guard above guarantees no round is in flight.
      let newSpec: RunSpec
      try {
        newSpec = parseRunSpec({
          ...record.spec,
          roster: patch.roster ?? record.spec.roster,
          budget: { ...record.spec.budget, ...patch.budget },
          judge: { ...record.spec.judge, ...patch.judge },
        })
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
      if (newSpec.population !== run.config.populationSize) {
        return reply.code(400).send({
          error: `roster counts sum to ${newSpec.population} but populationSize is ${run.config.populationSize}`,
        })
      }
      try {
        const newConfig = runConfigFor(newSpec)
        // Prices are stable for a run's lifetime: a PATCH cannot set pricing, so the
        // run's existing table keeps enforcing the USD side of any new cap.
        newConfig.pricing = record.composed.config.pricing
        // Mirrors the per-run engine construction above (same provider, same seed).
        const judge = new Judge(record.composed.provider, newConfig.judge, 42)
        const reflector = new Reflector(
          record.composed.provider,
          newConfig.reflect,
          newConfig.roster.map((r) => r.modelId),
        )
        // Before the db write: a reconfigure failure (e.g. a new cap the roster
        // pricing cannot support) must not leave the row updated anyway.
        record.engine.reconfigure(id, { config: newConfig, judge, reflector })
        record.spec = newSpec
        record.composed.config = newConfig
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
      deps.repos.runs.updateConfig(id, record.composed.config)
    } else {
      const next = {
        ...run.config,
        roster: patch.roster ?? run.config.roster,
        budget: { ...run.config.budget, ...patch.budget },
        judge: { ...run.config.judge, ...patch.judge },
      }
      deps.repos.runs.updateConfig(id, next)
    }
    return { warnings: record?.warnings ?? [] }
  })

  return app
}
