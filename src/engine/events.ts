import type { RoundStatus } from '../core/types.js'

export type AgentLiveStatus = 'pending' | 'running' | 'done' | 'failed'

/**
 * Progress the engine itself knows about. Always available, including in mock mode.
 * Distinct from OpenCode activity events, which are best-effort detail and absent
 * entirely when there is no OpenCode server.
 */
export type EngineEvent =
  | { type: 'round.status'; runId: string; roundIdx: number; status: RoundStatus }
  | { type: 'agent.status'; runId: string; agentId: string; status: AgentLiveStatus }
  | { type: 'agent.session'; runId: string; agentId: string; sessionId: string }
  | { type: 'agent.activity'; runId: string; agentId: string; kind: 'tool' | 'text' | 'file'; detail: string }
  | {
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
      scores: { agentId: string; rank: number; score: number }[]
    }
  | { type: 'round.complete'; runId: string; roundIdx: number; budgetBreach: string | null }

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
