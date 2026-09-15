import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { DEFAULT_CONFIG, type AgentRow, type FileEntry, type RunConfig } from '../core/types.js'
import type { Repos, RoundRow } from '../db/repos.js'
import { TournamentEngine } from '../engine/driver.js'
import { defaultSeedStrategy } from '../engine/seed-strategy.js'
import type { EventSink } from '../engine/events.js'
import { Reflector } from '../evolution/reflect.js'
import { Judge, type JudgeInput, type JudgeOutput } from '../judge/judge.js'
import { runConfigFor, type ComposedRun, type RunIdHolder, type ShardServer } from './compose-run.js'
import { startEventBridge, type BridgeHandle } from './event-bridge.js'
import { disposeRunRecord, type RunRecord, type RunRegistry } from './runs.js'
import { strategyDiversity } from '../core/analytics.js'
import { parseRunSpec, type RunSpec } from './run-spec.js'
import { buildRunSnapshot } from './state.js'
import { RunManager } from './run-manager.js'
import { startServer, type ServerHandle } from '../runtime/opencode/server.js'
import { discoverModels } from '../runtime/opencode/discovery.js'
import { buildCsvRows, buildJsonDump } from './export.js'
import { submissionView } from './submission-view.js'
import { ActivityCache, type ActivitySnapshot } from './activity.js'
import type { HostCapacity } from '../runtime/docker/capacity.js'

export interface SpecDefaults {
  workspaceRoot?: string | null
  authFile?: string | null
  serverUrl?: string | null
}

export interface ApiDeps {
  repos: Repos
  manager: RunManager
  createRun: (name: string, goal: string, criteria?: string | null) => string
  composeRun?: (spec: RunSpec, opts?: { runIdHolder?: RunIdHolder }) => Promise<ComposedRun>
  composeWith?: (spec: RunSpec, opts?: { runIdHolder?: RunIdHolder }) => Promise<ComposedRun>
  /** Process-level fallbacks for spec fields a request may omit; see applySpecDefaults. */
  specDefaults?: SpecDefaults
  /**
   * Applies a new config to a run on the DEFAULT engine, rebuilding its judge and
   * reflector. Supplied by the composition root because only it holds the provider those
   * two need. Without it a legacy PATCH can only store a config the engine never reads.
   */
  reconfigureRun?: (runId: string, config: RunConfig) => void
  registry?: RunRegistry
  emit?: EventSink
  /** `workspaceRoot`: the new run's, whose stale runtime folders are swept too. */
  sweepWith?: (
    config: RunConfig,
    runId: string,
    onWarning: (message: string) => void,
    workspaceRoot?: string | null,
  ) => Promise<string[]>
  startModelsServer?: () => Promise<ServerHandle>
  /** Live activity for runs on the default engine, which have no per-run record. */
  activityFor?: (runId: string) => ActivitySnapshot | null
  /** Docker's capacity reading and what this process has reserved, for setup estimates. */
  capacity?: () => Promise<{ host: HostCapacity; reserved: { memoryBytes: number; cpus: number } }>
}

/** Bridge callbacks that report upstream stream health as its own event, never as agent state. */
function streamHealth(runId: string, source: string, emit: EventSink) {
  return {
    onConnected: () => emit({ type: 'bridge.status', runId, source, state: 'connected', at: Date.now() }),
    onError: (e: Error) =>
      emit({ type: 'bridge.status', runId, source, state: 'reconnecting', message: e.message.slice(0, 200), at: Date.now() }),
  }
}

/** The session an agent runs now: sessions are recorded in creation order. */
function latestSessionFor(sessionMap: Map<string, string>, agentId: string): string | null {
  let latest: string | null = null
  for (const [sessionId, owner] of sessionMap) if (owner === agentId) latest = sessionId
  return latest
}

function startDockerShardBridges(opts: {
  composed: ComposedRun
  runId: string
  lookupAgent: (sessionId: string) => string | null
  emit: EventSink
}): BridgeHandle {
  const active = new Map<number, { baseUrl: string; bridge: BridgeHandle }>()
  let stopped = false
  const attach = (server: ShardServer) => {
    if (stopped) return
    const current = active.get(server.shardIndex)
    if (current?.baseUrl === server.baseUrl) return
    current?.bridge.stop()
    active.set(server.shardIndex, {
      baseUrl: server.baseUrl,
      bridge: startEventBridge({
        baseUrl: server.baseUrl,
        runId: opts.runId,
        lookupAgent: opts.lookupAgent,
        emit: opts.emit,
        ...streamHealth(opts.runId, `shard-${server.shardIndex}`, opts.emit),
      }),
    })
  }
  const unsubscribe = opts.composed.onShardServer!(attach)
  return {
    stop() {
      if (stopped) return
      stopped = true
      unsubscribe()
      for (const current of active.values()) current.bridge.stop()
      active.clear()
    },
  }
}

