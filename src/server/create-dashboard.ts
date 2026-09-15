import { WebSocketServer } from 'ws'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_CONFIG, type RunConfig } from '../core/types.js'
import { openDb } from '../db/open.js'
import { makeRepos, type Repos } from '../db/repos.js'
import { recoverIncompleteRounds } from '../db/recover.js'
import { TournamentEngine } from '../engine/driver.js'
import { defaultSeedStrategy } from '../engine/seed-strategy.js'
import type { EngineEvent } from '../engine/events.js'
import { Judge } from '../judge/judge.js'
import { Reflector } from '../evolution/reflect.js'
import { MockAgentRunner } from '../runtime/agent-runner.js'
import { MockProvider } from '../runtime/mock-provider.js'
import { MockSandbox } from '../runtime/mock-sandbox.js'
import { sweepOrphanContainers, sweepOrphanNetworks } from '../runtime/docker/sweep.js'
import { processLedger, readHostCapacity } from '../runtime/docker/capacity.js'
import { sweepOrphanRuntimeDirs } from '../runtime/runtime-dirs.js'
import { buildApi } from './api.js'
import { ActivityCache } from './activity.js'
import { AuditCollector } from '../engine/audit.js'
import { composeRun, defaultSeams, type ComposedRun, type RunIdHolder } from './compose-run.js'
import type { RunSpec } from './run-spec.js'
import { RunManager } from './run-manager.js'
import { disposeRunRecord, RunRegistry } from './runs.js'
import { EventBroadcaster } from './ws.js'
import { serveUi } from './static-ui.js'

export interface DashboardOptions {
  dbPath?: string
  /** Size of the default mock run used before a spec-driven run is created. */
  population?: number
  workspaceRoot?: string | null
  authFile?: string | null
  serverUrl?: string | null
  /**
   * Directory holding the built UI. When set, the UI is served from the API's own port, so
   * the app is one process on one address. Tests leave it unset and get the API alone.
   */
  uiDir?: string | null
}

export interface Dashboard {
  app: FastifyInstance
  repos: Repos
  manager: RunManager
  registry: RunRegistry
  broadcaster: EventBroadcaster
  /** Rounds recovered from an interrupted previous process. */
  recovered: number
  /** Attaches the websocket server to the HTTP server. Call before `listen`. */
  attachWebSocket(): WebSocketServer
  shutdown(): Promise<void>
}

/**
 * The dashboard's single composition root.
 *
 * It exists because there were three: the server entry point, the API's spec-driven
 * compose path, and each end-to-end test wiring the engine by hand. That duplication is
 * how the servers kept a keyword-free seed strategy long after the CLI was fixed —
 * evolution was exactly flat in the dashboard while the CLI climbed on the same engine,
 * and nothing failed. Tests that build their own graph cannot catch that class of drift,
 * so they build this one instead.
 */
