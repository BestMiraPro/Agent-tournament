import type { AgentFailure } from '../core/failure.js'
import type { Genome, SubmissionStatus } from '../core/types.js'
import type { QuiesceStatus } from '../engine/capture.js'
import { CHANNEL_FILE, formatEntry } from '../engine/channel.js'
import { trueFitness } from './mock-provider.js'
import type { AgentHandle, Sandbox } from './sandbox.js'
import { OUTPUT_DIR, OUTPUT_README } from './team-prompt.js'

/** A collaboration member's place in its team, for the prompt it is given. */
export interface TeamContext {
  /** This agent's label: how it signs channel posts and names its scratch folder. */
  label: string
  /** Every other member's label. */
  teammates: string[]
  /** The command that posts to the channel, as the agent runs it (label and message follow). */
  postCommand: string
}

export interface AgentRunContext {
  agentId: string
  genome: Genome
  goalMd: string
  /** Hard limit; `Infinity` for none. */
  timeoutMs: number
  /** When to tell a still-working agent to submit what it has; absent or `Infinity` for never. */
  steerAfterMs?: number
  /**
   * Present in a collaboration round: the agent works in the team's shared folder, talks
   * through CHANNEL.md and contributes to output/, and no SUBMISSION.md is expected.
   */
  team?: TeamContext
}

/** A timer that never fires for a non-finite delay: `setTimeout(fn, Infinity)` fires at once. */
export function deadlineTimer(ms: number, fn: () => void): ReturnType<typeof setTimeout> | undefined {
  return Number.isFinite(ms) && ms >= 0 ? setTimeout(fn, ms) : undefined
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
  assertReadyForRound?(): void | Promise<void>
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
  /**
   * Queues a message into this agent's live session behind its current step: how teammates'
   * channel posts reach it. Resolves false when the agent is not running (finished, stopped
   * or never started), so a stopped session is never woken. Optional: a runner without it
   * leaves the channel file as the only way posts are seen.
   */
  send?(handle: AgentHandle, text: string): Promise<boolean>
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
  /** Messages delivered through `send`, per agent — what a teammate was told, for tests. */
  readonly inbox = new Map<string, string[]>()
  private wake = new Map<string, () => void>()
  /** Channel appends one at a time, as the real helper's lock makes them. */
  private channelTurn: Promise<void> = Promise.resolve()

  async send(handle: AgentHandle, text: string): Promise<boolean> {
    if (!this.inFlight.has(handle.agentId)) return false
    const box = this.inbox.get(handle.agentId) ?? []
    box.push(text)
    this.inbox.set(handle.agentId, box)
    this.wake.get(handle.agentId)?.()
    return true
  }

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
    if (ctx.team && !ctx.genome.strategyMd.includes('__FAIL__')) return this.collaborate(handle, ctx, ctx.team, started)
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

  /**
   * A team member, end to end through the same files a real one uses: introduce itself on the
   * channel, wait (bounded) until every teammate's introduction has been delivered to it,
   * write its own piece of output/, say so, and — for the first member by label — wait for the
   * others to finish and write output/README.md from what is in the shared folder. The README
   * carries the team's fitness (the mean of its pieces), which the mock judge reads.
   */
  private async collaborate(handle: AgentHandle, ctx: AgentRunContext, team: TeamContext, started: number): Promise<AgentRunResult> {
    const others = team.teammates.length
    let written = 0
    const post = async (body: string) => {
      const turn = this.channelTurn.then(async () => {
        const current = (await this.sandbox.readFile(handle, CHANNEL_FILE)) ?? ''
        const entry = formatEntry(team.label, body)
        written += entry.length
        await this.sandbox.writeFile(handle, CHANNEL_FILE, current + entry)
      })
      this.channelTurn = turn.catch(() => {})
      await turn
    }

    await post(`${team.label} here. My focus: ${ctx.genome.strategyMd.slice(0, 120)}`)
    await this.waitForPosts(ctx.agentId, others, MOCK_TEAM_WAIT_MS)

    const piece = `${OUTPUT_DIR}/${team.label}.md`
    const body = [`# ${team.label}`, '', `Approach: ${ctx.genome.strategyMd}`, '', `FITNESS=${trueFitness(ctx.genome.strategyMd).toFixed(2)}`].join('\n')
    await this.sandbox.writeFile(handle, piece, body)
    written += body.length
    await post(`done: wrote ${piece}`)

    const lead = [team.label, ...team.teammates].sort()[0] === team.label
    if (lead) {
      await this.waitForPosts(ctx.agentId, 2 * others, MOCK_TEAM_WAIT_MS)
      const pieces = (await this.sandbox.listFiles(handle))
        .map((f) => f.path)
        .filter((p) => p.startsWith(`${OUTPUT_DIR}/`) && p !== OUTPUT_README)
        .sort()
      const scores: number[] = []
      for (const p of pieces) {
        const m = /FITNESS=([\d.]+)/.exec((await this.sandbox.readFile(handle, p)) ?? '')
        if (m) scores.push(Number(m[1]))
      }
      const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
      const readme = [
        '# Team output',
        '',
        `Goal: ${ctx.goalMd}`,
        '',
        'Pieces:',
        ...pieces.map((p) => `- ${p}`),
        '',
        `FITNESS=${mean.toFixed(2)}`,
      ].join('\n')
      await this.sandbox.writeFile(handle, OUTPUT_README, readme)
      written += readme.length
      await post(`README written: ${pieces.length} piece(s)`)
    }

    return {
      status: 'ok',
      errorText: null,
      tokensIn: 500 + ctx.genome.strategyMd.length,
      tokensOut: written,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      costUsd: 0,
      durationMs: Date.now() - started,
    }
  }

  /** Until `count` channel posts have been delivered to this agent, or `ms` passes. */
  private async waitForPosts(agentId: string, count: number, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    const received = () => (this.inbox.get(agentId) ?? []).reduce((n, text) => n + (text.match(/^### /gm)?.length ?? 0), 0)
    while (received() < count && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now())))
        this.wake.set(agentId, () => { clearTimeout(t); resolve() })
      })
    }
    this.wake.delete(agentId)
  }
}

/** How long a mock member waits for its teammates' posts before carrying on without them. */
export const MOCK_TEAM_WAIT_MS = 2000
