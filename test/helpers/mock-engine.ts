import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { makeRng } from '../../src/core/rng.js'
import { DEFAULT_CONFIG, type RunConfig } from '../../src/core/types.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import { Judge, type JudgeInput, type JudgeOutput } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { GOOD_KEYWORDS, MockProvider } from '../../src/runtime/mock-provider.js'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'
import type { AgentHandle, ProvisionOpts, Sandbox } from '../../src/runtime/sandbox.js'
import { MockAgentRunner, type AgentRunner } from '../../src/runtime/agent-runner.js'

/**
 * A runner that never settles. Stands in for a real `AgentRunner` that ignores or
 * mishandles its own `timeoutMs`, so the driver's timeout guarantee is exercised
 * rather than the runner's.
 */
class HangingRunner implements AgentRunner {
  async run(): Promise<never> {
    return new Promise(() => {})
  }
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
}) {
  const db = openDb(':memory:')
  const repos = makeRepos(db)

  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: opts.populationSize,
    sandbox: 'mock',
    concurrency: 4,
    // Keep the round short when nothing will ever come back from the runner.
    agentTimeoutMs: opts.hangingRunner ? 50 : DEFAULT_CONFIG.agentTimeoutMs,
    roster: [{
      modelId: 'mock/model',
      count: opts.rosterMismatch ? opts.populationSize + 1 : opts.populationSize,
      temperature: 0.7,
    }],
  }

  const provider = new MockProvider(opts.seed)
  const sandbox: Sandbox = opts.failProvisionFor !== undefined
    ? withFailProvision(new MockSandbox(), opts.failProvisionFor)
    : new MockSandbox()
  const judge = opts.scrambleRanks
    ? new ScrambledJudge(provider, config.judge, opts.seed, opts.seed + 1000)
    : new Judge(provider, config.judge, opts.seed)

  const reflector = new Reflector(provider, config.reflect, ['mock/model'])

  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner: opts.hangingRunner ? new HangingRunner() : new MockAgentRunner(sandbox, opts.seed),
    judge,
    reflector,
    // Each agent starts with a DIFFERENT keyword so imitation has something real
    // to transfer between agents. Uniform keyword-free seeds left nothing to
    // imitate, which made the evolution test pass for the wrong reason.
    seedStrategy: (i) =>
      opts.failFirst && i === 0
        ? '__FAIL__'
        : `attempt the goal, variant ${i}, focus on ${GOOD_KEYWORDS[i % GOOD_KEYWORDS.length]}`,
  })

  // Exposed (not just wired into the engine) so a test can spy on `reflect` and
  // inspect exactly what each call was given — e.g. to assert self-exclusion from
  // topPerformers, which the engine's public API does not otherwise reveal.
  return { db, repos, engine, config, sandbox, reflector }
}
