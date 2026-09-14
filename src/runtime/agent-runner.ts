import type { AgentFailure } from '../core/failure.js'
import type { Genome, SubmissionStatus } from '../core/types.js'
import type { QuiesceStatus } from '../engine/capture.js'
import { trueFitness } from './mock-provider.js'
import type { AgentHandle, Sandbox } from './sandbox.js'

export interface AgentRunContext {
  agentId: string
  genome: Genome
  goalMd: string
  timeoutMs: number
}

export interface AgentRunResult {
  status: SubmissionStatus
  errorText: string | null
  /** Structured, publishable reason for a non-ok status; `errorText` stays the stored text. */
  failure?: AgentFailure
  /**
   * False when the token/cost fields are placeholders because nothing reported them — a
   * lost response, a timeout. Absent or true means they are real, including a real zero.
   */
  usageKnown?: boolean
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  costUsd: number
  durationMs: number
}

export interface AgentRunner {
  run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult>
  /** Before PREPARE, reject while any prior invocation (including culled agents) remains live. */
  assertReadyForRound?(): void
  /**
   * Attempts to abort every tracked session; retain unconfirmed execution evidence.
   *
   * WHY session-level abort exists: it bounds the 4d-cooperative tail — queued agents
   * stop, live sessions abort here, and only an in-flight JUDGE call still finishes
   * (no provider-level abort primitive exists for it).
   */
  abortAll(): Promise<void>
  /**
   * Stop this agent and resolve once it is confirmed to have stopped executing.
   *
   * Optional so a runner without it still works, but the driver may not certify a
   * workspace captured from a runner it cannot stop: `run` returning only means the
   * orchestrator stopped waiting, not that the agent stopped writing.
   */
  quiesce?(handle: AgentHandle): Promise<QuiesceStatus>
}

/**
 * Simulates a tool-using agent by writing a SUBMISSION.md whose embedded
 * FITNESS value is derived from the strategy. The judge later reads that value,
 * which closes the loop: better strategies produce better submissions.
 */
export class MockAgentRunner implements AgentRunner {
  constructor(private sandbox: Sandbox, private seed: number) {}
  /** In-flight agent ids, so `abortAll` can name what it stopped. */
  private inFlight = new Set<string>()
  /** Every in-flight id `abortAll` has stopped, in order — for tests to assert on. */
  readonly abortedIds: string[] = []

  /** Everything this runner does is awaited inside `run`, so it is already stopped. */
  async quiesce(): Promise<QuiesceStatus> {
    return 'stopped'
  }

  async abortAll(): Promise<void> {
    // The mock holds no real sessions: aborting is recording who was live, then
    // forgetting them. It does not have an independent remote execution lifetime.
    this.abortedIds.push(...this.inFlight)
    this.inFlight.clear()
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now()
    this.inFlight.add(ctx.agentId)
    try {
      return await this.execute(handle, ctx, started)
    } finally {
      this.inFlight.delete(ctx.agentId)
    }
  }

  private async execute(
    handle: AgentHandle,
    ctx: AgentRunContext,
    started: number,
  ): Promise<AgentRunResult> {
    if (ctx.genome.strategyMd.includes('__FAIL__')) {
      return {
        status: 'error',
        errorText: 'simulated agent failure',
        tokensIn: 100,
        tokensOut: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        costUsd: 0,
        durationMs: Date.now() - started,
      }
    }

    const fitness = trueFitness(ctx.genome.strategyMd)
    const body = [
      `# Submission`,
      ``,
      `Goal: ${ctx.goalMd}`,
      ``,
      `Approach: ${ctx.genome.strategyMd}`,
      ``,
      `FITNESS=${fitness.toFixed(2)}`,
    ].join('\n')

    await this.sandbox.writeFile(handle, 'SUBMISSION.md', body)

    return {
      status: 'ok',
      errorText: null,
      tokensIn: 500 + ctx.genome.strategyMd.length,
      tokensOut: body.length,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costUsd: 0,
      durationMs: Date.now() - started,
    }
  }
}