export function createDashboard(opts: DashboardOptions = {}): Dashboard {
  const db = openDb(opts.dbPath ?? ':memory:')
  const repos = makeRepos(db)
  const recovered = recoverIncompleteRounds(db)

  const population = opts.population ?? 8
  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: population,
    sandbox: 'mock',
    roster: [{ modelId: 'mock/model', count: population, temperature: 0.7 }],
  }

  const broadcaster = new EventBroadcaster()
  const broadcast = (e: EngineEvent) => broadcaster.broadcast(e)
  // Runs on the default engine have no per-run record, so their live activity is kept here;
  // spec-driven runs keep their own cache on their record and get the raw broadcaster below.
  const defaultActivity = new Map<string, ActivityCache>()
  const emit = (e: EngineEvent) => {
    let cache = defaultActivity.get(e.runId)
    if (!cache) {
      cache = new ActivityCache()
      defaultActivity.set(e.runId, cache)
    }
    const out = cache.record(e)
    if (out) broadcast(out)
  }

  const provider = new MockProvider(42)
  const sandbox = new MockSandbox()
  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner: new MockAgentRunner(sandbox, 42),
    judge: new Judge(provider, config.judge, 42),
    reflector: new Reflector(provider, config.reflect, config.roster.map((r) => r.modelId)),
    seedStrategy: defaultSeedStrategy,
    onEvent: emit,
    audit: new AuditCollector(repos, { provenance: { sandbox: 'mock', isolation: null, toolchainId: null } }),
  })

  const manager = new RunManager(engine, emit)
  const registry = new RunRegistry()

  // Real-mode composition for spec POSTs. Per-spec values win; anything omitted
  // falls back to the process-level defaults, and the seams are the same ones the
  // CLI uses so local/docker compose identically.
  const composeWith = (spec: RunSpec, o?: { runIdHolder?: RunIdHolder }): Promise<ComposedRun> =>
    composeRun(
      {
        ...spec,
        workspaceRoot: spec.workspaceRoot ?? opts.workspaceRoot ?? null,
        authFile: spec.authFile ?? opts.authFile ?? null,
        serverUrl: spec.serverUrl ?? opts.serverUrl ?? null,
      },
      defaultSeams,
      o ?? {},
    )

  const app = buildApi({
    repos,
    manager,
    createRun: (name, goal, criteria) => engine.createRun(name, goal, criteria ?? null).id,
    registry,
    composeWith,
    // Applied before the spec is validated, which is the only place they can take
    // effect: composeWith runs after parseRunSpec, so merging them there left the
    // flags unreachable for docker and local runs, which require these fields.
    specDefaults: {
      workspaceRoot: opts.workspaceRoot ?? null,
      authFile: opts.authFile ?? null,
      serverUrl: opts.serverUrl ?? null,
    },
    // A legacy PATCH used to write the run row and stop there, so the shared engine kept
    // running the old config while the row reported the new one. Rebuilding the judge and
    // reflector needs the provider, which lives here rather than in the API.
    reconfigureRun: (runId, next) => {
      engine.reconfigure(runId, {
        config: next,
        judge: new Judge(provider, next.judge, 42),
        reflector: new Reflector(provider, next.reflect, next.roster.map((r) => r.modelId)),
      })
    },
    emit: broadcast,
    activityFor: (runId) => defaultActivity.get(runId)?.snapshot() ?? null,
    capacity: async () => ({ host: await readHostCapacity(), reserved: processLedger.totals() }),
    sweepWith: (cfg, runId, onWarning, workspaceRoot) => {
      // Every registered docker run owns live containers; excluding only the new run
      // would let its sweep destroy a concurrent run mid-tournament.
      const activeRunIds = [
        ...registry.list().filter((r) => r.composed.config.sandbox === 'docker').map((r) => r.runId),
        runId,
      ]
      void cfg
      // Containers first: Docker keeps a network while anything is still attached to it.
      return sweepOrphanContainers({ activeRunIds, onWarning }).then(async (removed) => {
        await sweepOrphanNetworks({ activeRunIds, onWarning })
        // Runtime folders last, once nothing that mounted them can still be running.
        const roots = new Set(
          [workspaceRoot, opts.workspaceRoot, ...registry.list().map((r) => r.spec.workspaceRoot)]
            .filter((root): root is string => typeof root === 'string' && root.length > 0),
        )
        for (const root of roots) await sweepOrphanRuntimeDirs({ workspaceRoot: root, activeRunIds, onWarning })
        return removed
      })
    },
  })

  // After buildApi, so every API route is registered before the UI's catch-all.
  if (opts.uiDir) serveUi(app, opts.uiDir)

  // Retained so shutdown can close the sockets it opened; see shutdown() below.
  let wss: WebSocketServer | null = null
  let shuttingDown: Promise<void> | null = null

  return {
    app,
    repos,
    manager,
    registry,
    broadcaster,
    recovered,
    attachWebSocket() {
      wss ??= new WebSocketServer({ server: app.server, path: '/ws' })
      broadcaster.attach(wss)
      return wss
    },
    /**
     * Releases everything this composition root owns, in dependency order, once.
     *
     * Two things were missing. An upgraded websocket is not the HTTP server's to close:
     * `app.close()` resolves while the socket is still open, and Node will not exit
     * while one is held — so a dashboard process that had ever served a browser hung on
     * shutdown. And the database handle was never closed at all, keeping a file lock
     * (and its WAL, on a real path) for the life of the process.
     *
     * The DB closes last and in `finally`, because everything above writes through it
     * and because releasing it must not depend on the rest succeeding.
     */
    shutdown() {
      return (shuttingDown ??= (async () => {
        try {
          for (const record of registry.list()) {
            await disposeRunRecord(record).catch(() => {})
          }
          await manager.disposeAll().catch(() => {})
          if (wss !== null) {
            const server = wss
            for (const client of server.clients) client.close()
            // Bounded: a client that never completes the closing handshake must not
            // hold shutdown open. The timer is unref'd so the normal path exits at once.
            await Promise.race([
              new Promise<void>((resolve) => server.close(() => resolve())),
              new Promise<void>((resolve) => { setTimeout(resolve, 2000).unref() }),
            ])
            for (const client of server.clients) client.terminate()
          }
          await app.close().catch(() => {})
        } finally {
          try {
            db.close()
          } catch {
            /* already closed, or never opened past construction */
          }
        }
      })())
    },
  }
}
