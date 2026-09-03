import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AgentRow, RunConfig } from '../core/types.js'
import type { Repos } from '../db/repos.js'
import { TournamentEngine } from '../engine/driver.js'
import type { EventSink } from '../engine/events.js'
import { Reflector } from '../evolution/reflect.js'
import { Judge } from '../judge/judge.js'
import { runConfigFor, type ComposedRun, type RunIdHolder } from './compose-run.js'
import { startEventBridge } from './event-bridge.js'
import { disposeRunRecord, type RunRecord, type RunRegistry } from './runs.js'
import { strategyDiversity } from '../core/analytics.js'
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

/** Spec 3.1: the drawer's single fetch — agent, lineage to the seed, genomes, score+submission history. */
function agentDetail(repos: Repos, runId: string, agentId: string) {
  const agents = repos.agents.listAll(runId)
  const agent = agents.find((a) => a.id === agentId)
  if (!agent) return null
  // Cap the walk at the run's agent count: the lineage is a tree written once,
  // so this only ever fires on a corrupt parent-pointer cycle.
  const lineage: { agentId: string; label: string; bornRound: number }[] = []
  let cur: AgentRow | undefined = agent
  for (let depth = 0; cur && depth < agents.length; depth++) {
    lineage.push({ agentId: cur.id, label: cur.label, bornRound: cur.bornRound })
    const parentId: string | null = cur.parentAgentId
    cur = parentId ? agents.find((a) => a.id === parentId) : undefined
  }
  const genomes = repos.genomes.forAgent(agentId).map((g) => ({
    roundIdx: g.roundIdx, strategyMd: g.strategyMd, notesMd: g.notesMd,
    modelId: g.modelId, temperature: g.temperature, origin: g.origin,
  }))
  const history = repos.scores.forAgent(runId, agentId).map((s) => {
    const sub = repos.submissions.forAgent(s.roundId, agentId)
    let fileManifest: unknown = null
    if (sub?.fileManifestJson) {
      try {
        fileManifest = JSON.parse(sub.fileManifestJson)
      } catch {
        // The manifest is always our own JSON; a parse failure means a
        // half-written row — serve null rather than 500 the drawer.
      }
    }
    return {
      roundIdx: s.roundIdx, score: s.score, rank: s.rank, band: s.band, rationaleMd: s.rationaleMd,
      submission: sub
        ? {
            status: sub.status,
            errorText: sub.errorText,
            submissionMd: sub.submissionMd,
            fileManifest,
            costUsd: sub.costUsd,
            durationMs: sub.durationMs,
            tokens: {
              in: sub.tokensIn, out: sub.tokensOut,
              cacheRead: sub.tokensCacheRead, cacheWrite: sub.tokensCacheWrite,
            },
          }
        : null,
    }
  })
  return {
    agent: {
      agentId: agent.id, label: agent.label, bornRound: agent.bornRound,
      diedRound: agent.diedRound, status: agent.status, parentAgentId: agent.parentAgentId,
    },
    lineage, genomes, history,
  }
}

/** Spec 3.2: one entry per round that HAS score rows — the chart is completed rounds only. */
function roundStats(repos: Repos, runId: string) {
  const agents = repos.agents.listAll(runId)
  const out: {
    idx: number
    goalMd: string
    costUsd: number
    fitness: { mean: number; min: number; max: number }
    modelShare: { modelId: string; count: number }[]
    diversity: number
  }[] = []
  for (const round of repos.rounds.listForRun(runId)) {
    const scores = repos.scores.forRound(round.id)
    if (scores.length === 0) continue // in-flight (created, not judged) or failed before judging
    const values = scores.map((s) => s.score)
    const counts = new Map<string, number>()
    const strategies: string[] = []
    for (const a of agents) {
      // The genome at this idx is the record of that round: later-born agents
      // simply have no row, an agent culled after the round still counts.
      const g = repos.genomes.forRound(a.id, round.idx)
      if (!g) continue
      counts.set(g.modelId, (counts.get(g.modelId) ?? 0) + 1)
      strategies.push(g.strategyMd)
    }
    out.push({
      idx: round.idx,
      goalMd: round.goalMd,
      costUsd: round.costUsd,
      fitness: {
        mean: values.reduce((sum, v) => sum + v, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      },
      // Sorted by modelId: deterministic regardless of agent insertion order.
      modelShare: [...counts.entries()]
        .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
        .map(([modelId, count]) => ({ modelId, count })),
      diversity: strategyDiversity(strategies),
    })
  }
  return out
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

  app.get('/api/runs/:runId/agents/:agentId', async (req, reply) => {
    const { runId, agentId } = req.params as { runId: string; agentId: string }
    if (!deps.repos.runs.get(runId)) return reply.code(404).send({ error: 'no such run' })
    // Agent ids are globally unique, so the run-scoped lookup doubles as the
    // membership check: a valid id from another run is 'no such agent' here.
    const detail = agentDetail(deps.repos, runId, agentId)
    if (!detail) return reply.code(404).send({ error: 'no such agent' })
    return detail
  })

  app.get('/api/runs/:runId/rounds', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    if (!deps.repos.runs.get(runId)) return reply.code(404).send({ error: 'no such run' })
    return roundStats(deps.repos, runId)
  })

  app.post('/api/runs/:id/rounds', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { goalMd?: string; criteriaMd?: string | null }
    const run = deps.repos.runs.get(id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    // The db-backed stop marker, so a stopped run stays stopped across restarts.
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
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
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
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

  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const registry = deps.registry
    if (!deps.repos.runs.get(id)) return reply.code(404).send({ error: 'no such run' })
    const record = registry?.get(id)
    if (!record) {
      // A legacy (3-arg server) run: the global manager is shared by all of them,
      // so disposing it would kill every legacy run — only per-run records stop.
      return reply.code(409).send({ error: 'run is not stoppable (created outside the dashboard)' })
    }
    // Mirrors disposeRunRecord's never-throw contract: a stop must not 500.
    try {
      await disposeRunRecord(record)
      deps.repos.runs.setStatus(id, 'stopped')
      registry?.delete(id)
    } catch {
      /* the run is torn down either way */
    }
    return { stopped: true }
  })

  return app
}
