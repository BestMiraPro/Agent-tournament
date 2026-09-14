import type { AgentFailure } from '../core/failure.js'
import type { ActivityItem, ActivityItemInput, AgentLiveStatus, EngineEvent } from '../engine/events.js'

export interface ActivityLimits {
  maxItemsPerAgent: number
  maxItemBytes: number
  maxAgentBytes: number
  maxRunBytes: number
}

export const DEFAULT_ACTIVITY_LIMITS: ActivityLimits = {
  maxItemsPerAgent: 100,
  maxItemBytes: 8 * 1024,
  maxAgentBytes: 256 * 1024,
  maxRunBytes: 4 * 1024 * 1024,
}

export interface AgentActivity {
  items: ActivityItem[]
  /** When the latest evidence for this agent was observed; null before any. */
  lastObservedAt: number | null
  /** Older details were evicted to stay inside the limits. */
  truncated: boolean
  status: AgentLiveStatus
  failure: AgentFailure | null
  usageReported: boolean
}

export interface StreamHealth {
  state: 'connected' | 'reconnecting'
  message?: string
  at: number
}

export interface ActivitySnapshot {
  /** Increases with every change, so a client can refuse a snapshot older than what it streamed. */
  revision: number
  roundIdx: number
  agents: Record<string, AgentActivity>
  streams: Record<string, StreamHealth>
}

const bytesOf = (item: { summary: string; output?: string }): number =>
  Buffer.byteLength(item.summary) + (item.output ? Buffer.byteLength(item.output) : 0)

/** A UTF-8-safe prefix of at most `max` bytes. */
function cutBytes(text: string, max: number): string {
  if (max <= 0) return ''
  if (Buffer.byteLength(text) <= max) return text
  return Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, '')
}

/**
 * The current round's live activity for one run, held in memory only.
 *
 * Every engine and bridge event for the run passes through `record` before it is broadcast,
 * so a snapshot taken at any moment already contains everything a browser was sent. That is
 * what lets a reconnecting browser restore the timeline instead of starting blank. It is
 * bounded per item, per agent and per run, drops the previous round on PREPARE, and dies
 * with the run: a restarted server has no transient history, and says so rather than
 * pretending an empty one.
 */
export class ActivityCache {
  private readonly limits: ActivityLimits
  private agents = new Map<string, AgentActivity>()
  private streams: Record<string, StreamHealth> = {}
  private revision = 0
  private roundIdx = 0
  private runBytes = 0

  constructor(private readonly opts: {
    limits?: Partial<ActivityLimits>
    /** The session an agent currently runs, so events from a replaced session are ignored. */
    currentSession?: (agentId: string) => string | null
  } = {}) {
    this.limits = { ...DEFAULT_ACTIVITY_LIMITS, ...opts.limits }
  }

  /** Applies an event and returns what should be broadcast: the event, a reconciled copy, or null. */
  record(event: EngineEvent): EngineEvent | null {
    switch (event.type) {
      case 'round.status':
        if (event.status === 'preparing') {
          this.agents.clear()
          this.runBytes = 0
          this.revision++
        }
        this.roundIdx = event.roundIdx
        return event
      case 'agent.status': {
        const agent = this.agent(event.agentId)
        agent.status = event.status
        agent.failure = event.status === 'failed' ? event.failure ?? null : null
        this.revision++
        return event
      }
      case 'agent.usage':
        this.agent(event.agentId).usageReported = true
        this.revision++
        return event
      case 'bridge.status':
        this.streams[event.source] = { state: event.state, ...(event.message ? { message: event.message } : {}), at: event.at }
        this.revision++
        return event
      case 'agent.permission': {
        if (event.state === 'asked') {
          const patterns = event.patterns?.length ? ` ${event.patterns.join(', ')}` : ''
          this.upsert(event.runId, event.agentId, {
            id: event.requestId, sessionId: '', kind: 'permission', status: 'waiting',
            summary: `Permission ${event.permission ?? 'request'}${patterns}`, observedAt: event.at,
          })
        } else {
          const waiting = this.agents.get(event.agentId)?.items.find((i) => i.id === event.requestId && i.status === 'waiting')
          if (waiting) {
            this.upsert(event.runId, event.agentId, {
              ...waiting, status: 'completed',
              summary: `${waiting.summary} — ${event.reply === 'reject' ? 'rejected' : 'granted'}`, observedAt: event.at,
            })
          }
        }
        return event
      }
      case 'agent.activity': {
        const input = event.item
        if (!input) {
          this.agent(event.agentId).lastObservedAt = Date.now()
          this.revision++
          return event
        }
        const current = this.opts.currentSession?.(event.agentId) ?? null
        if (current !== null && input.sessionId !== '' && input.sessionId !== current) return null
        const existing = this.agents.get(event.agentId)?.items.find((i) => i.id === input.id)
        // A delta only ever extends a part already shown. Reasoning parts are never shown,
        // so their deltas have nothing to extend and are dropped here.
        if (input.append && !existing) return null
        const { append, ...fields } = input
        const merged = append && existing
          ? { ...existing, summary: existing.summary + fields.summary, observedAt: fields.observedAt }
          : fields
        const stored = this.upsert(event.runId, event.agentId, merged)
        return {
          ...event,
          detail: stored.kind === 'text' ? stored.summary.slice(-200) : stored.summary,
          item: { ...stored },
        }
      }
      default:
        return event
    }
  }

