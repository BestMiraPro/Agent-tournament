import { resolve as resolvePath } from 'node:path'
import { describeFailure, describeProviderError, errorTextFor, failureFromText, type AgentFailure } from '../../core/failure.js'
import { serializeGenome } from '../../core/genome.js'
import type { QuiesceStatus } from '../../engine/capture.js'
import { deadlineTimer, type AgentRunContext, type AgentRunner, type AgentRunResult } from '../agent-runner.js'
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
  /**
   * Where the run's read-only context folder is, as the agent sees it: `/context` inside a
   * Docker shard, the host path for a local run. Null or absent when the run has none.
   */
  contextPath?: string | null
  /** The container path of TOOLS.md when the runtime provides a tool manifest; null otherwise. */
  toolsPath?: string | null
  /**
   * The runtime's own evidence that an agent failed because of a resource limit — an OOM kill
   * recorded by the daemon — or null when there is none. Consulted only for runs that ended
   * without a response, and bounded, so a slow daemon cannot hold a failed run open.
   */
  resourceFailure?: (handle: AgentHandle) => Promise<AgentFailure | null>
  /**
   * Authoritative evidence of what an old worker's ORIGINAL container is doing,
   * resolved against the handle's immutable runtime identity — never the current
   * plan's reusable container name. Consulted only while remote termination is
   * otherwise unconfirmed; a `stopped` answer confirms it.
   */
  runtimeState?: (handle: AgentHandle) => Promise<'running' | 'stopped' | 'unknown'>
}

/** How long a failed run waits for resource evidence before keeping its own failure. */
export const RESOURCE_DIAGNOSIS_MS = 10_000

