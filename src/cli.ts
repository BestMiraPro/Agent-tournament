import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, type RosterEntry, type RunConfig } from './core/types.js'
import { openDb } from './db/open.js'
import { makeRepos } from './db/repos.js'
import { recoverIncompleteRounds } from './db/recover.js'
import { TournamentEngine } from './engine/driver.js'
import { defaultSeedStrategy } from './engine/seed-strategy.js'
import { Reflector } from './evolution/reflect.js'
import { Judge } from './judge/judge.js'
import { MockAgentRunner, type AgentRunner } from './runtime/agent-runner.js'
import { GOOD_KEYWORDS, MockProvider } from './runtime/mock-provider.js'
import { MockSandbox } from './runtime/mock-sandbox.js'
import {
  planCapacity,
  readHostCapacity,
  type CapacityLedger,
  type HostCapacity,
} from './runtime/docker/capacity.js'
import { parseMemoryLimit } from './core/memory.js'
import { sweepOrphanContainers, type SweepOptions } from './runtime/docker/sweep.js'
import type { Provider } from './runtime/provider.js'
import { runPool } from './runtime/pool.js'
import type { AgentHandle, Sandbox } from './runtime/sandbox.js'
import { type ClientResolver } from './runtime/opencode/agent-runner.js'
import { validateModel, summarizeValidation, type ModelRole } from './runtime/opencode/capability.js'
import { OpenCodeClient } from './runtime/opencode/client.js'
import { type ServerHandle } from './runtime/opencode/server.js'
import { composeRun } from './server/compose-run.js'

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

/**
 * The two Docker startup probes, injectable so the startup path can be tested without a
 * daemon. The repo's convention elsewhere is a defaulted `run: DockerFn` parameter, but
 * these two are reached through `runTournamentCli` rather than called directly, so they
 * are grouped into one seam that the CLI threads down.
 */
export interface DockerStartupHooks {
  readCapacity: () => Promise<HostCapacity>
  sweep: (opts: SweepOptions) => Promise<string[]>
}

export const REAL_DOCKER_STARTUP: DockerStartupHooks = {
  readCapacity: readHostCapacity,
  sweep: sweepOrphanContainers,
}

/**
 * Refuses a run whose container plan would overcommit the host.
 *
 * `planCapacity` has existed since the Task 11 preflight but nothing called it, so the
 * guardrail was inert: an operator asking for more containers than the host can hold got
 * a machine that swapped itself to a standstill, or agents OOM-killed mid-round and
 * recorded as agent failures rather than the infrastructure failure they are. This is the
 * call that makes it bite.
 *
 * A failure to *read* capacity refuses a protected run: "safe to start" cannot be claimed
 * about a host nobody measured. A shared run keeps the older policy — the daemon may not
 * expose `info`/`stats` on every host — and warns and proceeds.
 *
 * With a ledger, admission is checked against every other reservation in this process and
 * recorded under `reservationId`; the caller releases it.
 */
export async function assertHostCapacity(
  config: RunConfig,
  read: () => Promise<HostCapacity> = readHostCapacity,
  onWarning: (message: string) => void = (m) => console.warn(m),
  opts: {
    ledger?: CapacityLedger
    reservationId?: string
    /** Per-container ceilings of trusted companions (a protected shard's gateway), added to each container's. */
    extraMemoryBytes?: number
    extraCpus?: number
  } = {},
): Promise<void> {
  let host: HostCapacity
  try {
    host = await read()
  } catch (e) {
    if (config.isolation === 'protected') {
      throw new Error(
        `docker sandbox: host capacity could not be read, so a protected run cannot be admitted (${(e as Error).message}). ` +
          'Start Docker Desktop and try again, or choose shared isolation to start without this check.',
      )
    }
    onWarning(
      `Could not read host capacity, so the overcommit preflight was skipped: ` +
        `${(e as Error).message}`,
    )
    return
  }

  // Check the containers this run will ACTUALLY start, not the configured ceiling.
  // `planShards` clamps shard count to the population, so a 2-agent run never starts
  // more than 2 containers however high `maxContainers` is. Validating the ceiling
  // instead refuses runs that would have fit comfortably.
  const containers = Math.max(1, Math.min(config.maxContainers, config.populationSize))

  const verdict = opts.ledger && opts.reservationId
    ? opts.ledger.admit(
        opts.reservationId,
        {
          containers,
          memoryBytes: parseMemoryLimit(config.containerMemory) + (opts.extraMemoryBytes ?? 0),
          cpus: config.containerCpus + (opts.extraCpus ?? 0),
        },
        host,
      )
    : planCapacity(
        {
          containers,
          memory: config.containerMemory,
          cpus: config.containerCpus,
        },
        host,
      )
  if (!verdict.ok) {
    throw new Error(`docker sandbox: ${verdict.reason}`)
  }
}

