import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { describeFailure, errorTextFor, failureFromText, type AgentFailure } from '../../core/failure.js'
import type { QuiesceStatus } from '../../engine/capture.js'
import type { ActivityItemInput, ActivityKind } from '../../engine/events.js'
import { deadlineTimer, type AgentRunContext, type AgentRunner, type AgentRunResult } from '../agent-runner.js'
import { buildAgentPrompt, buildSteeringPrompt, QUIESCE_GRACE_MS, STOP_POLL_MS, STOP_WATCH_MS, SUBMISSION_FILE } from '../opencode/agent-runner.js'
import type { AgentHandle, Sandbox } from '../sandbox.js'
import { competitorArgs } from './argv.js'
import { claudeEnvVars, type ClaudeCredentials } from './env.js'
import { claudeLimitGate, type SubscriptionLimitGate } from './limit-gate.js'
import { claudeModelOf } from './model-id.js'
import { ClaudeCliMissingError, type ClaudeLauncher, type ClaudeProcess } from './process.js'
import { CLAUDE_FAILURE_CODES, ClaudeStreamTranslator, classifyClaudeFailure, createJsonLineReader, type StreamEffect } from './stream.js'

/** One piece of activity, in the shape the OpenCode bridge emits it. */
export interface ClaudeActivity {
  kind: ActivityKind
  detail: string
  item: ActivityItemInput
}

export interface ClaudeCodeRunnerOptions {
  launcher: ClaudeLauncher
  /** The credentials for this attempt, read fresh each time so a replaced token takes effect. */
  credentials: (handle: AgentHandle) => Promise<ClaudeCredentials>
  /** `fd` for host processes; `env` for `docker exec`. */
  tokenTransport: 'fd' | 'env'
  /** A private CLI config folder for the attempt (token and relay modes), or null for the host's. */
  configDirFor?: (handle: AgentHandle, credentials: ClaudeCredentials) => Promise<string | null> | string | null
  /** Folders the agent may read but not change, as the CLI sees them. */
  readableDirs?: readonly string[]
  /** As `AgentRunnerOptions.contextPath` / `toolsPath`: named in the GOAL prompt. */
  contextPath?: string | null
  toolsPath?: string | null
  /** The CLI's session id, the instant it is known, so live activity keys like OpenCode's. */
  onSessionCreated?: (agentId: string, sessionId: string) => void
  onActivity?: (agentId: string, activity: ClaudeActivity) => void
  limitGate?: SubscriptionLimitGate
  /** As in the OpenCode runner: the original container's state, for termination evidence. */
  runtimeState?: (handle: AgentHandle) => Promise<'running' | 'stopped' | 'unknown'>
  /** As in the OpenCode runner: an OOM kill recorded by the daemon. */
  resourceFailure?: (handle: AgentHandle) => Promise<AgentFailure | null>
  newSessionId?: () => string
}

const ZERO_TOKENS = { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }
const STDOUT_DRAIN_MS = 5_000
const RESOURCE_DIAGNOSIS_MS = 10_000
const STDERR_TAIL = 4_000

interface LiveAttempt {
  agentId: string
  handle: AgentHandle
  directory: string
  proc: ClaudeProcess | null
  /** Stdin is open: the CLI still takes messages. */
  accepting: boolean
  stopRequested: boolean
  killRequested: boolean
  exited: boolean
  remoteStopped: boolean
  localReturned: boolean
  watching: boolean
  runtime: 'running' | 'stopped' | 'unknown' | null
  stopped: Promise<void>
  settleStopped: () => void
}

/**
 * Runs one agent as a headless Claude Code session on the owner's subscription.
 *
 * The strategy rides on `--append-system-prompt` (the agent cannot read or overwrite it as a file);
 * the GOAL is the first streamed user message, and later messages (the steering prompt, `send`)
 * reach the agent at its next tool boundary. Activity, usage and failures are translated into the
 * shapes the OpenCode path produces. An attempt is retained until it has both returned and been
 * confirmed stopped, exactly as in `OpenCodeAgentRunner`.
 */
export class ClaudeCodeAgentRunner implements AgentRunner {
  private live = new Map<string, LiveAttempt>()
  private gate: SubscriptionLimitGate

  constructor(private sandbox: Sandbox, private options: ClaudeCodeRunnerOptions) {
    this.gate = options.limitGate ?? claudeLimitGate
  }