/**
 * Server-level spec defaults, applied BEFORE validation.
 *
 * The dashboard takes --workspace-root and --auth-file so they need not be repeated on
 * every request, but they used to be merged inside composeWith — which runs after the
 * strict parseRunSpec below. A docker spec omitting them was therefore rejected outright
 * and those flags were unreachable for the only two sandboxes that require them.
 *
 * Merging here rather than in compose keeps one source for the decision, and keeps the
 * cross-field and absolute-path checks in force over the merged result: a relative
 * server-side default is still refused rather than smuggled past validation.
 *
 * An explicit request value always wins. An explicit `null` counts as "not supplied",
 * because the schema already defaults an absent field to null and nothing downstream can
 * tell the two apart.
 */
function applySpecDefaults(
  body: Record<string, unknown>,
  defaults: SpecDefaults | undefined,
): Record<string, unknown> {
  if (!defaults) return body
  const merged = { ...body }
  for (const key of ['workspaceRoot', 'authFile', 'serverUrl'] as const) {
    if (merged[key] === undefined || merged[key] === null) {
      const fallback = defaults[key]
      if (fallback !== undefined && fallback !== null) merged[key] = fallback
    }
  }
  return merged
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

const nonBlankString = z.string().refine((value) => value.trim().length > 0, 'must not be blank')
const legacyRunBodySchema = z.object({
  name: nonBlankString,
  goal: nonBlankString,
  // Optional creation criteria, persisted with the run as the round-1 draft default.
  criteria: z.string().nullable().optional(),
})
const roundBodySchema = z.object({
  goalMd: nonBlankString,
  criteriaMd: z.string().nullable().optional(),
})

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
    return {
      roundIdx: s.roundIdx, score: s.score, rank: s.rank, band: s.band, rationaleMd: s.rationaleMd,
      submission: sub ? submissionView(sub) : null,
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
  // One statement for every genome in the run, instead of one per agent per round. The
  // dashboard polls this endpoint, and node:sqlite is synchronous, so the old
  // rounds-times-agents walk blocked the event loop for 229ms per poll at 100x100.
  const genomes = repos.genomes.forRunByRound(runId)
  const out: {
    idx: number
    goalMd: string
    costUsd: number
    fitness: { mean: number; min: number; max: number }
    modelShare: { modelId: string; count: number }[]
    diversity: number
    criteriaMd: string | null
    criteriaSource: 'user' | 'generated'
    metaDigest: string | null
    /**
     * Which judging mode produced this round's scores, and therefore what scale they
     * are on. `single_call` scores come from the judge directly (0-100). Above
     * `singleCallMaxPopulation` the judge switches to `batched_finals`, where scores
     * are derived from final ordering as ((n-i)/n)*100 rather than judged values.
     * The two are not comparable, so a fitness chart that plots them on one axis
     * silently changes meaning when a population crosses the threshold. Exposed so
     * the chart can say so instead of pretending otherwise.
     */
    judgeMode: string
    scoreScale: 'judge' | 'rank'
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
      const g = genomes.get(`${a.id}:${round.idx}`)
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
      // Straight from the row: unscored rounds never reach here (skipped above).
      criteriaMd: round.criteriaMd,
      criteriaSource: round.criteriaSource === 'user' ? 'user' : 'generated',
      metaDigest: round.metaDigest,
      judgeMode: round.judgeMode,
      scoreScale: round.judgeMode === 'batched_finals' ? 'rank' : 'judge',
    })
  }
  return out
}

/** Spec §3: round header + entries ASC by rank (scores.forRound is rank-ordered).
 * Entries join the agent label, the round-idx genome's model, and the
 * submission-or-null via the shared submissionView above. */