/**
 * Runs the startup orphan sweep for a docker run, and nothing at all otherwise.
 *
 * Extracted from `runTournamentCli` so the call site's contract is directly testable: the
 * rail that matters here is that the *live* run id reaches `sweepOrphanContainers`, and
 * the CLI path that would exercise it in place needs a real daemon to get that far.
 *
 * Never throws. A sweep is opportunistic cleanup of a previous run's mess; failing to
 * clean up must not stop this run from starting.
 */
export async function sweepBeforeRun(
  config: RunConfig,
  runId: string,
  hooks: DockerStartupHooks,
  onWarning: (message: string) => void = (m) => console.warn(m),
): Promise<string[]> {
  if (config.sandbox !== 'docker') return []
  try {
    return await hooks.sweep({ activeRunIds: [runId], onWarning })
  } catch (e) {
    onWarning(`Orphan container sweep failed: ${(e as Error).message}`)
    return []
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
  hooks: DockerStartupHooks,
): Promise<RealDeps> {
  if (!opts.workspaceRoot) {
    throw new Error('real mode requires workspaceRoot')
  }

  // composeRun owns capacity/server/image/sandbox/runner composition now, so the CLI
  // and the dashboard validate, cap, and warn identically. Seams are chosen for zero
  // behavior change versus the inlined body this replaced:
  // - validation stays in runTournamentCli below (real validateRosterModels, with the
  //   caller's validateModels flag), so this passes a no-op to avoid probing twice;
  // - the orphan sweep stays in runTournamentCli below, after createRun hands us the
  //   live run id to exclude — so this passes a no-op sweep and the pending-id sweep
  //   inside composeRun cleans nothing.
  // - reportWarning prints each warning as it happens (capacity, container start/stop),
  //   including ones that fire during rounds — a post-hoc replay would miss those.
  //
  // The holder is passed through, so containers are named arena-<liveRunId>-<shard> the
  // same way the dashboard names them. Discarding it left CLI containers called
  // arena-pending-<timestamp>-<shard>, which makes a name useless as ownership evidence:
  // a sweep excludes live runs BY RUN ID, so no other orchestrator could ever match a
  // pending-timestamp name against a run it knows is alive. Passing the holder also
  // suppresses composeRun's own pending-id sweep, which is what this path wants — the CLI
  // sweeps itself after createRun, with the live id to exclude.
  if (config.sandbox === 'docker' && !opts.authFile) {
    console.warn(
      'docker sandbox: no --auth-file given, so agent containers start without provider ' +
        'credentials and every agent will fail on its first model call.',
    )
  }
  const composed = await composeRun(
    // Built literally from the caller's config, not via parseRunSpec: parseRunSpec
    // REFUSES docker-without-authFile, but the CLI contract is warn-and-continue
    // (test/cli.test.ts: 'the CLI refuses to start a docker run that would
    // overcommit the host' runs docker with no authFile and expects the capacity
    // refusal, not an auth refusal). Every field below is copied from config/opts,
    // so the composed config cannot drift from the caller's.
    {
      name: 'cli',
      goal: opts.goal,
      sandbox: resolveSandboxMode('real', opts.sandbox),
      roster: config.roster,
      population: config.populationSize,
      judge: { modelId: config.judge.modelId, mode: config.judge.mode },
      reflect: { modelId: config.reflect.modelId, topK: config.reflect.topK },
      selection: {
        eliteCount: config.selection.eliteCount,
        topPct: config.selection.topPct,
        bottomPct: config.selection.bottomPct,
        crossoverPct: config.selection.crossoverPct,
      },
      concurrency: config.concurrency,
      maxContainers: config.maxContainers,
      containerMemory: config.containerMemory,
      containerCpus: config.containerCpus,
      // The CLI keeps the placement it always had unless its config says otherwise.
      isolation: config.isolation ?? 'shared',
      pricing: { ...config.pricing },
      budget: {
        maxRunTokens: config.budget.maxRunTokens,
        maxRoundTokens: config.budget.maxRoundTokens,
        maxAgentTokens: config.budget.maxAgentTokens,
      },
      seedDir: config.seedDir,
      contextDir: null,
      workspaceRoot: opts.workspaceRoot,
      authFile: opts.authFile ?? null,
      serverUrl: opts.serverUrl ?? null,
      criteria: opts.criteria,
    },
    {
      readCapacity: hooks.readCapacity,
      sweepFn: async () => [],
      validateModels: async () => {},
    },
    { runIdHolder, reportWarning: (m) => console.warn(m) },
  )
  if (!composed.serverHandle) {
    throw new Error('composeRun returned no server for a real-mode run')
  }
  return {
    server: composed.serverHandle,
    sandbox: composed.sandbox,
    provider: composed.provider,
    runner: composed.runner,
    planFor: composed.planFor,
  }
}

export async function runTournamentCli(
  opts: CliOptions,
  hooks: DockerStartupHooks = REAL_DOCKER_STARTUP,
): Promise<CliOutput> {
  const db = openDb(opts.dbPath)
  const repos = makeRepos(db)
  const recovered = recoverIncompleteRounds(db)
  if (recovered > 0) console.warn(`recovered ${recovered} interrupted round(s)`)
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

      const built = await buildRealDeps(opts, config, runIdHolder, hooks)
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
      judge: new Judge(provider, config.judge, opts.seed, (message) => console.warn(message), {
        contextPath: config.contextDir ?? null,
      }),
      // Derived from the roster, never hardcoded, in BOTH modes: Reflector silently
      // falls back to the current model for any model_id outside this list, so a
      // hardcoded array would reject every legitimate model the moment a real roster
      // is supplied — and would do so without raising anything.
      reflector: new Reflector(provider, config.reflect, config.roster.map((r) => r.modelId)),
      // Each agent starts from a different keyword so imitation has something real to
      // transfer. Uniform seeds leave nothing to imitate and the curve stays flat.
      seedStrategy: defaultSeedStrategy,
      preparePopulation: planFor ?? undefined,
    })

    const run = engine.createRun('cli', opts.goal)
    runIdHolder.value = run.id
    disposeSandbox = () => engine.dispose(run.id)

    // Deliberately after createRun rather than at process start: the sweep's second safety
    // rail is that it never removes the live run's containers, and that requires a live run
    // id to exclude. Nothing has been provisioned yet — containers are started during the
    // first PREPARE inside runRound — so this is still before any container of ours exists,
    // which is the only window where a sweep is both useful and safe.
    //
    // It does mean the capacity preflight above counted any orphan's memory as used. That
    // errs toward refusing a run that would in fact have fit, which is the safe direction;
    // re-running once the sweep has freed the memory succeeds.
    const swept = await sweepBeforeRun(config, run.id, hooks)
    if (swept.length > 0) {
      console.warn(
        `Swept ${swept.length} stranded container(s) from previous runs: ${swept.join(', ')}`,
      )
    }

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

      // The round itself already completed and was scored — that work is paid for
      // either way — but starting another round on an already-blown budget would
      // just keep spending against a cap that has already tripped. Stop here.
      if (r.budgetBreach) {
        console.warn(`\nBudget breached in round ${r.roundIdx}: ${r.budgetBreach.reason}`)
        const status = engine.budgetStatus(run.id)
        if (status) {
          // A dollar figure is only meaningful for models this run actually knows the
          // price of — printing $0.00 when pricing is simply absent would read as "this
          // run was free," which is exactly the failure mode the budget exists to catch.
          const usdLine = status.unpricedModels.length > 0
            ? `USD spend unknown — no pricing for: ${status.unpricedModels.join(', ')}`
            : `$${status.runSpend.toFixed(4)} spent this run ($${status.roundSpend.toFixed(4)} this round)`
          console.warn(
            `Spent ${status.runTokens} tokens this run (${status.roundTokens} this round). ${usdLine}`,
          )
        }
        break
      }
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
