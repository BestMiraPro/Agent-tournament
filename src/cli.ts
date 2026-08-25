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
import { removeContainer } from './runtime/docker/cli.js'
import { startShardContainer } from './runtime/docker/container.js'
import { ensureImage } from './runtime/docker/image.js'
import { DockerSandbox } from './runtime/docker/sandbox.js'
import type { Provider } from './runtime/provider.js'
import { runPool } from './runtime/pool.js'
import type { AgentHandle, Sandbox } from './runtime/sandbox.js'
import { OpenCodeAgentRunner, type ClientResolver } from './runtime/opencode/agent-runner.js'
import { validateModel, summarizeValidation, type ModelRole } from './runtime/opencode/capability.js'
import { OpenCodeClient } from './runtime/opencode/client.js'
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
  /**
   * Which sandbox real mode runs agents in. `'local'` (the default) runs them as host
   * processes against one shared opencode server; `'docker'` runs them inside
   * resource-capped containers, sharded across at most `maxContainers` of them. Mock
   * mode ignores this entirely — it always uses MockSandbox.
   */
  sandbox?: 'local' | 'docker'
  workspaceRoot?: string
  /**
   * Host path to an opencode `auth.json`, bind-mounted read-only into every agent
   * container. Docker mode only. Without it the containers have no provider
   * credentials, so every agent fails on its first model call.
   */
  authFile?: string
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
  /**
   * Called with a human-readable message when some (but not all) worker models turn out
   * unusable. That is not fatal on its own — `runPool` already isolates per-agent
   * failures, so agents on a bad worker model just score 0, get culled in round 1, and
   * are replaced by clones of winners, since `modelId` is heritable. The population
   * self-heals as long as at least one worker model still works. Never called on a
   * fatal outcome (judge/reflect unusable, or every worker unusable), since those throw
   * instead.
   */
  onWarning?: (message: string) => void
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
 *
 * Severity depends on role, because the failure modes are not equivalent:
 *  - judge unusable is fatal — the round cannot be scored at all.
 *  - reflect unusable is fatal — reflection is the mutation operator; if it silently
 *    fails, genomes carry forward unchanged and evolution stops while the run keeps
 *    looking like it's working.
 *  - a worker unusable is NOT fatal by itself, as long as at least one worker model is
 *    usable: agents assigned to the bad model fail and get culled, and the heritable
 *    `modelId` means the population self-heals onto working models. Aborting the whole
 *    run over one transient/bad worker model would be wrong; instead these are reported
 *    through `onWarning`.
 *  - every worker model unusable IS fatal — no agent could produce anything, so the
 *    round would be meaningless.
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
  const unusableWorkers = unusable.filter((u) => u.role === 'worker')
  const unusableJudge = unusable.filter((u) => u.role === 'judge')
  const unusableReflect = unusable.filter((u) => u.role === 'reflect')

  const totalWorkers = probes.filter((p) => p.role === 'worker').length
  const allWorkersUnusable = totalWorkers > 0 && unusableWorkers.length === totalWorkers

  // Fatal: judge unusable, reflect unusable, or every worker unusable. When it's the
  // worker roster that made this fatal, the worker lines belong in the thrown message
  // too — that's the whole reason it's fatal.
  const fatal = [...unusableJudge, ...unusableReflect, ...(allWorkersUnusable ? unusableWorkers : [])]
  if (fatal.length > 0) {
    const lines = fatal.map((u) => `  - ${u.modelId} as ${u.role}: ${u.reason}`).join('\n')
    const explain = allWorkersUnusable
      ? '\nEvery worker model is unusable — no usable worker remains, so no agent could produce anything this round.'
      : ''
    throw new Error(
      `Model validation failed before the run started — ${fatal.length} model/role pair(s) unusable:\n${lines}${explain}`,
    )
  }

  // Non-fatal: some (but not all) worker models are unusable. Surface it instead of
  // aborting — agents on these models will fail and be culled, and the population
  // self-heals onto the working worker models.
  if (unusableWorkers.length > 0 && opts.onWarning) {
    const lines = unusableWorkers.map((u) => `  - ${u.modelId} as worker: ${u.reason}`).join('\n')
    opts.onWarning(
      `${unusableWorkers.length} worker model(s) unusable — agents assigned to them will fail and be culled:\n${lines}`,
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

/** The image every agent container runs. Built on demand from docker/Dockerfile.agent. */
export const AGENT_IMAGE = 'agent-arena:latest'

/**
 * Decides which sandbox a run actually uses.
 *
 * Mock mode ignores `--sandbox` completely: mock agents are pure functions, so there is
 * nothing to isolate and no server to talk to. Real mode defaults to `'local'` — the
 * Phase 2 behaviour — and only containerises when asked.
 *
 * An unrecognised value is a hard error rather than a fall back to `'local'`: `--sandbox`
 * arrives as an unvalidated string, and quietly downgrading a typo would run agent-authored
 * code directly on the host while the operator believed it was containerised.
 */
export function resolveSandboxMode(
  mode: 'mock' | 'real',
  sandbox: CliOptions['sandbox'],
): RunConfig['sandbox'] {
  if (mode === 'mock') return 'mock'
  const requested = sandbox ?? 'local'
  if (requested !== 'local' && requested !== 'docker') {
    throw new Error(`unknown sandbox "${requested}" — expected "local" or "docker"`)
  }
  return requested
}

/**
 * Builds the per-agent client lookup the OpenCode runner uses.
 *
 * Under Docker each shard has its own opencode server on its own published port, so the
 * single shared client of local mode is wrong — an agent would be prompted against another
 * shard's server, in a directory that does not exist there. The sandbox is the only thing
 * that knows the mapping, so `endpoint()` is the source of truth.
 *
 * Clients are cached per baseUrl, not per agent: every agent in a shard talks to the same
 * server, and a fresh client per agent would multiply connections by the population for no
 * benefit. An empty baseUrl means "no dedicated server" (LocalSandbox), so the shared
 * client is returned unchanged.
 */
export function makeClientResolver(
  sandbox: Sandbox,
  shared: OpenCodeClient,
  create: (baseUrl: string) => OpenCodeClient,
): ClientResolver {
  const byBaseUrl = new Map<string, OpenCodeClient>()
  return (handle: AgentHandle) => {
    const { baseUrl } = sandbox.endpoint(handle)
    if (!baseUrl) return shared
    let client = byBaseUrl.get(baseUrl)
    if (!client) {
      client = create(baseUrl)
      byBaseUrl.set(baseUrl, client)
    }
    return client
  }
}

interface RealDeps {
  server: ServerHandle
  sandbox: Sandbox
  provider: Provider
  runner: AgentRunner
  /**
   * Non-null under Docker only. DockerSandbox has to know the whole population before it
   * can shard it, but `Sandbox` has no such hook and the driver never calls one, so the
   * caller must plan each round before `runRound` provisions anything.
   */
  planFor: ((agentIds: readonly string[]) => Promise<void>) | null
}

/**
 * `runId` is only known after `engine.createRun`, which needs the engine, which needs the
 * sandbox — so it cannot be a constructor argument. It is read at container-start time
 * instead, which happens during the first PREPARE, long after the run row exists.
 */
interface RunIdHolder {
  value: string
}

async function buildRealDeps(
  opts: CliOptions,
  config: RunConfig,
  runIdHolder: RunIdHolder,
): Promise<RealDeps> {
  if (!opts.workspaceRoot) {
    throw new Error('real mode requires workspaceRoot')
  }
  const server = opts.serverUrl
    ? await attachServer(opts.serverUrl, config.agentTimeoutMs)
    : await startServer({ timeoutMs: config.agentTimeoutMs })

  // Judging and reflection always run on the host server, in both sandbox modes: they are
  // orchestrator work on collected text, not agent work, so they must never be exposed to
  // an agent-controlled container.
  const provider = new OpenCodeProvider(server.client, opts.workspaceRoot, {
    timeoutMs: config.agentTimeoutMs,
  })

  if (config.sandbox === 'docker') {
    const authFile = opts.authFile ?? null
    if (!authFile) {
      console.warn(
        'docker sandbox: no --auth-file given, so agent containers start without provider ' +
          'credentials and every agent will fail on its first model call.',
      )
    }

    await ensureImage(AGENT_IMAGE, process.cwd(), 'docker/Dockerfile.agent')

    const sandbox = new DockerSandbox({
      runId: runIdHolder.value,
      root: opts.workspaceRoot,
      maxContainers: config.maxContainers,
      image: AGENT_IMAGE,
      memory: config.containerMemory,
      cpus: config.containerCpus,
      authFile,
      startContainer: (shardIndex, hostDir) =>
        startShardContainer(
          {
            runId: runIdHolder.value,
            shardIndex,
            image: AGENT_IMAGE,
            hostDir,
            memory: config.containerMemory,
            cpus: config.containerCpus,
            authFile,
          },
          undefined,
          // A container is up long before opencode is listening inside it; prompting a
          // half-started server fails the agent for an infrastructure reason. The probe
          // timeout is short and independent of agentTimeoutMs — health either answers
          // in milliseconds or the container is broken.
          async (baseUrl) => new OpenCodeClient({ baseUrl, timeoutMs: 10_000 }).health(),
        ),
      stopContainer: async (name) => {
        await removeContainer(name)
      },
    })

    return {
      server,
      sandbox,
      provider,
      runner: new OpenCodeAgentRunner(
        makeClientResolver(
          sandbox,
          server.client,
          (baseUrl) => new OpenCodeClient({ baseUrl, timeoutMs: config.agentTimeoutMs }),
        ),
        sandbox,
      ),
      planFor: (agentIds) => sandbox.planFor(agentIds),
    }
  }

  const sandbox = new LocalSandbox(opts.workspaceRoot)
  return {
    server,
    sandbox,
    provider,
    runner: new OpenCodeAgentRunner(server.client, sandbox),
    planFor: null,
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
  // Releases sandbox resources — under Docker, the shard containers. Same reasoning:
  // a run that throws mid-round must not leave containers running.
  let disposeSandbox: (() => Promise<void>) | undefined

  try {
    let config: RunConfig
    let sandbox: Sandbox
    let provider: Provider
    let runner: AgentRunner
    let planFor: ((agentIds: readonly string[]) => Promise<void>) | null = null
    const runIdHolder: RunIdHolder = { value: '' }

    if (mode === 'real') {
      const workerModels =
        opts.workerModels && opts.workerModels.length > 0 ? opts.workerModels : [DEFAULT_REAL_WORKER_MODEL]
      config = {
        ...DEFAULT_CONFIG,
        populationSize: opts.population,
        sandbox: resolveSandboxMode('real', opts.sandbox),
        roster: buildRoster(workerModels, opts.population, 0.7),
        judge: { ...DEFAULT_CONFIG.judge, modelId: opts.judgeModel ?? DEFAULT_REAL_JUDGE_MODEL },
        reflect: { ...DEFAULT_CONFIG.reflect, modelId: opts.reflectModel ?? DEFAULT_REAL_REFLECT_MODEL },
      }

      const built = await buildRealDeps(opts, config, runIdHolder)
      sandbox = built.sandbox
      provider = built.provider
      runner = built.runner
      planFor = built.planFor
      stopServer = built.server.stop

      // Pre-flight: fail fast and legibly before any agent runs or money is spent,
      // rather than mid-round with an opaque provider error. Mock mode never reaches
      // this branch at all, so it never probes anything. Non-fatal worker warnings
      // (some, but not all, worker models unusable) are printed to stderr rather than
      // aborting — see validateRosterModels for why that's the right call.
      await validateRosterModels(built.server.client, opts.workspaceRoot!, config, {
        validateModels: opts.validateModels,
        onWarning: (message) => console.warn(message),
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
      judge: new Judge(provider, config.judge, opts.seed, (message) => console.warn(message)),
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
    runIdHolder.value = run.id
    disposeSandbox = () => engine.dispose(run.id)

    const rounds: CliOutput['rounds'] = []
    let finalRoundId: string | null = null
    let finalRoundIdx = 0

    for (let i = 0; i < opts.rounds; i++) {
      // Re-planned every round, not once: breeding retires and creates agents, so the
      // population that round N+1 provisions is not the one round N was sharded for, and
      // an agent missing from the plan cannot be provisioned at all.
      if (planFor) await planFor(repos.agents.listActive(run.id).map((a) => a.id))
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
    // process or any shard container — this must run whether the try block returns or
    // throws. Containers first: they are the expensive resource, and the host server is
    // unrelated to whether they stop cleanly.
    if (disposeSandbox) await disposeSandbox()
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
      sandbox: { type: 'string', default: 'local' },
      workspace: { type: 'string' },
      'auth-file': { type: 'string' },
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
    // Passed through unvalidated on purpose: resolveSandboxMode rejects anything it does
    // not recognise, so a typo fails loudly instead of silently running unsandboxed.
    sandbox: values.sandbox as CliOptions['sandbox'],
    workspaceRoot: values.workspace,
    authFile: values['auth-file'],
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