/** What a still-working agent is told once its steering time has passed. */
export function buildSteeringPrompt(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / 60_000)
  const elapsed = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`
  return [
    `You have been working for ${elapsed}. Time to submit.`,
    `Do not start anything new. Write your final answer to ${SUBMISSION_FILE} now with what you have,`,
    'saying plainly what is finished and what is not, then stop.',
  ].join('\n')
}

/** The contract every agent is held to; the judged artifact is SUBMISSION.md. */
export function buildAgentPrompt(
  goalMd: string,
  contextPath: string | null = null,
  toolsPath: string | null = null,
): string {
  return [
    'GOAL:',
    goalMd,
    '',
    ...(contextPath
      ? [`Reference material (read-only) is in ${contextPath}. Read what is relevant before you start; you cannot change it.`, '']
      : []),
    ...(toolsPath
      ? [`The tools already installed here are listed in ${toolsPath}. Read it before you install or set anything up.`, '']
      : []),
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
  async assertReadyForRound(): Promise<void> {
    for (const run of [...this.live.values()]) {
      await this.reconcile(run)
      // Reconciling may have forgotten this invocation; only a retained one blocks.
      if (this.live.get(run.agentId) !== run) continue
      throw new Error(this.blockReason(run))
    }
  }

  /**
   * Confirms a retained invocation against authoritative runtime evidence.
   *
   * Terminal-response and session-status evidence keep working exactly as before —
   * this only adds the runtime check for invocations they left unconfirmed. The
   * invocation is forgotten only once BOTH remote termination and local return
   * hold; anything else keeps refusing.
   */
  private async reconcile(run: LiveRun): Promise<void> {
    if (run.remoteStopped) return
    const check = this.options.runtimeState
    if (!check) return
    let state: 'running' | 'stopped' | 'unknown'
    try {
      state = await check({ ...run.handle })
    } catch {
      state = 'unknown'
    }
    run.runtime = state
    if (state === 'stopped') this.confirmStopped(run)
  }

  /**
   * Why one retained invocation blocks the next round: the blocking agent, with
   * the concrete distinction between a locally pending invocation, a still
   * running original container, and runtime evidence that could not be read.
   */
  private blockReason(run: LiveRun): string {
    const who = `agent ${run.agentId}`
    if (!run.localReturned) {
      return `${who}: previous invocation has not returned locally — remote termination is unconfirmed`
    }
    const id = run.handle.runtimeId ? ` ${shortRuntimeId(run.handle.runtimeId)}` : ''
    if (run.runtime === 'running') {
      return `${who}: original container${id} is still running — remote termination is unconfirmed`
    }
    if (this.options.runtimeState) {
      return `${who}: Docker could not establish whether the original container${id} stopped — remote termination is unconfirmed`
    }
    return 'previous round is still active or remote termination is unconfirmed'
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
    // An OOM-killed worker takes its server with it: the status watch below would
    // poll an unreachable endpoint until the grace expires. Runtime evidence
    // answers now instead of depending on that server eventually answering.
    await this.reconcile(run)
    if (run.remoteStopped) return 'stopped'
    this.requestAbort(run)

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const status = await Promise.race([
        run.stopped.then((): QuiesceStatus => 'stopped'),
        new Promise<QuiesceStatus>((resolve) => {
          timer = setTimeout(() => resolve('unconfirmed'), QUIESCE_GRACE_MS)
        }),
      ])
      if (status === 'stopped') return 'stopped'
      await this.reconcile(run)
      return run.remoteStopped ? 'stopped' : 'unconfirmed'
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

  /**
   * A container killed for its memory limit takes its OpenCode server with it, and the agent
   * sees only a dropped connection. With daemon evidence the failure says what happened; without
   * it, the runner's own failure stands.
   */
  private async withResourceDiagnosis(handle: AgentHandle, result: AgentRunResult): Promise<AgentRunResult> {
    const diagnose = this.options.resourceFailure
    if (!diagnose) return result
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure: AgentFailure | null = null
    try {
      failure = await Promise.race([
        diagnose(handle),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RESOURCE_DIAGNOSIS_MS) }),
      ])
    } catch {
      failure = null
    } finally {
      clearTimeout(timer)
    }
    if (!failure) return result
    return { ...result, status: 'error', errorText: failure.message.slice(0, 500), failure }
  }

  private requestAbort(run: LiveRun): void {
    if (run.sessionId === null || run.remoteStopped || run.abortRequested) return
    run.abortRequested = true
    const sessionId = run.sessionId
    // Neither run's timeout nor quiesce's grace depends on this request settling.
    void Promise.resolve()
      .then(() => run.client.abort(sessionId, run.directory))
      .catch(() => {})
      .then(() => this.watchForStop(run, sessionId))
  }

  /**
   * After an abort, asks the server until it reports the session no longer working.
   *
   * An abort acknowledgement is not termination evidence, and a timed-out prompt never comes
   * back to confirm anything: the client cancels its own request at the same deadline. Without
   * this the run stayed "unconfirmed" forever and every later round was refused until restart.
   * The server's own status is positive evidence; an unreadable status confirms nothing, and the
   * watch gives up after STOP_WATCH_MS, leaving the run unconfirmed as before.
   */
  private async watchForStop(run: LiveRun, sessionId: string): Promise<void> {
    // A client that cannot report status (an injected stub) leaves the run unconfirmed, as before.
    if (typeof run.client.sessionStatus !== 'function') return
    const deadline = Date.now() + STOP_WATCH_MS
    while (!run.remoteStopped && Date.now() < deadline) {
      const status = await Promise.resolve()
        .then(() => run.client.sessionStatus(sessionId, run.directory))
        .catch(() => 'unknown' as const)
      if (run.remoteStopped) return
      if (status === 'idle') {
        this.confirmStopped(run)
        return
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, STOP_POLL_MS)
        ;(t as { unref?: () => void }).unref?.()
      })
    }
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
      // The invocation's own runtime identity, frozen now: later rounds replan
      // and reprovision, so resolving termination later must use this copy —
      // never the current shard plan, roster, or a reusable container name.
      handle: { ...handle },
      runtime: null,
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
        parts: [{ type: 'text' as const, text: buildAgentPrompt(ctx.goalMd, this.options.contextPath ?? null, this.options.toolsPath ?? null) }],
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      let steerTimer: ReturnType<typeof setTimeout> | undefined
      try {
        tracked.promptDispatched = true
        // Past the steering time the agent is told, not cut off: the message queues behind its
        // current step and it decides how to wrap up. Sent once; a failed send is not retried.
        steerTimer = deadlineTimer(ctx.steerAfterMs ?? Infinity, () => {
          if (tracked.remoteStopped || tracked.stopRequested) return
          void Promise.resolve()
            .then(() => client.promptAsync(session.id, handle.workspacePath, {
              model: body.model,
              agent: body.agent,
              system: body.system,
              parts: [{ type: 'text', text: buildSteeringPrompt(ctx.steerAfterMs!) }],
            }))
            .catch(() => {})
        })
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
            timer = deadlineTimer(ctx.timeoutMs, () => reject(new TimeoutError()))
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
        clearTimeout(steerTimer)
      }
    } catch (e) {
      const isTimeout = e instanceof TimeoutError || e instanceof OpenCodeTimeoutError
      if (tracked.promptDispatched) this.requestAbort(tracked)
      return await this.withResourceDiagnosis(handle, {
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
      })
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
  /** Copy of the handle this invocation was dispatched with; see `run`. */
  handle: AgentHandle
  /**
   * Last runtime-state answer for this invocation, for the refusal message.
   * Null until the callback is consulted — and it stays null when no callback
   * is configured, which keeps the legacy refusal text for those runners.
   */
  runtime: 'running' | 'stopped' | 'unknown' | null
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

/** Docker's short-ID convention for naming a container in a message. */
function shortRuntimeId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

/** Total grace for confirmed termination, including any abort request time. */
export const QUIESCE_GRACE_MS = 10_000

/** How long after an abort the server's session status is polled for a stop. */
export const STOP_WATCH_MS = 5 * 60_000
export const STOP_POLL_MS = 1_000

class TimeoutError extends Error {
  constructor() {
    super('agent run timed out')
  }
}

export { serializeGenome }
