import { useEffect, useReducer } from 'react'
import type { RunSnapshot } from './api.js'

export interface LiveAgent {
  status: 'pending' | 'running' | 'done' | 'failed'
  activity: string
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface LiveState {
  agents: Record<string, LiveAgent>
  scores: { agentId: string; rank: number; score: number }[]
  roundStatus: string
  roundIdx: number
  busy: boolean
  lastBreach: string | null
}

export const initialLiveState: LiveState = {
  agents: {},
  scores: [],
  roundStatus: 'idle',
  roundIdx: 0,
  busy: false,
  lastBreach: null,
}

const blank: LiveAgent = { status: 'pending', activity: '', tokensIn: 0, tokensOut: 0, costUsd: 0 }

/** Pure so it can be tested without a browser or a socket. */
export function liveReducer(state: LiveState, event: { type: string } & Record<string, unknown>): LiveState {
  const agentId = event.agentId as string | undefined
  const current = agentId ? (state.agents[agentId] ?? blank) : blank

  switch (event.type) {
    case 'round.status': {
      const status = event.status as string
      // A new round starts every agent fresh; stale "done" badges would misreport progress.
      const agents =
        status === 'preparing'
          ? Object.fromEntries(Object.keys(state.agents).map((id) => [id, { ...blank }]))
          : state.agents
      return { ...state, roundStatus: status, roundIdx: event.roundIdx as number, busy: true, agents }
    }
    case 'agent.status':
      if (!agentId) return state
      return {
        ...state,
        agents: { ...state.agents, [agentId]: { ...current, status: event.status as LiveAgent['status'] } },
      }
    case 'agent.activity':
      if (!agentId) return state
      return {
        ...state,
        agents: { ...state.agents, [agentId]: { ...current, activity: event.detail as string } },
      }
    case 'agent.usage':
      if (!agentId) return state
      return {
        ...state,
        agents: {
          ...state.agents,
          [agentId]: {
            ...current,
            tokensIn: current.tokensIn + (event.tokensIn as number),
            tokensOut: current.tokensOut + (event.tokensOut as number),
            costUsd: current.costUsd + (event.costUsd as number),
          },
        },
      }
    case 'round.scored':
      return {
        ...state,
        scores: [...(event.scores as LiveState['scores'])].sort((a, b) => a.rank - b.rank),
      }
    case 'round.complete':
      return { ...state, busy: false, lastBreach: (event.budgetBreach as string | null) ?? null }
    default:
      return state
  }
}

export function useLiveRun(snapshot: RunSnapshot | null): LiveState {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${proto}://${location.host}/ws`)
    socket.onmessage = (m) => {
      try {
        dispatch(JSON.parse(m.data as string))
      } catch {
        /* ignore malformed frames rather than killing the stream */
      }
    }
    return () => socket.close()
  }, [])

  void snapshot
  return state
}
