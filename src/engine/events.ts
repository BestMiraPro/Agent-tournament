import type { AgentFailure } from '../core/failure.js'
import type { RoundStatus } from '../core/types.js'

export type AgentLiveStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Progress the engine itself knows about. Always available, including in mock mode.
 * Distinct from OpenCode activity events, which are best-effort detail and absent
 * entirely when there is no OpenCode server.
 */
export type EngineEvent =
  | { type: 'round.status'; runId: string; roundIdx: number; status: RoundStatus }
  | {
      type: 'agent.status'
      runId: string
      agentId: string
      status: AgentLiveStatus
      /** The round this status belongs to, so a late event cannot relabel a newer round. */
      roundIdx?: number
      /** Present when status is 'failed': why, published the moment the attempt ended. */
      failure?: AgentFailure
    }
  | { type: 'agent.session'; runId: string; agentId: string; sessionId: string }
  | { type: 'agent.activity'; runId: string; agentId: string; kind: 'tool' | 'text' | 'file'; detail: string }
  | {
      /**
       * An OpenCode permission request for this agent, and its answer. A request that is
       * never answered stalls the agent while it still looks "working", so it is surfaced.
       */
      type: 'agent.permission'
      runId: string
      agentId: string
      requestId: string
      state: 'asked' | 'replied'
      /** Present when asked. */
      permission?: string
      /** Present when asked; bounded. */
      patterns?: string[]
      /** Present when replied. */
      reply?: 'once' | 'always' | 'reject'
      /** When the bridge saw it, so a wait can show its age. */
      at: number
    }
  | {
      /**
       * The agent's terminal usage totals, sent at most once per attempt and only when
       * they were actually observed. Consumers set these values; they never add them up.
       */
      type: 'agent.usage'
      runId: string
      agentId: string
      tokensIn: number
      tokensOut: number
      costUsd: number
    }
  | {
      type: 'round.scored'
      runId: string
      roundIdx: number
      /** `failed` marks ranked agents whose attempt did not succeed, so rank 1 is not read as a win. */
      scores: { agentId: string; rank: number; score: number; failed?: boolean }[]
    }
  | {
      type: 'round.complete'
      runId: string
      roundIdx: number
      /** A real budget breach. Never used to carry an arbitrary failure. */
      budgetBreach: string | null
      /** Why the round failed outright, when it did. */
      error?: string | null
    }

export type EventSink = (event: EngineEvent) => void

export const noopSink: EventSink = () => {}

/** Test helper: a sink that records, plus a wrapper that swallows subscriber errors. */
export function collectEvents(): {
  sink: EventSink
  events: EngineEvent[]
  safe: (inner: EventSink) => EventSink
} {
  const events: EngineEvent[] = []
  return {
    events,
    sink: (e) => {
      events.push(e)
    },
    // A dashboard subscriber must never be able to fail a tournament round.
    safe: (inner) => (e) => {
      try {
        inner(e)
      } catch {
        /* a broken subscriber is not the engine's problem */
      }
    },
  }
}
