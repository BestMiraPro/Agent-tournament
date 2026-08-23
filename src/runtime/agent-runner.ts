import type { Genome, SubmissionStatus } from '../core/types.js'
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
  durationMs: number
}

export interface AgentRunner {
  run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult>
}

/**
 * Simulates a tool-using agent by writing a SUBMISSION.md whose embedded
 * FITNESS value is derived from the strategy. The judge later reads that value,
 * which closes the loop: better strategies produce better submissions.
 */
export class MockAgentRunner implements AgentRunner {
  constructor(private sandbox: Sandbox, private seed: number) {}

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now()

    if (ctx.genome.strategyMd.includes('__FAIL__')) {
      return {
        status: 'error',
        errorText: 'simulated agent failure',
        tokensIn: 100,
        tokensOut: 0,
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
      durationMs: Date.now() - started,
    }
  }
}