function roundDetail(repos: Repos, round: RoundRow) {
  const byId = new Map(repos.agents.listAll(round.runId).map((a) => [a.id, a]))
  const entries = repos.scores.forRound(round.id).map((s) => {
    const sub = repos.submissions.forAgent(round.id, s.agentId)
    return {
      agentId: s.agentId,
      // Agents are never deleted, so the lookup cannot miss on a real row.
      label: byId.get(s.agentId)?.label ?? '',
      // Every scored agent ran the round, so a genome row exists; the fallback
      // only covers a half-written row (same spirit as the manifest guard).
      modelId: repos.genomes.forRound(s.agentId, round.idx)?.modelId ?? '',
      score: s.score, rank: s.rank, band: s.band, rationaleMd: s.rationaleMd,
      submission: sub ? submissionView(sub) : null,
    }
  })
  return {
    idx: round.idx,
    goalMd: round.goalMd,
    criteriaMd: round.criteriaMd,
    criteriaSource: round.criteriaSource === 'user' ? 'user' : 'generated',
    metaDigest: round.metaDigest,
    costUsd: round.costUsd,
    status: round.status,
    // WHY no judge model here (spec §1 honesty rule): PATCH can change the
    // judge model mid-run and rounds don't store it — reporting the CURRENT
    // config's model per round would mislead. judgeMode is on the row; the
    // model column is a future migration.
    judgeMode: round.judgeMode,
    entries,
  }
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  /**
   * Model discovery, cached 60s on success only.
   *
   * Every miss starts an opencode server process, so an uncached setup screen would fork
   * one per keystroke; a minute-stale list is harmless because free text always works.
   * Failures never cache, so a transient one stays retryable.
   *
   * Scoped to this API instance rather than the module: a second dashboard in the same
   * process can point at a different opencode configuration, and answering it from the
   * first one's list would describe a server it never asked about.
   */
  let modelsCache: { at: number; models: string[] } | null = null
  let modelsInFlight: Promise<string[]> | null = null

  app.post('/api/runs', async (req, reply) => {
    const rawBody = req.body
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      return reply.code(400).send({ error: 'request body must be an object' })
    }
    const body = rawBody as Record<string, unknown>
    if (body.sandbox !== undefined || body.roster !== undefined) {
      try {
        legacyRunBodySchema.parse(body)
      } catch (e) {
        return reply.code(400).send({ error: e instanceof z.ZodError ? e.issues[0]?.message ?? 'invalid request body' : String(e) })
      }
      let spec: RunSpec
      try {
        spec = parseRunSpec(applySpecDefaults(body, deps.specDefaults))
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
      const broadcast: EventSink = deps.emit ?? (() => {})
      const activity = new ActivityCache({
        currentSession: (agentId) => latestSessionFor(composed.sessionMap, agentId),
      })
      // Cached before it is broadcast, so a snapshot requested right after an event
      // already holds it and a reconnecting browser cannot lose what it was sent.
      const emit: EventSink = (e) => {
        const out = activity.record(e)
        if (out) broadcast(out)
      }
      // Engine construction mirrors src/server/index.ts: composed pieces in
      // place of the mock literals, Judge/Reflector over the composed provider.
      const engine = new TournamentEngine({
        repos: deps.repos,
        config: composed.config,
        sandbox: composed.sandbox,
        runner: composed.runner,
        judge: new Judge(composed.provider, composed.config.judge, 42, undefined, {
          contextPath: composed.config.contextDir ?? null,
        }),
        reflector: new Reflector(
          composed.provider,
          composed.config.reflect,
          composed.config.roster.map((r) => r.modelId),
        ),
        seedStrategy: defaultSeedStrategy,
        onEvent: emit,
        preparePopulation: composed.planFor ?? undefined,
      })
      let runId: string
      try {
        runId = engine.createRun(spec.name, spec.goal, spec.criteria).id
      } catch (e) {
        await composed.cleanup().catch(() => {})
        return reply.code(specErrorCode(e)).send({ error: specErrorMessage(e) })
      }
      holder.value = runId
      // Deliberately after createRun: the sweep must exclude the live run, and
      // nothing is provisioned yet (containers start in the first round), so
      // this is the same safe window the CLI sweeps in.
      if (composed.config.sandbox === 'docker' && deps.sweepWith) {
        await deps.sweepWith(composed.config, runId, (m) => composed.warnings.push(m), spec.workspaceRoot).catch(() => {})
      }
      const manager = new RunManager(engine, emit)
      const record: RunRecord = {
        runId, spec, engine, manager, composed,
        bridges: [], warnings: composed.warnings, capacity: composed.capacity,
        activity,
      }
      deps.registry?.set(record)
      const lookupAgent = (sessionId: string): string | null =>
        composed.sessionMap.get(sessionId) ?? null
      if (spec.sandbox === 'local' && spec.workspaceRoot) {
        record.bridges.push(startEventBridge({
          baseUrl: composed.serverHandle?.baseUrl ?? spec.serverUrl ?? '',
          runId, lookupAgent, emit,
          ...streamHealth(runId, 'server', emit),
        }))
      } else if (spec.sandbox === 'docker') {
        if (composed.onShardServer) {
          record.bridges.push(startDockerShardBridges({ composed, runId, lookupAgent, emit }))
        } else {
          // Compatibility for injected compositions that expose a fixed list.
          composed.shardServers.forEach((shard, index) => {
            record.bridges.push(startEventBridge({
              baseUrl: shard.baseUrl, runId, lookupAgent, emit,
              ...streamHealth(runId, `shard-${index}`, emit),
            }))
          })
        }
      }
      return reply.code(201).send({ runId, warnings: composed.warnings })
    }
    let legacy: { name: string; goal: string; criteria?: string | null }
    try {
      legacy = legacyRunBodySchema.parse(body)
    } catch {
      return reply.code(400).send({ error: 'name and goal are required' })
    }
    const runId = deps.createRun(legacy.name, legacy.goal, legacy.criteria ?? null)
    return reply.code(201).send({ runId })
  })

  app.get('/api/runs', async () => {
    const runs = deps.repos.runs.list?.() ?? []
    const summarized = runs.map((r) => {
      const rs = deps.repos.rounds.listForRun(r.id)
      let bestScore: number | null = null
      let costUsd = 0
      for (const round of rs) {
        costUsd += round.costUsd
        for (const s of deps.repos.scores.forRound(round.id)) {
          if (bestScore === null || s.score > bestScore) bestScore = s.score
        }
      }
      return { ...r, rounds: rs.length, bestScore, costUsd }
    })
    return { runs: summarized }
  })

  app.get('/api/models', async (_req, reply) => {
    if (modelsCache && Date.now() - modelsCache.at < 60_000) {
      return { models: modelsCache.models }
    }
    const start = deps.startModelsServer ?? startServer

    // Concurrent misses share one attempt. The cache is only written AFTER discovery
    // returns, so without this two requests that miss together both get past the check
    // above and each start their own opencode server process — the setup screen's two
    // model pickers mounting at once was enough to do it.
    if (modelsInFlight === null) {
      const attempt = (async () => {
        const handle = await start()
        try {
          // Discovery order untouched — the client does presentation.
          const models = await discoverModels(handle.client)
          modelsCache = { at: Date.now(), models }
          return models
        } finally {
          // A stop failure must not mask a successful discovery — hence ignore.
          await handle.stop().catch(() => {})
        }
      })()
      modelsInFlight = attempt
      // Cleared on settle, so a failure stays retryable rather than becoming sticky.
      // The error is swallowed HERE only: every caller awaiting `attempt` reports it.
      void attempt.catch(() => {}).then(() => {
        if (modelsInFlight === attempt) modelsInFlight = null
      })
    }

    try {
      return { models: await modelsInFlight }
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // Totals only: per-container names belong to whatever else runs on this Docker host.
  app.get('/api/capacity', async (_req, reply) => {
    if (!deps.capacity) return reply.code(503).send({ error: 'Docker capacity is not available from this server.' })
    try {
      const { host, reserved } = await deps.capacity()
      return {
        totalMemoryBytes: host.totalMemoryBytes,
        usedMemoryBytes: host.usedMemoryBytes,
        cpus: host.cpus,
        reservedMemoryBytes: reserved.memoryBytes,
        reservedCpus: reserved.cpus,
      }
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    // Runtime capacity/warnings only exist on the per-run record (composed
    // runs); legacy runs fall through to the config defaults in the snapshot.
    const record = deps.registry?.get(id)
    const snapshot = buildRunSnapshot(
      deps.repos, id,
      record
        ? { capacity: record.capacity, warnings: record.warnings, placement: record.composed?.placement?.() ?? null }
        : undefined,
    )
    if (!snapshot) return reply.code(404).send({ error: 'no such run' })
    // Composed runs have their own manager/engine; the global one never sees them.
    const mgr = record?.manager ?? deps.manager
    return {
      ...snapshot,
      busy: mgr.isBusy(id),
      lastError: mgr.lastError(id),
      // Null when this process holds no live history for the run — after a restart, say —
      // which the UI reports as unavailable rather than showing an empty timeline.
      activity: record?.activity?.snapshot() ?? deps.activityFor?.(id) ?? null,
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

  app.post('/api/runs/:runId/agents', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const run = deps.repos.runs.get(runId)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
    const record = deps.registry?.get(runId)
    if ((record?.manager ?? deps.manager).isBusy(runId)) return reply.code(409).send({ error: 'run is busy' })
    // Refused here rather than at the next round's planning, where it would fail the round.
    if (run.config.sandbox === 'docker' && run.config.isolation === 'protected') {
      const active = deps.repos.agents.listActive(runId).length
      if (active + 1 > run.config.maxContainers) {
        return reply.code(409).send({
          error:
            `Protected isolation gives each agent its own container: this run has ${active} agents and ` +
            `${run.config.maxContainers} containers, so another agent would have to share one. Remove an agent first.`,
        })
      }
    }
    const addSchema = z.object({
      modelId: z.string().min(1),
      temperature: z.number().min(0).max(2),
      strategy: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('blank') }),
        z.object({ mode: z.literal('pasted'), strategyMd: z.string().min(1) }),
        z.object({ mode: z.literal('clone'), agentId: z.string().min(1) }),
      ]),
    })
    let body: z.infer<typeof addSchema>
    try {
      body = addSchema.parse(req.body ?? {})
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
    // Clone source: the run-scoped lookup doubles as the membership check (see
    // the agent-detail route) — a valid id from another run is 'no such agent'.
    let parentAgentId: string | null = null
    let parentGenomeId: string | null = null
    let strategyMd = ''
    let notesMd = ''
    if (body.strategy.mode === 'clone') {
      const cloneId = body.strategy.agentId
      const source = deps.repos.agents.listAll(runId).find((a) => a.id === cloneId)
      if (!source) return reply.code(404).send({ error: 'no such agent' })
      // forAgent is roundIdx-asc, so the last row is the latest genome.
      const genomes = deps.repos.genomes.forAgent(source.id)
      const latest = genomes.length > 0 ? genomes[genomes.length - 1]! : null
      if (!latest) return reply.code(400).send({ error: 'clone source has no genome yet' })
      parentAgentId = source.id
      parentGenomeId = latest.id
      strategyMd = latest.strategyMd
      notesMd = latest.notesMd
    } else if (body.strategy.mode === 'pasted') {
      strategyMd = body.strategy.strategyMd
    }
    // WHY blank stays empty: the agent's first reflection fills it in; the judge
    // scores its submission, not its strategy.
    // USD preflight mirrors the driver createRun refusal (budget.ts): a capped run
    // cannot gain a model with no price entry. The repo-decoded config already
    // restores the Infinity sentinel, so a plain !== Infinity check is exact.
    const budget = run.config.budget
    const hasUsdLimit =
      budget.maxRunUsd !== Infinity || budget.maxRoundUsd !== Infinity || budget.maxAgentUsd !== Infinity
    if (hasUsdLimit && !((run.config.pricing ?? {})[body.modelId])) {
      return reply.code(400).send({
        error:
          `A USD budget was set but 1 roster model(s) have no pricing entry: ` +
          `${body.modelId}. Add pricing for them, or set the USD limits to Infinity and ` +
          `budget in tokens instead.`,
      })
    }
    const nextIdx = deps.repos.rounds.lastIdx(runId) + 1
    const all = deps.repos.agents.listAll(runId)
    const labels = new Set(all.map((a) => a.label))
    // WHY length+1 with a collision loop: agents are never deleted, so length+1 is
    // unique absent races; the loop covers concurrent adds landing on the same n.
    let n = all.length + 1
    let label = `competitor-r${nextIdx}-manual-${n}`
    for (let guard = 0; labels.has(label) && guard < all.length + 100; guard++) {
      n += 1
      label = `competitor-r${nextIdx}-manual-${n}`
    }
    const agent = deps.repos.agents.create({ runId, label, parentAgentId, bornRound: nextIdx })
    // NO provisioning: PREPARE provisions every active agent each round, so a
    // between-rounds add needs no immediate sandbox work.
    deps.repos.genomes.create({
      agentId: agent.id, roundIdx: nextIdx, strategyMd, notesMd,
      modelId: body.modelId, temperature: body.temperature,
      parentGenomeId, origin: 'manual',
    })
    return reply.code(201).send({ agentId: agent.id, label })
  })

  app.delete('/api/runs/:runId/agents/:agentId', async (req, reply) => {
    const { runId, agentId } = req.params as { runId: string; agentId: string }
    const run = deps.repos.runs.get(runId)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    const all = deps.repos.agents.listAll(runId)
    const agent = all.find((a) => a.id === agentId)
    if (!agent) return reply.code(404).send({ error: 'no such agent' })
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
    const record = deps.registry?.get(runId)
    if ((record?.manager ?? deps.manager).isBusy(runId)) return reply.code(409).send({ error: 'run is busy' })
    if (agent.status !== 'active') return reply.code(409).send({ error: 'agent is not active' })
    // WHY fail loud: an empty population breaks the next round's judge.
    if (all.filter((a) => a.status === 'active').length <= 1) {
      return reply.code(409).send({ error: 'cannot retire the last active agent' })
    }
    // NO per-agent teardown: shard containers are shared per-run (no per-agent
    // container exists to tear down) and workspace dirs are submission evidence
    // referenced by db rows (workspace_path) and must survive.
    deps.repos.agents.retire(agentId, deps.repos.rounds.lastIdx(runId), 'retired')
    return { retired: true }
  })

  app.get('/api/runs/:runId/rounds', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    if (!deps.repos.runs.get(runId)) return reply.code(404).send({ error: 'no such run' })
    return roundStats(deps.repos, runId)
  })

  app.get('/api/runs/:runId/rounds/:idx', async (req, reply) => {
    const { runId, idx } = req.params as { runId: string; idx: string }
    if (!deps.repos.runs.get(runId)) return reply.code(404).send({ error: 'no such run' })
    // The list is small; no dedicated repo getter for a single (runId, idx) —
    // and scoping the lookup to this run's rows keeps a foreign run's idx a 404.
    const round = deps.repos.rounds.listForRun(runId).find((r) => r.idx === Number(idx))
    if (!round) return reply.code(404).send({ error: 'no such round' })
    // Unscored rounds (row exists, no scores yet) fall through with entries []
    // — the UI shows them as in-flight rather than missing.
    return roundDetail(deps.repos, round)
  })

  app.get('/api/runs/:runId/export', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    if (!deps.repos.runs.get(runId)) return reply.code(404).send({ error: 'no such run' })
    const format = (req.query as { format?: string }).format ?? 'json'
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', `attachment; filename="run-${runId}.csv"`)
      return reply.send(buildCsvRows(runId, deps.repos))
    }
    if (format === 'json') {
      reply.header('Content-Type', 'application/json')
      reply.header('Content-Disposition', `attachment; filename="run-${runId}.json"`)
      return reply.send(buildJsonDump(runId, deps.repos))
    }
    return reply.code(400).send({ error: 'unknown format' })
  })

  app.post('/api/runs/:runId/rounds/:idx/criteria', async (req, reply) => {
    const { runId, idx } = req.params as { runId: string; idx: string }
    const run = deps.repos.runs.get(runId)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    // The list is small; no dedicated repo getter for a single (runId, idx).
    const round = deps.repos.rounds.listForRun(runId).find((r) => r.idx === Number(idx))
    if (!round) return reply.code(404).send({ error: 'no such round' })
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
    if (!['pending', 'preparing', 'running', 'collecting'].includes(round.status)) {
      return reply.code(409).send({ error: 'criteria are frozen once judging starts' })
    }
    let body: { criteriaMd: string }
    try {
      body = z.object({ criteriaMd: z.string().min(1) }).parse(req.body ?? {})
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
    deps.repos.rounds.setCriteria(round.id, body.criteriaMd, 'user')
    return { ok: true }
  })

  app.post('/api/runs/:runId/rounds/:idx/abort', async (req, reply) => {
    const { runId, idx } = req.params as { runId: string; idx: string }
    const run = deps.repos.runs.get(runId)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    // The list is small; no dedicated repo getter for a single (runId, idx).
    const round = deps.repos.rounds.listForRun(runId).find((r) => r.idx === Number(idx))
    if (!round) return reply.code(404).send({ error: 'no such round' })
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
    // The engine flag is set via the record's manager if present else the shared
    // manager — mirrors the POST /rounds manager-resolution line below.
    const mgr = deps.registry?.get(runId)?.manager ?? deps.manager
    if (Number(idx) !== deps.repos.rounds.lastIdx(runId) || !mgr.isBusy(runId)) {
      return reply.code(409).send({ error: 'no round in flight' })
    }
    // Honest cooperative semantics: queued agents stop; in-flight sessions are
    // aborted; completed phases keep their rows and the round ends failed.
    mgr.abortRound(runId)
    return reply.code(202).send({ aborted: true })
  })

  app.post('/api/runs/:runId/rounds/:idx/rejudge', async (req, reply) => {
    const { runId, idx } = req.params as { runId: string; idx: string }
    const run = deps.repos.runs.get(runId)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    const round = deps.repos.rounds.listForRun(runId).find((r) => r.idx === Number(idx))
    if (!round) return reply.code(404).send({ error: 'no such round' })
    if (round.status !== 'complete') return reply.code(409).send({ error: 'round is not complete' })
    const record = deps.registry?.get(runId)
    if ((record?.manager ?? deps.manager).isBusy(runId)) return reply.code(409).send({ error: 'run is busy' })
    let body: { judgeModelId: string }
    try {
      body = z.object({ judgeModelId: z.string().min(1) }).parse(req.body ?? {})
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
    // A live record carries the run's composed provider (mock or real); a legacy
    // run has no record and no stored workspaceRoot, so a fresh opencode server
    // cannot be reconstructed — 409 is honest rather than a half-built provider.
    const provider = record?.composed.provider
    if (!provider) return reply.code(409).send({ error: 'no live provider for this run' })
    const judge = new Judge(provider, { ...run.config.judge, modelId: body.judgeModelId }, 42, undefined, {
      contextPath: run.config.contextDir ?? null,
    })
    const agents = deps.repos.agents.listAll(runId)
    const byId = new Map(agents.map((a) => [a.id, a]))
    const inputs: JudgeInput[] = deps.repos.submissions.forRound(round.id).map((sub) => ({
      agentId: sub.agentId,
      submissionMd: sub.submissionMd ?? '',
      files: (Array.isArray(sub.fileManifest) ? sub.fileManifest : []) as FileEntry[],
      status: sub.status,
    }))
    let output: JudgeOutput
    try {
      output = await judge.score(round.goalMd, round.criteriaMd ?? '', inputs, round.idx)
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
    }
    const oldByAgent = new Map(deps.repos.scores.forRound(round.id).map((s) => [s.agentId, s]))
    const entries = output.scores.map((ns) => {
      const old = oldByAgent.get(ns.agentId)
      return {
        agentId: ns.agentId,
        label: byId.get(ns.agentId)?.label ?? '',
        oldScore: old?.score ?? 0,
        oldRank: old?.rank ?? 0,
        newScore: ns.score,
        newRank: ns.rank,
        newRationaleMd: ns.rationaleMd,
        rankChanged: old ? old.rank !== ns.rank : true,
      }
    })
    return { entries, metaDigest: output.metaDigest, mode: output.mode }
  })

  app.post('/api/runs/:id/rounds', async (req, reply) => {
    const { id } = req.params as { id: string }
    let body: { goalMd: string; criteriaMd?: string | null }
    const run = deps.repos.runs.get(id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    // The db-backed stop marker, so a stopped run stays stopped across restarts.
    if (run.status === 'stopped') return reply.code(409).send({ error: 'run is stopped' })
    try {
      body = roundBodySchema.parse(req.body)
    } catch {
      return reply.code(400).send({ error: 'goalMd is required' })
    }
    const record = deps.registry?.get(id)
    // A registry record lives only in memory, so after a restart a persisted run has
    // none and this route used to fall back to the DEFAULT manager — whose engine is the
    // mock one. Running a docker or local run on it appends fabricated mock rounds to a
    // real run's history, indistinguishable from the real ones afterwards. Refuse
    // instead, immediately and without writing anything.
    //
    // A mock run is still served: the default engine genuinely can honour it, which keeps
    // an ordinary restart usable. The residue is a spec-created MOCK run resumed after a
    // restart, which runs at the default population rather than its own — wrong, but mock
    // data either way. Real resume needs runtime reconstruction and cumulative budget
    // recovery, which is a feature, not a fix.
    if (!record && run.config.sandbox !== 'mock') {
      return reply.code(409).send({
        error:
          `run ${id} uses the ${run.config.sandbox} sandbox and was composed by an earlier ` +
          `process, so this server cannot resume it after a restart. Start a new run.`,
      })
    }
    const mgr = record?.manager ?? deps.manager
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
      selection: z.object({
        crossoverPct: z.number().min(0).max(1),
        eliteCount: z.number().int().min(0),
        topPct: z.number().finite().min(0).max(1),
        bottomPct: z.number().finite().min(0).max(1),
        diversityFloor: z.boolean(),
      }).partial().optional(),
      concurrency: z.number().int().min(1).max(64).optional(),
      pricing: z.record(z.string().min(1), z.object({ inPerM: z.number().nonnegative(), outPerM: z.number().nonnegative(), cacheReadPerM: z.number().nonnegative(), cacheWritePerM: z.number().nonnegative() })).optional(),
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
          selection: { ...DEFAULT_CONFIG.selection, ...record.spec.selection, ...patch.selection },
          concurrency: patch.concurrency ?? record.spec.concurrency,
          pricing: { ...record.spec.pricing, ...patch.pricing },
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
        // No engine code: concurrency/selection/pricing are all re-read per
        // round through the 4b reconfigure swap below.
        // Mirrors the per-run engine construction above (same provider, same seed).
        const judge = new Judge(record.composed.provider, newConfig.judge, 42, undefined, {
          contextPath: newConfig.contextDir ?? null,
        })
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
      // No engine code: concurrency/selection/pricing are all re-read per
      // round through the 4b reconfigure swap on the record branch.
      const selection = { ...DEFAULT_CONFIG.selection, ...run.config.selection, ...patch.selection }
      // No parseRunSpec on this branch, so the elite-vs-top rule is checked here
      // directly on the merged values — same words as parseRunSpec.
      const topCount = Math.max(1, Math.floor(run.config.populationSize * selection.topPct))
      if (selection.eliteCount > topCount) {
        return reply.code(400).send({ error: `eliteCount (${selection.eliteCount}) cannot exceed the top band size (${topCount})` })
      }
      const next = {
        ...run.config,
        roster: patch.roster ?? run.config.roster,
        budget: { ...run.config.budget, ...patch.budget },
        judge: { ...run.config.judge, ...patch.judge },
        selection,
        concurrency: patch.concurrency ?? run.config.concurrency,
        pricing: { ...run.config.pricing, ...patch.pricing },
      }
      // Applied to the engine as well as stored. This branch used to only write the row,
      // so the next round ran the OLD config while the row — and every view reading it —
      // reported the new one. Engine first, mirroring the record branch: a rejected config
      // must not leave the row updated anyway.
      try {
        deps.reconfigureRun?.(id, next)
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
      }
      deps.repos.runs.updateConfig(id, next)
    }
    return { warnings: record?.warnings ?? [] }
  })

  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const registry = deps.registry
    const run = deps.repos.runs.get(id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    if (run.status === 'stopped') return { stopped: true }
    const record = registry?.get(id)
    if (!record) {
      // A legacy (3-arg server) run: the global manager is shared by all of them,
      // so disposing it would kill every legacy run — only per-run records stop.
      return reply.code(409).send({ error: 'run is not stoppable (created outside the dashboard)' })
    }
    // Recorded BEFORE the graceful wait, not after it.
    //
    // Stop waits for the in-flight round against a still-alive sandbox rather than
    // aborting it, and that wait used to leave the run row saying "active" with its
    // registry record still present — so refusing a round that arrived meanwhile rested
    // entirely on an in-memory flag inside the manager, and a crash mid-teardown left a
    // run that looked perfectly runnable. Writing the stop first makes every route that
    // already checks `status === 'stopped'` refuse for the right reason, and it survives
    // a restart.
    //
    // This does not turn Stop into Abort: the round still runs to completion and its
    // results are recorded. A run that is stopped while still busy IS the stopping state
    // — no new rounds, one finishing — and it needs no new status value to say so.
    deps.repos.runs.setStatus(id, 'stopped')
    registry?.delete(id)
    // Mirrors disposeRunRecord's never-throw contract: a stop must not 500.
    try {
      await disposeRunRecord(record)
    } catch {
      /* the run is torn down either way */
    }
    return { stopped: true }
  })

  return app
}
