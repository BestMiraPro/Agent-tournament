import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { makeRng } from '../../src/core/rng.js'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import type { EventSink } from '../../src/engine/events.js'
import { Judge, type JudgeInput, type JudgeOutput } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { GOOD_KEYWORDS, MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from '../../src/runtime/sandbox.js'
import { MockAgentRunner, type AgentRunner } from '../../src/runtime/agent-runner.js'
import type { AgentRunContext, AgentRunResult } from '../../src/runtime/agent-runner.js'
import { SUBMISSION_FILE, type QuiesceStatus } from '../../src/engine/capture.js'

/** Strategy markers, in the style of `__FAIL__`, so a behaviour follows one seed index. */
export const FLOOD_MARKER = '__FLOOD__'
export const SABOTAGE_MARKER = '__SABOTAGE__'
export const HUGE_TOKENS_MARKER = '__HUGE_TOKENS__'
/**
 * Reported tokensIn for an agent marked with HUGE_TOKENS_MARKER. Comfortably past every
 * DEFAULT_CONFIG budget ceiling (agent 200k, round 1M) from a single agent's usage, so a
 * breach test needs neither a huge population nor many rounds to trip one.
 */
export const HUGE_TOKENS = 2_000_000
/** How many files the flooding agent writes; must exceed FLOOD_QUOTA_FILES. */
export const FLOOD_FILE_COUNT = 40
/** The quota a flood test runs under. Far below the real default purely for speed. */
export const FLOOD_QUOTA_FILES = 25
/** What a saboteur overwrites a rival's submission with. */
export const SABOTAGED_TEXT = '# Submission\n\nFITNESS=0.01\n'

/**
 * Wraps a runner so that a marked agent flooded its workspace, or overwrote a rival's
 * submission, by the time its own run returns.
 *
 * The saboteur writes into the victim's workspace *after* the victim's run finished and
 * was captured — the exact window a shared container leaves open, and the one the driver
 * has to make uncertifiable.
 */
class MischiefRunner implements AgentRunner {
  /**
   * Left undefined when the runner is meant to be unstoppable, standing in for a runner
   * the driver has no way to halt — which must cost it the right to certify a capture.
   */
  quiesce?: () => Promise<QuiesceStatus>

  constructor(
    private inner: AgentRunner,
    private sandbox: Sandbox,
    private provisionOrder: string[],
    quiesceable: boolean,
  ) {
    if (quiesceable) this.quiesce = async () => 'stopped'
  }

  // Sessions are the inner mock's business; aborting delegates to it.
  async abortAll(): Promise<void> {
    await this.inner.abortAll()
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const res = await this.inner.run(handle, ctx)

    if (ctx.genome.strategyMd.includes(FLOOD_MARKER)) {
      for (let i = 0; i < FLOOD_FILE_COUNT; i++) {
        await this.sandbox.writeFile(handle, `junk/${i}.txt`, 'x')
      }
    }

    if (ctx.genome.strategyMd.includes(SABOTAGE_MARKER)) {
      const victim = this.provisionOrder.find((id) => id !== ctx.agentId)
      if (victim !== undefined) {
        await this.sandbox.writeFile(
          { agentId: victim, workspacePath: `/mock/${victim}`, baseUrl: `mock://${victim}` },
          'SUBMISSION.md',
          SABOTAGED_TEXT,
        )
      }
    }
    return res
  }
}

/**
 * Wraps a runner so a marked agent reports a huge token count once its run returns,
 * without needing thousands of real agents or rounds to accumulate that much spend.
 * Mirrors `MischiefRunner`'s shape: delegate the real run, then distort the result for
 * the one agent carrying the marker.
 */
class HugeTokensRunner implements AgentRunner {
  quiesce?: (handle: AgentHandle) => Promise<QuiesceStatus>

  constructor(private inner: AgentRunner) {
    if (inner.quiesce) this.quiesce = (h) => this.inner.quiesce!(h)
  }

  async abortAll(): Promise<void> {
    await this.inner.abortAll()
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const res = await this.inner.run(handle, ctx)
    if (ctx.genome.strategyMd.includes(HUGE_TOKENS_MARKER)) {
      return { ...res, tokensIn: HUGE_TOKENS, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }
    }
    return res
  }
}

/** Records the order agents are provisioned in, so a saboteur can find a rival. */
function withProvisionOrder(sandbox: Sandbox, order: string[]): Sandbox {
  return {
    ...delegate(sandbox),
    provision: async (agentId: string, opts: ProvisionOpts) => {
      if (!order.includes(agentId)) order.push(agentId)
      return sandbox.provision(agentId, opts)
    },
  }
}

/**
 * Substitutes a rival's submission in the instant BEFORE the orchestrator's capture read
 * lands — the TOCTOU window itself, rather than the easier window after the capture.
 *
 * Nothing in the round reads SUBMISSION.md before the capture does (the runner only
 * writes it), so intercepting the first read puts the substitution exactly where a live
 * co-tenant's write would fall: too late for the victim to notice, too early for any
 * later re-read to distinguish from the victim's own work.
 */
function withCaptureRaceSabotage(sandbox: Sandbox, order: string[]): Sandbox {
  const done = new Set<string>()
  return {
    ...withProvisionOrder(sandbox, order),
    readFile: async (h: AgentHandle, relPath: string) => {
      if (relPath === SUBMISSION_FILE && h.agentId === order[0] && !done.has(h.agentId)) {
        done.add(h.agentId)
        await sandbox.writeFile(h, SUBMISSION_FILE, SABOTAGED_TEXT)
      }
      return sandbox.readFile(h, relPath)
    },
  }
}

/** A sandbox giving every agent a workspace no other agent can reach. */
function withIsolatedWorkspaces(sandbox: Sandbox): Sandbox {
  return Object.assign(delegate(sandbox), { isolatedWorkspace: () => true })
}

function delegate(sandbox: Sandbox): Sandbox {
  return {
    provision: (agentId: string, opts: ProvisionOpts) => sandbox.provision(agentId, opts),
    reset: (h: AgentHandle, opts: ProvisionOpts) => sandbox.reset(h, opts),
    writeFile: (h: AgentHandle, relPath: string, content: string) =>
      sandbox.writeFile(h, relPath, content),
    readFile: (h: AgentHandle, relPath: string) => sandbox.readFile(h, relPath),
    listFiles: (h: AgentHandle) => sandbox.listFiles(h),
    endpoint: (h: AgentHandle) => sandbox.endpoint(h),
    teardown: (h: AgentHandle) => sandbox.teardown(h),
  }
}

/**
 * A runner that never settles. Stands in for a real `AgentRunner` that ignores or
 * mishandles its own `timeoutMs`, so the driver's timeout guarantee is exercised
 * rather than the runner's.
 */
class HangingRunner implements AgentRunner {
  async run(): Promise<never> {
    return new Promise(() => {})
  }

  // Tracks nothing, so there is nothing to abort — the driver's own timeout ends these.
  async abortAll(): Promise<void> {}
}

/**
 * Judges normally, then randomly reassigns which agent occupies which rank/score
 * slot. The score values still reflect the real submissions, but they are attached
 * to the wrong agents, so selection and reflection act on noise instead of fitness.
 *
 * This exists so the evolution test can prove improvement comes from the fitness
 * signal rather than from the loop merely running. Subclassing (rather than a plain
 * wrapper object) is required because `Judge` has private fields and is therefore
 * nominally typed.
 */
class ScrambledJudge extends Judge {
  private scrambleSeed: number

  constructor(
    provider: MockProvider,
    cfg: RunConfig['judge'],
    seed: number,
    scrambleSeed: number,
  ) {
    super(provider, cfg, seed)
    this.scrambleSeed = scrambleSeed
  }

  override async score(
    goalMd: string,
    criteriaMd: string,
    inputs: readonly JudgeInput[],
  ): Promise<JudgeOutput> {
    const out = await super.score(goalMd, criteriaMd, inputs)
    const rng = makeRng(this.scrambleSeed + inputs.length)
    // `out.scores` is already rank-ordered; keep the slots, shuffle the occupants.
    const agentIds = rng.shuffle(out.scores.map((s) => s.agentId))
    return {
      ...out,
      scores: out.scores.map((slot, i) => ({
        agentId: agentIds[i]!,
        rank: slot.rank,
        score: slot.score,
        rationaleMd: slot.rationaleMd,
      })),
    }
  }
}

/**
 * Wraps a sandbox so that `provision` throws for the agent at the given ordinal
 * position — the Nth distinct agentId it is ever asked to provision, zero-indexed.
 * Stands in for a real provisioning failure (port exhaustion, image pull, OOM)
 * without needing Docker, so PREPARE's failure-isolation can be exercised.
 */
function withFailProvision(sandbox: Sandbox, failIndex: number): Sandbox {
  const seen = new Set<string>()
  let ordinal = -1
  return {
    provision: async (agentId: string, opts: ProvisionOpts) => {
      if (!seen.has(agentId)) {
        seen.add(agentId)
        ordinal++
        if (ordinal === failIndex) {
          throw new Error(`simulated provisioning failure for agent at index ${failIndex}`)
        }
      }
      return sandbox.provision(agentId, opts)
    },
    reset: (h: AgentHandle, opts: ProvisionOpts) => sandbox.reset(h, opts),
    writeFile: (h: AgentHandle, relPath: string, content: string) => sandbox.writeFile(h, relPath, content),
    readFile: (h: AgentHandle, relPath: string) => sandbox.readFile(h, relPath),
    listFiles: (h: AgentHandle) => sandbox.listFiles(h),
    endpoint: (h: AgentHandle) => sandbox.endpoint(h),
    teardown: (h: AgentHandle) => sandbox.teardown(h),
  }
}

export function makeMockEngine(opts: {
  seed: number
  populationSize: number
  failFirst?: boolean
  /** Destroy the fitness signal by permuting ranks after judging. */
  scrambleRanks?: boolean
  /** Install a runner that never returns, so only the driver can end the round. */
  hangingRunner?: boolean
  /** Build a roster whose counts do not sum to `populationSize`. */
  rosterMismatch?: boolean
  /** Make sandbox.provision throw for the agent at this ordinal (zero-indexed). */
  failProvisionFor?: number
  /** Make the agent at this seed index write more files than the quota allows. */
  floodFilesFor?: number
  /**
   * Make the agent at this seed index overwrite the FIRST agent's submission once its
   * own run returns — i.e. after that agent finished and was captured. Forces
   * concurrency 1 so the ordering is a fact rather than a race.
   */
  sabotageBy?: number
  /** Give the saboteur no way to be stopped, so nothing in the round is certifiable. */
  unstoppableSaboteur?: boolean
  /**
   * Substitute the first agent's submission during its capture read rather than after
   * it, so the recorded bytes are the rival's from the outset.
   */
  sabotageDuringCapture?: boolean
  /** Give each agent a workspace no co-tenant can reach, as one-agent-per-container does. */
  isolatedWorkspaces?: boolean
  /** Make the agent at this seed index report HUGE_TOKENS on completion, for exercising
   *  budget enforcement without needing a huge population or many rounds. */
  hugeTokensFor?: number
  /** Subscribe to engine events emitted during the run, for testing the event sink. */
  onEvent?: EventSink
  /** Prepare the exact active population before the round provisions agents. */
  preparePopulation?: (agentIds: readonly string[]) => Promise<void>
}) {
  const db = openDb(':memory:')
  const repos = makeRepos(db)

  const sabotaging = opts.sabotageBy !== undefined
  const racing = opts.sabotageDuringCapture === true

  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: opts.populationSize,
    sandbox: 'mock',
    // One at a time makes "the victim was already captured" an ordering guarantee
    // instead of a timing assumption. Budget tests get the same treatment: with the
    // pool otherwise dispatching all of a small population in one synchronous burst,
    // "later agents were skipped once the budget tripped" would be a race rather than
    // a fact.
    concurrency: sabotaging || racing || opts.hugeTokensFor !== undefined ? 1 : 4,
    // The real default is 2000 files, which is deliberately generous; a flood test that
    // wrote 2001 files would only be slower, not more truthful.
    maxWorkspaceFiles:
      opts.floodFilesFor !== undefined ? FLOOD_QUOTA_FILES : DEFAULT_CONFIG.maxWorkspaceFiles,
    // Keep the round short when nothing will ever come back from the runner.
    agentTimeoutMs: opts.hangingRunner ? 50 : DEFAULT_CONFIG.agentTimeoutMs,
    roster: [{
      modelId: 'mock/model',
      count: opts.rosterMismatch ? opts.populationSize + 1 : opts.populationSize,
      temperature: 0.7,
    }],
  }

  const provider = new MockProvider(opts.seed)
  const provisionOrder: string[] = []
  let sandbox: Sandbox = opts.failProvisionFor !== undefined
    ? withFailProvision(new MockSandbox(), opts.failProvisionFor)
    : new MockSandbox()
  if (racing) sandbox = withCaptureRaceSabotage(sandbox, provisionOrder)
  else if (sabotaging) sandbox = withProvisionOrder(sandbox, provisionOrder)
  if (opts.isolatedWorkspaces) sandbox = withIsolatedWorkspaces(sandbox)
  const judge = opts.scrambleRanks
    ? new ScrambledJudge(provider, config.judge, opts.seed, opts.seed + 1000)
    : new Judge(provider, config.judge, opts.seed)

  const reflector = new Reflector(provider, config.reflect, ['mock/model'])

  const mockRunner = new MockAgentRunner(sandbox, opts.seed)
  const runner: AgentRunner = opts.hangingRunner
    ? new HangingRunner()
    : opts.floodFilesFor !== undefined || sabotaging
      ? new MischiefRunner(mockRunner, sandbox, provisionOrder, !opts.unstoppableSaboteur)
      : opts.hugeTokensFor !== undefined
        ? new HugeTokensRunner(mockRunner)
        : mockRunner

  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner,
    judge,
    reflector,
    // Each agent starts with a DIFFERENT keyword so imitation has something real
    // to transfer between agents. Uniform keyword-free seeds left nothing to
    // imitate, which made the evolution test pass for the wrong reason.
    seedStrategy: (i) => {
      const base = `attempt the goal, variant ${i}, focus on ${GOOD_KEYWORDS[i % GOOD_KEYWORDS.length]}`
      if (opts.failFirst && i === 0) return '__FAIL__'
      if (opts.floodFilesFor === i) return `${FLOOD_MARKER} ${base}`
      if (opts.sabotageBy === i) return `${SABOTAGE_MARKER} ${base}`
      if (opts.hugeTokensFor === i) return `${HUGE_TOKENS_MARKER} ${base}`
      return base
    },
    onEvent: opts.onEvent,
    preparePopulation: opts.preparePopulation,
  })

  // Exposed (not just wired into the engine) so a test can spy on `reflect` and
  // inspect exactly what each call was given — e.g. to assert self-exclusion from
  // topPerformers, which the engine's public API does not otherwise reveal.
  return { db, repos, engine, config, sandbox, reflector, judge }
}
