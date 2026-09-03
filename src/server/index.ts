import { WebSocketServer } from 'ws'
import { parseArgs } from 'node:util'
import { DEFAULT_CONFIG, type RunConfig } from '../core/types.js'
import { openDb } from '../db/open.js'
import { makeRepos } from '../db/repos.js'
import { TournamentEngine } from '../engine/driver.js'
import type { EngineEvent } from '../engine/events.js'
import { Judge } from '../judge/judge.js'
import { Reflector } from '../evolution/reflect.js'
import { MockAgentRunner } from '../runtime/agent-runner.js'
import { MockProvider } from '../runtime/mock-provider.js'
import { MockSandbox } from '../runtime/mock-sandbox.js'
import { buildApi } from './api.js'
import { RunManager } from './run-manager.js'
import { EventBroadcaster } from './ws.js'
import { composeRun, defaultSeams, type ComposedRun, type RunIdHolder } from './compose-run.js'
import { RunRegistry, disposeRunRecord } from './runs.js'
import type { RunSpec } from './run-spec.js'
import { sweepOrphanContainers } from '../runtime/docker/sweep.js'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4300' },
    db: { type: 'string', default: ':memory:' },
    population: { type: 'string', default: '8' },
    'workspace-root': { type: 'string' },
    'auth-file': { type: 'string' },
    // Under strict run-spec validation the body must already carry workspaceRoot/authFile,
    // so only --server-url can fire as a fallback.
    'server-url': { type: 'string' },
  },
})

const port = Number(values.port)
const db = openDb(values.db!)
const repos = makeRepos(db)

const config: RunConfig = {
  ...DEFAULT_CONFIG,
  populationSize: Number(values.population),
  sandbox: 'mock',
  roster: [{ modelId: 'mock/model', count: Number(values.population), temperature: 0.7 }],
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
  seedStrategy: (i) => `attempt the goal, variant ${i}`,
  onEvent: emit,
})

const manager = new RunManager(engine, emit)
const registry = new RunRegistry()
// Real-mode composition for spec POSTs. Flags fill in whatever the spec omits
// (per-spec values win); seams are defaultSeams, so local/docker compose
// exactly as the CLI does.
const composeWith = (spec: RunSpec, opts?: { runIdHolder?: RunIdHolder }): Promise<ComposedRun> =>
  composeRun(
    {
      ...spec,
      workspaceRoot: values['workspace-root'] ?? spec.workspaceRoot,
      authFile: values['auth-file'] ?? spec.authFile,
      serverUrl: values['server-url'] ?? spec.serverUrl,
    },
    defaultSeams,
    opts ?? {},
  )
const app = buildApi({
  repos,
  manager,
  createRun: (name) => engine.createRun(name, '').id,
  registry,
  composeWith,
  emit,
  sweepWith: (config, runId, onWarning) =>
    sweepOrphanContainers({ activeRunId: runId, onWarning }),
})

const server = app.server
const wss = new WebSocketServer({ server, path: '/ws' })
broadcaster.attach(wss)

await app.listen({ port, host: '127.0.0.1' })
console.log(`dashboard API on http://127.0.0.1:${port}`)
console.log(`websocket on ws://127.0.0.1:${port}/ws`)
console.log(`run the UI with: npm run web:dev`)

const shutdown = async () => {
  for (const record of registry.list()) {
    await disposeRunRecord(record).catch(() => {})
  }
  await manager.disposeAll().catch(() => {})
  await app.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
