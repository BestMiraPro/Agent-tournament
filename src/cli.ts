import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, type RosterEntry, type RunConfig } from './core/types.js'
import { openDb } from './db/open.js'
import { makeRepos } from './db/repos.js'
import { TournamentEngine } from './engine/driver.js'
import { Reflector } from './evolution/reflect.js'
import { Judge } from './judge/judge.js'
import { MockAgentRunner, type AgentRunner } from './runtime/agent-runner.js'
import { GOOD_KEYWORDS, MockProvider } from './runtime/mock-provider.js'
import { MockSandbox } from './runtime/mock-sandbox.js'
import { LocalSandbox } from './runtime/local-sandbox.js'
import type { Provider } from './runtime/provider.js'
import { runPool } from './runtime/pool.js'
import type { Sandbox } from './runtime/sandbox.js'
import { OpenCodeAgentRunner } from './runtime/opencode/agent-runner.js'
import { validateModel, summarizeValidation, type ModelRole } from './runtime/opencode/capability.js'
import type { OpenCodeClient } from './runtime/opencode/client.js'
import { OpenCodeProvider } from './runtime/opencode/provider.js'
import { attachServer, startServer, type ServerHandle } from './runtime/opencode/server.js'

export interface CliOptions {
  goal: string
  rounds: number
  population: number
  seed: number
  dbPath: string
  criteria: string | null
  mode?: 'mock' | 'real'
  workspaceRoot?: string
  serverUrl?: string
  judgeModel?: string
  reflectModel?: string
  workerModels?: string[]
  /**
   * Pre-flight capability validation of every distinct (model, role) pair before a real
   * run starts. Defaults to true in real mode. Mock mode never consults this flag at all —
   * mock models are not real, so there is nothing to probe. Set to `false` to skip probing
   * (e.g. when the caller has already validated the roster out of band).
   */
  validateModels?: boolean
}

export interface ValidateRosterOptions {
  /** `false` skips validation entirely — no client calls are made. Defaults to true. */
  validateModels?: boolean
  /** Bounded concurrency for the probe pool. Defaults to 4. */
  concurrency?: number
}

/**
 * Pre-flight checks every distinct (model, role) pair a run will actually use, so an
 * unusable model fails loudly before any agent runs or money is spent, instead of dying
 * mid-round with an opaque provider error.
 *
 * Distinct by (modelId, role): the same model listed under several roster entries is
 * probed once for the 'worker' role, but a model that is both a roster worker and the
 * judge is probed once per role, because capability differs by role (a model can answer
 * as a worker yet fail to produce structured output as a judge or reflector).
 */
export async function validateRosterModels(
  client: OpenCodeClient,
  directory: string,
  config: RunConfig,
  opts: ValidateRosterOptions = {},
): Promise<void> {
  if (opts.validateModels === false) return

  const seen = new Set<string>()
  const probes: { modelId: string; role: ModelRole }[] = []
  const addProbe = (modelId: string, role: ModelRole) => {
    const key = `${modelId} ${role}`
    if (seen.has(key)) return
    seen.add(key)
    probes.push({ modelId, role })
  }
  for (const entry of config.roster) addProbe(entry.modelId, 'worker')
  addProbe(config.judge.modelId, 'judge')
  addProbe(config.reflect.modelId, 'reflect')

  const results = await runPool(probes, opts.concurrency ?? 4, (p) =>
    validateModel(client, directory, p.modelId, p.role),
  )

  const validations = results.map((r, i) =>
    r.ok
      ? r.value
      : {
          modelId: probes[i]!.modelId,
          role: probes[i]!.role,
          ok: false as const,
          reason: r.error.message,
        },
  )

  const { unusable } = summarizeValidation(validations)
  if (unusable.length > 0) {
    const lines = unusable.map((u) => `  - ${u.modelId} as ${u.role}: ${u.reason}`).join('\n')
    throw new Error(
      `Model validation failed before the run started — ${unusable.length} model/role pair(s) unusable:\n${lines}`,
    )
  }
}

export interface CliOutput {
  rounds: { idx: number; meanScore: number; bestScore: number; metaDigest: string }[]
  winner: { label: string; strategyMd: string; score: number }
}

