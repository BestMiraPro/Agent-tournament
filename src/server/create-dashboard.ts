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
import { sweepOrphanContainers } from '../runtime/docker/sweep.js'
import { buildApi } from './api.js'
import { composeRun, defaultSeams, type ComposedRun, type RunIdHolder } from './compose-run.js'
import type { RunSpec } from './run-spec.js'
import { RunManager } from './run-manager.js'
import { disposeRunRecord, RunRegistry } from './runs.js'
import { EventBroadcaster } from './ws.js'

export interface DashboardOptions {
  dbPath?: string
  /** Size of the default mock run used before a spec-driven run is created. */
  population?: number
  workspaceRoot?: string | null
  authFile?: string | null
  serverUrl?: string | null
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
  const emit = (e: EngineEvent) => broadcaster.broadcast(e)

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
    createRun: (name) => engine.createRun(name, '').id,
    registry,
    composeWith,
    emit,
    sweepWith: (cfg, runId, onWarning) => {
      // Every registered docker run owns live containers; excluding only the new run
      // would let its sweep destroy a concurrent run mid-tournament.
      const activeRunIds = [
        ...registry.list().filter((r) => r.composed.config.sandbox === 'docker').map((r) => r.runId),
        runId,
      ]
      void cfg
      return sweepOrphanContainers({ activeRunIds, onWarning })
    },
  })

  return {
    app,
    repos,
    manager,
    registry,
    broadcaster,
    recovered,
    attachWebSocket() {
      const wss = new WebSocketServer({ server: app.server, path: '/ws' })
      broadcaster.attach(wss)
      return wss
    },
    async shutdown() {
      for (const record of registry.list()) {
        await disposeRunRecord(record).catch(() => {})
      }
      await manager.disposeAll().catch(() => {})
      await app.close().catch(() => {})
    },
  }
}