  snapshot(): ActivitySnapshot {
    return {
      revision: this.revision,
      roundIdx: this.roundIdx,
      agents: Object.fromEntries([...this.agents].map(([id, a]) => [id, { ...a, items: a.items.map((i) => ({ ...i })) }])),
      streams: { ...this.streams },
    }
  }

  clear(): void {
    this.agents.clear()
    this.streams = {}
    this.runBytes = 0
    this.revision++
  }

  private agent(agentId: string): AgentActivity {
    let agent = this.agents.get(agentId)
    if (!agent) {
      agent = { items: [], lastObservedAt: null, truncated: false, status: 'pending', failure: null, usageReported: false }
      this.agents.set(agentId, agent)
    }
    return agent
  }

  private upsert(runId: string, agentId: string, input: Omit<ActivityItemInput, 'append'>): ActivityItem {
    const agent = this.agent(agentId)
    const item = this.capItem({ ...input, runId, agentId, roundIdx: this.roundIdx, revision: ++this.revision })
    const index = agent.items.findIndex((i) => i.id === item.id)
    if (index >= 0) {
      this.runBytes -= bytesOf(agent.items[index]!)
      agent.items[index] = item
    } else {
      agent.items.push(item)
    }
    this.runBytes += bytesOf(item)
    agent.lastObservedAt = Math.max(agent.lastObservedAt ?? 0, item.observedAt)
    this.enforce(agent)
    return item
  }

  private capItem(item: ActivityItem): ActivityItem {
    const max = this.limits.maxItemBytes
    if (bytesOf(item) <= max) return item
    const summary = cutBytes(item.summary, max)
    const capped: ActivityItem = { ...item, summary, truncated: true }
    if (item.output !== undefined) capped.output = cutBytes(item.output, max - Buffer.byteLength(summary))
    return capped
  }

  private enforce(agent: AgentActivity): void {
    const agentBytes = () => agent.items.reduce((n, i) => n + bytesOf(i), 0)
    while (agent.items.length > 1 && (agent.items.length > this.limits.maxItemsPerAgent || agentBytes() > this.limits.maxAgentBytes)) {
      this.drop(agent, 0)
    }
    while (this.runBytes > this.limits.maxRunBytes) {
      let oldest: { agent: AgentActivity; index: number; revision: number } | null = null
      for (const candidate of this.agents.values()) {
        candidate.items.forEach((i, index) => {
          if (oldest === null || i.revision < oldest.revision) oldest = { agent: candidate, index, revision: i.revision }
        })
      }
      if (oldest === null) break
      const { agent: owner, index } = oldest as { agent: AgentActivity; index: number }
      this.drop(owner, index)
    }
  }

  private drop(agent: AgentActivity, index: number): void {
    const [removed] = agent.items.splice(index, 1)
    if (removed) this.runBytes -= bytesOf(removed)
    agent.truncated = true
  }
}
