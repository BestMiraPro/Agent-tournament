import { resolve as resolvePath } from 'node:path'
import { describeFailure, describeProviderError, errorTextFor, failureFromText } from '../../core/failure.js'
import { serializeGenome } from '../../core/genome.js'
import type { QuiesceStatus } from '../../engine/capture.js'
import type { AgentRunContext, AgentRunner, AgentRunResult } from '../agent-runner.js'
import type { AgentHandle, Sandbox } from '../sandbox.js'
import { OpenCodeTimeoutError, type OpenCodeClient } from './client.js'
import { splitModelId } from './model-id.js'

export const SUBMISSION_FILE = 'SUBMISSION.md'

/** The profile PREPARE writes to `.opencode/agents/competitor.md`; OpenCode names agents by file. */
export const COMPETITOR_AGENT = 'competitor'

/** Resolves which OpenCode server (client) serves a given agent's shard. */
export type ClientResolver = (handle: AgentHandle) => OpenCodeClient

export interface AgentRunnerOptions {
  /**
   * Fired the instant a session exists, so a live dashboard can map OpenCode's
   * sessionID-keyed events onto agents. It cannot wait for AgentRunResult: by then
   * every event for this agent has already been emitted and dropped.
   */
  onSessionCreated?: (agentId: string, sessionId: string) => void
  /**
   * Why the runtime serving this handle cannot resolve `modelId`, or null when it can or
   * nobody knows. Consulted before any session exists, so a model the runtime lacks fails
   * as itself instead of as an OpenCode 500 after a session and a prompt.
   */
  modelUnavailable?: (handle: AgentHandle, modelId: string) => string | null
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
  /** Retained until BOTH local return and confirmed remote termination. */
  private live = new Map<string, LiveRun>()

  constructor(
    client: OpenCodeClient | ClientResolver,
    private sandbox: Sandbox,
    private options: AgentRunnerOptions = {},
  ) {
    this.resolve = typeof client === 'function' ? client : () => client
  }

  /** Once per round, before a new roster can reuse any shared shard or workspace. */
  assertReadyForRound(): void {
    if (this.live.size > 0) {
      throw new Error('previous round is still active or remote termination is unconfirmed')
    }
  }

  /** Per-invocation guard permits unrelated workers within the admitted round. */
  private assertAvailable(agentId: string, workspacePath: string): void {
    for (const run of this.live.values()) {
      if (run.agentId === agentId || workspaceKey(run.directory) === workspaceKey(workspacePath)) {
        throw new Error(`agent ${run.agentId} is still active or remote termination is unconfirmed`)
      }
    }
  }

