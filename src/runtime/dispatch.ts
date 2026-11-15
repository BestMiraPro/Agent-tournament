import type { QuiesceStatus } from '../engine/capture.js'
import type { AgentRunContext, AgentRunner, AgentRunResult } from './agent-runner.js'
import { isClaudeSubscriptionModel } from './claude-code/model-id.js'
import type { CompleteRequest, Provider } from './provider.js'
import type { AgentHandle } from './sandbox.js'

/**
 * Routes each agent to the runner that serves its model: `claude-subscription/*` to Claude Code,
 * everything else to OpenCode. A roster may mix both. The runner of an agent's latest attempt owns
 * it for quiesce and `send`; round admission and aborts consult both.
 */
export class DispatchingAgentRunner implements AgentRunner {
  private owner = new Map<string, AgentRunner>()

  constructor(private routes: { claude: AgentRunner; other: AgentRunner }) {}

  private runners(): AgentRunner[] {
    return [this.routes.other, this.routes.claude]
  }

  runnerFor(modelId: string): AgentRunner {
    return isClaudeSubscriptionModel(modelId) ? this.routes.claude : this.routes.other
  }

  run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const runner = this.runnerFor(ctx.genome.modelId)
    this.owner.set(handle.agentId, runner)
    return runner.run(handle, ctx)
  }

  async assertReadyForRound(): Promise<void> {
    for (const runner of this.runners()) await runner.assertReadyForRound?.()
  }

  async abortAll(): Promise<void> {
    await Promise.all(this.runners().map((r) => r.abortAll()))
  }

  async quiesce(handle: AgentHandle): Promise<QuiesceStatus> {
    const runner = this.owner.get(handle.agentId)
    if (!runner) return 'stopped'
    return runner.quiesce ? runner.quiesce(handle) : 'unsupported'
  }

  async send(handle: AgentHandle, text: string): Promise<boolean> {
    const runner = this.owner.get(handle.agentId)
    return runner?.send ? runner.send(handle, text) : false
  }
}

/** The same routing for judge, reflect, criteria and review calls. */
export class RoutingProvider implements Provider {
  constructor(private routes: { claude: Provider; other: Provider }) {}

  private pick(modelId: string): Provider {
    return isClaudeSubscriptionModel(modelId) ? this.routes.claude : this.routes.other
  }

  complete(req: CompleteRequest): Promise<string> {
    return this.pick(req.modelId).complete(req)
  }

  async completeRich(req: CompleteRequest): Promise<{ text: string; reasoning: string | null }> {
    const target = this.pick(req.modelId)
    if (target.completeRich) return target.completeRich(req)
    return { text: await target.complete(req), reasoning: null }
  }

  describe(modelId?: string): string {
    const target = modelId !== undefined ? this.pick(modelId) : this.routes.other
    return target.describe?.(modelId) ?? 'unknown'
  }
}