  async assertReadyForRound(): Promise<void> {
    for (const run of [...this.live.values()]) {
      await this.reconcile(run)
      if (this.live.get(run.agentId) !== run) continue
      throw new Error(this.blockReason(run))
    }
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((run) => this.quiesce(run.handle)))
  }

  async quiesce(handle: AgentHandle): Promise<QuiesceStatus> {
    const run = this.live.get(handle.agentId)
    if (run === undefined) return 'stopped'
    run.stopRequested = true
    if (run.proc === null) this.confirmStopped(run)
    if (run.remoteStopped) return 'stopped'
    await this.reconcile(run)
    if (run.remoteStopped) return 'stopped'
    this.requestKill(run)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const status = await Promise.race([
        run.stopped.then((): QuiesceStatus => 'stopped'),
        new Promise<QuiesceStatus>((resolve) => { timer = setTimeout(() => resolve('unconfirmed'), QUIESCE_GRACE_MS) }),
      ])
      if (status === 'stopped') return 'stopped'
      await this.reconcile(run)
      return run.remoteStopped ? 'stopped' : 'unconfirmed'
    } finally {
      clearTimeout(timer)
    }
  }

  async send(handle: AgentHandle, text: string): Promise<void> {
    const run = this.live.get(handle.agentId)
    if (!run || !run.proc || !run.accepting) throw new Error(`agent ${handle.agentId} is not running`)
    await this.write(run, text)
  }

  async run(handle: AgentHandle, ctx: AgentRunContext): Promise<AgentRunResult> {
    if (ctx.agentId !== handle.agentId) throw new Error('agent context does not match handle')
    this.assertAvailable(handle.agentId, handle.workspacePath)
    const started = Date.now()
    // Nothing was dispatched in these early returns, so their zero usage is observed, not assumed.
    const refuse = (failure: AgentFailure): AgentRunResult => ({
      status: 'error', errorText: failure.message.slice(0, 500), failure, ...ZERO_TOKENS, costUsd: 0, durationMs: Date.now() - started,
    })

    const model = claudeModelOf(ctx.genome.modelId)
    if (model === null) {
      return refuse(failureFromText(`${ctx.genome.modelId} is not a valid Claude subscription model id`, CLAUDE_FAILURE_CODES.modelUnavailable))
    }
    const blocked = this.gate.blocked()
    if (blocked) return refuse(blocked)
    let credentials: ClaudeCredentials
    let configDir: string | null
    try {
      credentials = await this.options.credentials(handle)
    } catch (e) {
      return refuse({ code: CLAUDE_FAILURE_CODES.authExpired, message: (e as Error).message.slice(0, 300) })
    }
    try {
      configDir = (await this.options.configDirFor?.(handle, credentials)) ?? null
    } catch (e) {
      return refuse(failureFromText(`Could not prepare the Claude config folder: ${(e as Error).message}`, CLAUDE_FAILURE_CODES.error))
    }

    const sessionId = (this.options.newSessionId ?? randomUUID)()
    const args = competitorArgs({ model, strategy: ctx.genome.strategyMd, readableDirs: this.options.readableDirs ?? [], sessionId })
    const { settings, secrets } = claudeEnvVars({ credentials, tokenTransport: this.options.tokenTransport, configDir, model })

    let settle = (): void => {}
    const tracked: LiveAttempt = {
      agentId: handle.agentId,
      handle: { ...handle },
      directory: handle.workspacePath,
      proc: null,
      accepting: false,
      stopRequested: false,
      killRequested: false,
      exited: false,
      remoteStopped: false,
      localReturned: false,
      watching: false,
      runtime: null,
      stopped: new Promise<void>((resolve) => { settle = resolve }),
      settleStopped: () => settle(),
    }
    this.live.set(handle.agentId, tracked)

    const translator = new ClaudeStreamTranslator()
    let stderrTail = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let steerTimer: ReturnType<typeof setTimeout> | undefined
    try {
      let proc: ClaudeProcess
      try {
        proc = this.options.launcher.launch(handle, {
          args, settings, secrets, cwd: handle.workspacePath,
          key: `${handle.agentId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}-${sessionId.slice(0, 8)}`,
          ...(credentials.mode === 'token' && this.options.tokenTransport === 'fd' ? { token: credentials.token } : {}),
        })
      } catch (e) {
        return refuse(e instanceof ClaudeCliMissingError
          ? { code: CLAUDE_FAILURE_CODES.cliMissing, message: e.message.slice(0, 300) }
          : describeFailure(e))
      }
      tracked.proc = proc
      tracked.accepting = true
      this.watchExit(tracked)

      proc.stderr.on('data', (d: Buffer | string) => { stderrTail = (stderrTail + String(d)).slice(-STDERR_TAIL) })
      const stdoutDone = new Promise<void>((resolve) => {
        proc.stdout.once('end', () => resolve())
        proc.stdout.once('close', () => resolve())
        proc.stdout.once('error', () => resolve())
      })
      const reader = createJsonLineReader((obj) => {
        for (const effect of translator.feed(obj)) this.apply(tracked, effect)
      })
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => reader.push(chunk))
      proc.stdout.once('end', () => reader.end())

      if (tracked.stopRequested) this.requestKill(tracked)
      else void this.write(tracked, buildAgentPrompt(ctx.goalMd, this.options.contextPath ?? null, this.options.toolsPath ?? null)).catch(() => {})
      // Sent once, as on the OpenCode path; a failed send is not retried.
      steerTimer = deadlineTimer(ctx.steerAfterMs ?? Infinity, () => {
        if (!tracked.accepting || tracked.stopRequested) return
        void this.write(tracked, buildSteeringPrompt(ctx.steerAfterMs!)).catch(() => {})
      })

      const outcome = await Promise.race([
        proc.exited.then((e) => ({ kind: 'exit' as const, e })),
        new Promise<{ kind: 'timeout' }>((resolve) => { timer = deadlineTimer(ctx.timeoutMs, () => resolve({ kind: 'timeout' })) }),
      ])
      if (outcome.kind === 'timeout') {
        this.requestKill(tracked)
        const observed = translator.usage()
        return {
          status: 'timeout',
          errorText: `agent exceeded ${ctx.timeoutMs}ms`,
          failure: { message: `Agent exceeded ${ctx.timeoutMs}ms`, code: 'AGENT_TIMEOUT' },
          usageKnown: observed !== null,
          ...(observed ?? ZERO_TOKENS), costUsd: 0,
          durationMs: Date.now() - started,
        }
      }
      // The exit can be reported before the last lines are read.
      await Promise.race([stdoutDone, new Promise<void>((resolve) => { const t = setTimeout(resolve, STDOUT_DRAIN_MS); (t as { unref?: () => void }).unref?.() })])

      const observed = translator.usage()
      const usage = { usageKnown: observed !== null || translator.result !== null, ...(observed ?? ZERO_TOKENS), costUsd: 0 }
      const duration = () => Date.now() - started
      if (outcome.e.error) {
        const failure: AgentFailure = outcome.e.error.code === 'ENOENT'
          ? { code: CLAUDE_FAILURE_CODES.cliMissing, message: new ClaudeCliMissingError('the executable could not be started').message.slice(0, 300) }
          : describeFailure(outcome.e.error)
        return { status: 'error', errorText: failure.message.slice(0, 500), failure, ...usage, durationMs: duration() }
      }
      const result = translator.result
      if (result && !result.isError) {
        const submission = await this.sandbox.readFile(handle, SUBMISSION_FILE)
        return { status: submission && submission.trim().length > 0 ? 'ok' : 'no_submission', errorText: null, ...usage, durationMs: duration() }
      }
      const failure = classifyClaudeFailure({ result, rateLimit: translator.rateLimit, text: result ? '' : stderrTail })
      if (failure.code === CLAUDE_FAILURE_CODES.limit && translator.rateLimit?.status !== 'rejected') {
        // Inferred from text without a reading: close the gate for the fallback interval.
        this.gate.observe({ status: 'rejected', rateLimitType: null, resetsAt: null, utilization: null })
      }
      const failed: AgentRunResult = { status: 'error', errorText: failure.message.slice(0, 500), failure, ...usage, durationMs: duration() }
      return result ? failed : await this.withResourceDiagnosis(handle, failed)
    } catch (e) {
      this.requestKill(tracked)
      return {
        status: 'error', errorText: errorTextFor(e), failure: describeFailure(e),
        usageKnown: false, ...ZERO_TOKENS, costUsd: 0, durationMs: Date.now() - started,
      }
    } finally {
      clearTimeout(timer)
      clearTimeout(steerTimer)
      tracked.accepting = false
      if (tracked.proc === null) this.confirmStopped(tracked)
      tracked.localReturned = true
      this.forgetStopped(tracked)
    }
  }

  private apply(run: LiveAttempt, effect: StreamEffect): void {
    switch (effect.type) {
      case 'session':
        try {
          this.options.onSessionCreated?.(run.agentId, effect.sessionId)
        } catch {
          /* a dashboard subscriber must never break an agent's run */
        }
        return
      case 'activity':
        try {
          this.options.onActivity?.(run.agentId, { kind: effect.kind, detail: effect.detail, item: effect.item })
        } catch {
          /* as above */
        }
        return
      case 'rate_limit':
        this.gate.observe(effect.reading)
        return
      case 'result':
        // The agent is done: closing stdin lets the CLI exit once anything still queued is handled.
        run.accepting = false
        run.proc?.stdin.end()
        return
    }
  }

  private write(run: LiveAttempt, text: string): Promise<void> {
    const proc = run.proc
    if (!proc || !run.accepting) return Promise.reject(new Error(`agent ${run.agentId} is not accepting messages`))
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`
    return new Promise<void>((resolve, reject) => {
      proc.stdin.write(line, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** After the launched process exits: sweep what it left in its group, then confirm. */
  private watchExit(run: LiveAttempt): void {
    const proc = run.proc!
    void proc.exited.then(async () => {
      run.exited = true
      run.accepting = false
      await proc.kill().catch(() => {})
      const state = await proc.probe().catch(() => 'unknown' as const)
      if (state === 'stopped') this.confirmStopped(run)
      else this.watchForStop(run)
    })
  }

  private requestKill(run: LiveAttempt): void {
    run.accepting = false
    if (!run.proc || run.killRequested || run.remoteStopped) return
    run.killRequested = true
    try {
      run.proc.stdin.end()
    } catch {
      /* already closed */
    }
    void run.proc.kill().catch(() => {}).then(() => this.watchForStop(run))
  }

  /**
   * Polls the runtime until nothing of the attempt is left, for at most STOP_WATCH_MS. A kill
   * request is not termination evidence: only the launched process's exit together with an empty
   * process group (or the container being gone, in `reconcile`) is.
   */
  private watchForStop(run: LiveAttempt): void {
    if (run.watching || run.remoteStopped) return
    run.watching = true
    void (async () => {
      const deadline = Date.now() + STOP_WATCH_MS
      while (!run.remoteStopped && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, STOP_POLL_MS)
          ;(t as { unref?: () => void }).unref?.()
        })
        if (run.remoteStopped) return
        if (run.exited) {
          if ((await run.proc!.probe().catch(() => 'unknown' as const)) === 'stopped') {
            this.confirmStopped(run)
            return
          }
        } else if (run.killRequested) {
          // A CLI that started after the first kill (its group was not recorded yet) gets another.
          await run.proc!.kill().catch(() => {})
        }
      }
      run.watching = false
    })()
  }

  private async reconcile(run: LiveAttempt): Promise<void> {
    if (run.remoteStopped) return
    if (run.exited && run.proc && (await run.proc.probe().catch(() => 'unknown' as const)) === 'stopped') {
      this.confirmStopped(run)
      return
    }
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

  private blockReason(run: LiveAttempt): string {
    const who = `agent ${run.agentId}`
    if (!run.localReturned) return `${who}: previous Claude Code invocation has not returned locally — termination is unconfirmed`
    if (run.runtime === 'running') return `${who}: the original container is still running — termination of its Claude Code process is unconfirmed`
    return `${who}: the previous Claude Code process could not be confirmed stopped`
  }

  private assertAvailable(agentId: string, workspacePath: string): void {
    for (const run of this.live.values()) {
      if (run.agentId === agentId || workspaceKey(run.directory) === workspaceKey(workspacePath)) {
        throw new Error(`agent ${run.agentId} is still active or remote termination is unconfirmed`)
      }
    }
  }

  private confirmStopped(run: LiveAttempt): void {
    run.remoteStopped = true
    run.accepting = false
    run.settleStopped()
    this.forgetStopped(run)
  }

  private forgetStopped(run: LiveAttempt): void {
    if (run.remoteStopped && run.localReturned && this.live.get(run.agentId) === run) this.live.delete(run.agentId)
  }

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
}

function workspaceKey(directory: string): string {
  const absolute = resolvePath(directory)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
