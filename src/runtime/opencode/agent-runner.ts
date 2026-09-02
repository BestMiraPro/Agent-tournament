import { serializeGenome } from '../../core/genome.js'
import type { QuiesceStatus } from '../../engine/capture.js'
import type { AgentRunContext, AgentRunner, AgentRunResult } from '../agent-runner.js'
import type { AgentHandle, Sandbox } from '../sandbox.js'
import type { OpenCodeClient } from './client.js'
import { splitModelId } from './model-id.js'

export const SUBMISSION_FILE = 'SUBMISSION.md'

/** Resolves which OpenCode server (client) serves a given agent's shard. */
export type ClientResolver = (handle: AgentHandle) => OpenCodeClient

export interface AgentRunnerOptions {
  /**
   * Fired the instant a session exists, so a live dashboard can map OpenCode's
   * sessionID-keyed events onto agents. It cannot wait for AgentRunResult: by then
   * every event for this agent has already been emitted and dropped.
   */
  onSessionCreated?: (agentId: string, sessionId: string) => void
}

/** The contract every agent is held to; the judged artifact is SUBMISSION.md. */
export function buildAgentPrompt(goalMd: string): string {
  return [
    'GOAL:',
    goalMd,
    '',
    `When you are finished, write your final answer to ${SUBMISSION_FILE} in your working directory.`,
    'Anything else you create is supporting evidence. Only ' + SUBMISSION_FILE + ' is judged.',
  ].join('\n')
}

/**
 * Runs one agent as a real OpenCode session.
 *
 * The evolving strategy is injected via the prompt's `system` field rather than an agent
 * config file: it needs no config reload, and the agent can neither read nor overwrite it.
 * The genome is also written to `.opencode/agents/competitor.md` as a human-readable
 * artifact and for Phase 3 parity.
 */
export class OpenCodeAgentRunner implements AgentRunner {
  private resolve: ClientResolver
  /** Runs that have not returned yet, so `quiesce` knows what is still executing. */
  private live = new Map<string, LiveRun>()

  constructor(
    client: OpenCodeClient | ClientResolver,
    private sandbox: Sandbox,
    private options: AgentRunnerOptions = {},
  ) {
    this.resolve = typeof client === 'function' ? client : () => client
  }

  /**
   * Aborts this agent's session and waits for its run to actually come back.
   *
   * The abort acknowledgement alone is not proof: it says the server accepted the
   * request, not that the session's last tool call has finished writing. The run
   * promise settling is the evidence, so that is what is waited on — and when it does
   * not settle in time the answer is `unconfirmed`, never a silent `stopped`.
   */
  async quiesce(handle: AgentHandle): Promise<QuiesceStatus> {
    const run = this.live.get(handle.agentId)
    // Absent means `run` already returned, which is the strongest confirmation there is.
    if (run === undefined) return 'stopped'

    if (run.sessionId !== null) {
      // A failed abort is not decisive either way; settlement below still rules.
      await run.client.abort(run.sessionId, run.directory).catch(() => {})
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        run.done.then((): QuiesceStatus => 'stopped'),
        new Promise<QuiesceStatus>((resolve) => {
          timer = setTimeout(() => resolve('unconfirmed'), QUIESCE_GRACE_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    const started = Date.now()
    const zero = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0 }
    const client = this.resolve(handle)

    let settle = (): void => {}
    const tracked: LiveRun = {
      client,
      sessionId: null,
      directory: handle.workspacePath,
      done: new Promise<void>((resolve) => {
        settle = resolve
      }),
    }
    this.live.set(ctx.agentId, tracked)

    let sessionId: string | null = null
    try {
      const session = await client.createSession(handle.workspacePath, `agent-${ctx.agentId}`)
      sessionId = session.id
      tracked.sessionId = session.id
      try {
        this.options.onSessionCreated?.(ctx.agentId, session.id)
      } catch {
        /* a dashboard subscriber must never break an agent's run */
      }

      const res = await Promise.race([
        client.prompt(
          session.id,
          handle.workspacePath,
          {
            model: splitModelId(ctx.genome.modelId),
            system: ctx.genome.strategyMd,
            parts: [{ type: 'text', text: buildAgentPrompt(ctx.goalMd) }],
          },
          ctx.timeoutMs,
        ),
        new Promise<never>((_r, reject) =>
          setTimeout(() => reject(new TimeoutError()), ctx.timeoutMs),
        ),
      ])

      const t = res.info?.tokens
      const usage = {
        tokensIn: t?.input ?? 0,
        tokensOut: t?.output ?? 0,
        tokensCacheRead: t?.cache?.read ?? 0,
        tokensCacheWrite: t?.cache?.write ?? 0,
        costUsd: res.info?.cost ?? 0,
      }

      if (res.info?.error) {
        const code = res.info.error.data?.statusCode ?? res.info.error.name ?? 'error'
        return {
          status: 'error',
          errorText: `${code}: ${res.info.error.data?.message ?? ''}`.slice(0, 500),
          ...usage,
          durationMs: Date.now() - started,
        }
      }

      const submission = await this.sandbox.readFile(handle, SUBMISSION_FILE)
      return {
        status: submission && submission.trim().length > 0 ? 'ok' : 'no_submission',
        errorText: null,
        ...usage,
        durationMs: Date.now() - started,
      }
    } catch (e) {
      const isTimeout = e instanceof TimeoutError
      if (isTimeout && sessionId) {
        await client.abort(sessionId, handle.workspacePath).catch(() => {})
      }
      return {
        status: isTimeout ? 'timeout' : 'error',
        errorText: isTimeout ? `agent exceeded ${ctx.timeoutMs}ms` : String(e).slice(0, 500),
        ...zero,
        durationMs: Date.now() - started,
      }
    } finally {
      // Only reached once nothing else in this method can run, which is exactly the
      // condition `quiesce` reports as `stopped`.
      this.live.delete(ctx.agentId)
      settle()
    }
  }
}

interface LiveRun {
  client: OpenCodeClient
  sessionId: string | null
  directory: string
  done: Promise<void>
}

/** How long `quiesce` waits for an aborted run to come back before giving up on it. */
export const QUIESCE_GRACE_MS = 10_000

class TimeoutError extends Error {
  constructor() {
    super('agent run timed out')
  }
}

export { serializeGenome }