// Verified callable against a live `opencode serve` on 2026-08-24 — see
// docs/superpowers/specs/2026-08-24-opencode-api-spike.md. These are the real-mode
// fallbacks used when the caller does not pass --worker-models/--judge-model/--reflect-model.
//
// DEFAULT_CONFIG.judge.modelId and DEFAULT_CONFIG.reflect.modelId now agree with these
// (DEFAULT_CONFIG.judge.modelId used to be `wandb/moonshotai/Kimi-K3`, which the spike
// confirmed 404s — see the "Judge default" fix in the design doc). They are kept as
// separate, explicit constants anyway so real mode's fallback never silently drifts if
// DEFAULT_CONFIG changes later for reasons unrelated to model validity — pre-flight
// validation in `validateRosterModels` below is the real backstop either way.
const DEFAULT_REAL_WORKER_MODEL = 'opencode/big-pickle'
const DEFAULT_REAL_JUDGE_MODEL = 'wandb/zai-org/GLM-5.2'
const DEFAULT_REAL_REFLECT_MODEL = 'wandb/deepseek-ai/DeepSeek-V4-Flash'

/** Spreads `population` agents as evenly as possible across the given model ids. */
function buildRoster(modelIds: string[], population: number, temperature: number): RosterEntry[] {
  const base = Math.floor(population / modelIds.length)
  let remainder = population % modelIds.length
  return modelIds.map((modelId) => {
    const count = base + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder--
    return { modelId, count, temperature }
  })
}

interface RealDeps {
  server: ServerHandle
  sandbox: Sandbox
  provider: Provider
  runner: AgentRunner
}

async function buildRealDeps(opts: CliOptions, config: RunConfig): Promise<RealDeps> {
  if (!opts.workspaceRoot) {
    throw new Error('real mode requires workspaceRoot')
  }
  const server = opts.serverUrl
    ? await attachServer(opts.serverUrl, config.agentTimeoutMs)
    : await startServer({ timeoutMs: config.agentTimeoutMs })

  const sandbox = new LocalSandbox(opts.workspaceRoot)
  const provider = new OpenCodeProvider(server.client, opts.workspaceRoot, {
    timeoutMs: config.agentTimeoutMs,
  })
  return {
    server,
    sandbox,
    provider,
    runner: new OpenCodeAgentRunner(server.client, sandbox),
  }
}

