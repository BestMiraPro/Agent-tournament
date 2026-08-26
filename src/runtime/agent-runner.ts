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
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheWrite: number
  costUsd: number
  durationMs: number
}

export interface AgentRunner {
  run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult>
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

  /** Everything this runner does is awaited inside `run`, so it is already stopped. */
  async quiesce(): Promise<QuiesceStatus> {
    return 'stopped'
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now()

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