  /** Abort acknowledgement is not termination evidence; the entire wait is bounded. */
  async quiesce(handle: AgentHandle): Promise<QuiesceStatus> {
    const run = this.live.get(handle.agentId)
    if (run === undefined) return 'stopped'
    run.stopRequested = true
    // Cancellation closes prompt admission even if session creation returns later.
    if (!run.promptDispatched) this.confirmStopped(run)
    if (run.remoteStopped) return 'stopped'
    this.requestAbort(run)

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        run.stopped.then((): QuiesceStatus => 'stopped'),
        new Promise<QuiesceStatus>((resolve) => {
          timer = setTimeout(() => resolve('unconfirmed'), QUIESCE_GRACE_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stop the snapshot concurrently; uncertainty must survive this cleanup attempt. */
  async abortAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((run) =>
      this.quiesce({ agentId: run.agentId, workspacePath: run.directory, baseUrl: '' }),
    ))
  }

  private requestAbort(run: LiveRun): void {
    if (run.sessionId === null || run.remoteStopped || run.abortRequested) return
    run.abortRequested = true
    const sessionId = run.sessionId
    // Neither run's timeout nor quiesce's grace depends on this request settling.
    void Promise.resolve().then(() => run.client.abort(sessionId, run.directory)).catch(() => {})
  }

  private confirmStopped(run: LiveRun): void {
    run.remoteStopped = true
    run.settleStopped()
    this.forgetStopped(run)
  }

  private forgetStopped(run: LiveRun): void {
    if (run.remoteStopped && run.localReturned && this.live.get(run.agentId) === run) {
      this.live.delete(run.agentId)
    }
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    if (ctx.agentId !== handle.agentId) throw new Error('agent context does not match handle')
    this.assertAvailable(handle.agentId, handle.workspacePath)
    const started = Date.now()
    const zero = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costUsd: 0 }

    let unavailable: string | null = null
    try {
      unavailable = this.options.modelUnavailable?.(handle, ctx.genome.modelId) ?? null
    } catch {
      /* a broken check must not fail a worker the runtime might serve */
    }
    if (unavailable !== null) {
      // Nothing is tracked or dispatched, so the zero usage below is observed, not assumed.
      const failure = failureFromText(unavailable, 'MODEL_UNAVAILABLE')
      return { status: 'error', errorText: failure.message, failure, ...zero, durationMs: Date.now() - started }
    }

    const client = this.resolve(handle)

    let settle = (): void => {}
    const tracked: LiveRun = {
      agentId: handle.agentId,
      client,
      sessionId: null,
      directory: handle.workspacePath,
      promptDispatched: false,
      stopRequested: false,
      abortRequested: false,
      remoteStopped: false,
      localReturned: false,
      stopped: new Promise<void>((resolve) => {
        settle = resolve
      }),
      settleStopped: () => settle(),
    }
    this.live.set(ctx.agentId, tracked)

    try {
      const session = await client.createSession(handle.workspacePath, `agent-${ctx.agentId}`)
      tracked.sessionId = session.id
      try {
        this.options.onSessionCreated?.(ctx.agentId, session.id)
      } catch {
        /* a dashboard subscriber must never break an agent's run */
      }
      if (tracked.stopRequested) throw new Error('agent stopped before prompt dispatch')

      const body = {
        model: splitModelId(ctx.genome.modelId),
        // Named explicitly: without it OpenCode runs its implicit `build` agent and the
        // profile's temperature and unattended permission policy never apply.
        agent: COMPETITOR_AGENT,
        system: ctx.genome.strategyMd,
        parts: [{ type: 'text' as const, text: buildAgentPrompt(ctx.goalMd) }],
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        tracked.promptDispatched = true
        // Keep this handler attached to the original request after a local timeout.
        // Transport rejection cannot confirm stop; a resolved terminal response can.
        const prompt = client.prompt(session.id, handle.workspacePath, body, ctx.timeoutMs).then((res) => {
          // HTTP success with missing/malformed JSON is not a terminal prompt result.
          if (!res || !res.info || typeof res.info !== 'object' || Array.isArray(res.info)) {
            throw new Error('invalid OpenCode prompt response')
          }
          this.confirmStopped(tracked)
          return res
        })
        const res = await Promise.race([
          prompt,
          new Promise<never>((_r, reject) => {
            timer = setTimeout(() => reject(new TimeoutError()), ctx.timeoutMs)
          }),
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
            failure: describeProviderError({
              name: res.info.error.name,
              statusCode: res.info.error.data?.statusCode,
              message: res.info.error.data?.message,
            }),
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
      } finally {
        // Without this the loser of the race keeps a timer alive for the full
        // timeoutMs after every run, holding the process open.
        clearTimeout(timer)
      }
    } catch (e) {
      const isTimeout = e instanceof TimeoutError || e instanceof OpenCodeTimeoutError
      if (tracked.promptDispatched) this.requestAbort(tracked)
      return {
        status: isTimeout ? 'timeout' : 'error',
        // errorTextFor keeps the transport cause that String(e) dropped, so a reopened run
        // can still tell a headers timeout from a refused connection.
        errorText: isTimeout ? `agent exceeded ${ctx.timeoutMs}ms` : errorTextFor(e),
        failure: e instanceof TimeoutError
          ? { message: `Agent exceeded ${ctx.timeoutMs}ms`, code: 'AGENT_TIMEOUT' }
          : describeFailure(e),
        // No terminal response arrived, so these zeros are placeholders, not observed usage.
        usageKnown: false,
        ...zero,
        durationMs: Date.now() - started,
      }
    } finally {
      if (!tracked.promptDispatched) this.confirmStopped(tracked)
      tracked.localReturned = true
      this.forgetStopped(tracked)
    }
  }
}

interface LiveRun {
  agentId: string
  client: OpenCodeClient
  sessionId: string | null
  directory: string
  promptDispatched: boolean
  stopRequested: boolean
  abortRequested: boolean
  remoteStopped: boolean
  localReturned: boolean
  stopped: Promise<void>
  settleStopped: () => void
}

/** Lexical aliases only; filesystem links are a separate sandbox responsibility. */
function workspaceKey(directory: string): string {
  const absolute = resolvePath(directory)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Total grace for confirmed termination, including any abort request time. */
export const QUIESCE_GRACE_MS = 10_000

class TimeoutError extends Error {
  constructor() {
    super('agent run timed out')
  }
}

export { serializeGenome }