export async function runTournamentCli(opts: CliOptions): Promise<CliOutput> {
  const db = openDb(opts.dbPath)
  const repos = makeRepos(db)
  const mode = opts.mode ?? 'mock'

  // Stops whatever server buildRealDeps started/attached to. Undefined in mock mode,
  // where there is no process to stop. Declared outside the try so the finally below
  // can still reach it if validation (or anything else after buildRealDeps) throws.
  let stopServer: (() => Promise<void>) | undefined

  try {
    let config: RunConfig
    let sandbox: Sandbox
    let provider: Provider
    let runner: AgentRunner

    if (mode === 'real') {
      const workerModels =
        opts.workerModels && opts.workerModels.length > 0 ? opts.workerModels : [DEFAULT_REAL_WORKER_MODEL]
      config = {
        ...DEFAULT_CONFIG,
        populationSize: opts.population,
        sandbox: 'local',
        roster: buildRoster(workerModels, opts.population, 0.7),
        judge: { ...DEFAULT_CONFIG.judge, modelId: opts.judgeModel ?? DEFAULT_REAL_JUDGE_MODEL },
        reflect: { ...DEFAULT_CONFIG.reflect, modelId: opts.reflectModel ?? DEFAULT_REAL_REFLECT_MODEL },
      }

      const built = await buildRealDeps(opts, config)
      sandbox = built.sandbox
      provider = built.provider
      runner = built.runner
      stopServer = built.server.stop

      // Pre-flight: fail fast and legibly before any agent runs or money is spent,
      // rather than mid-round with an opaque provider error. Mock mode never reaches
      // this branch at all, so it never probes anything.
      await validateRosterModels(built.server.client, opts.workspaceRoot!, config, {
        validateModels: opts.validateModels,
      })
    } else {
      config = {
        ...DEFAULT_CONFIG,
        populationSize: opts.population,
        sandbox: 'mock',
        roster: [{ modelId: 'mock/model', count: opts.population, temperature: 0.7 }],
      }
      provider = new MockProvider(opts.seed)
      sandbox = new MockSandbox()
      runner = new MockAgentRunner(sandbox, opts.seed)
    }

    const engine = new TournamentEngine({
      repos,
      config,
      sandbox,
      runner,
      judge: new Judge(provider, config.judge, opts.seed),
      // Derived from the roster, never hardcoded, in BOTH modes: Reflector silently
      // falls back to the current model for any model_id outside this list, so a
      // hardcoded array would reject every legitimate model the moment a real roster
      // is supplied — and would do so without raising anything.
      reflector: new Reflector(provider, config.reflect, config.roster.map((r) => r.modelId)),
      // Each agent starts from a different keyword so imitation has something real to
      // transfer. Uniform seeds leave nothing to imitate and the curve stays flat.
      seedStrategy: (i) =>
        `attempt the goal, variant ${i}, focus on ${GOOD_KEYWORDS[i % GOOD_KEYWORDS.length]}`,
    })

    const run = engine.createRun('cli', opts.goal)
    const rounds: CliOutput['rounds'] = []
    let finalRoundId: string | null = null
    let finalRoundIdx = 0

    for (let i = 0; i < opts.rounds; i++) {
      const r = await engine.runRound(run.id, { goalMd: opts.goal, criteriaMd: opts.criteria })
      const scores = repos.scores.forRound(r.roundId)
      const values = scores.map((s) => s.score)
      finalRoundId = r.roundId
      finalRoundIdx = r.roundIdx
      rounds.push({
        idx: r.roundIdx,
        meanScore: values.reduce((a, b) => a + b, 0) / values.length,
        bestScore: Math.max(...values),
        metaDigest: r.metaDigest,
      })
    }

    // The winner is the rank-1 agent of the final round. Scanning `listActive` for the
    // first agent that happens to have a genome returns whoever sorts first by label,
    // which is an arbitrary competitor rather than the one that won.
    const champion = finalRoundId ? repos.scores.forRound(finalRoundId)[0] : undefined
    const championAgent = champion
      ? repos.agents.listActive(run.id).find((a) => a.id === champion.agentId)
      : undefined
    const championGenome = champion
      ? repos.genomes.forRound(champion.agentId, finalRoundIdx)
      : null

    return {
      rounds,
      winner: {
        label: championAgent?.label ?? '',
        strategyMd: championGenome?.strategyMd ?? '',
        score: champion?.score ?? 0,
      },
    }
  } finally {
    // A failed run (thrown from createRun/runRound) must not leak the opencode
    // process — this must run whether the try block returns or throws.
    if (stopServer) await stopServer()
  }
}

// `file://${process.argv[1]}` never matches on Windows: argv[1] is a backslash path
// and import.meta.url is a percent-encoded file URL, so the CLI would silently
// print nothing. pathToFileURL normalizes both sides.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      goal: { type: 'string', default: 'Produce the best possible answer.' },
      rounds: { type: 'string', default: '5' },
      population: { type: 'string', default: '20' },
      seed: { type: 'string', default: '42' },
      db: { type: 'string', default: ':memory:' },
      mode: { type: 'string', default: 'mock' },
      workspace: { type: 'string' },
      server: { type: 'string' },
      'judge-model': { type: 'string' },
      'reflect-model': { type: 'string' },
      'worker-models': { type: 'string' },
      'no-validate-models': { type: 'boolean', default: false },
    },
  })

  const out = await runTournamentCli({
    goal: values.goal!,
    rounds: Number(values.rounds),
    population: Number(values.population),
    seed: Number(values.seed),
    dbPath: values.db!,
    criteria: null,
    mode: values.mode === 'real' ? 'real' : 'mock',
    workspaceRoot: values.workspace,
    serverUrl: values.server,
    judgeModel: values['judge-model'],
    reflectModel: values['reflect-model'],
    workerModels: values['worker-models']
      ? values['worker-models'].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined,
    validateModels: values['no-validate-models'] ? false : undefined,
  })

  console.log(`\nGoal: ${values.goal}\n`)
  for (const r of out.rounds) {
    console.log(`Round ${r.idx}: mean ${r.meanScore.toFixed(2)}  best ${r.bestScore.toFixed(2)}`)
  }
  console.log(`\nWinning strategy (${out.winner.label}):\n${out.winner.strategyMd}\n`)
}
