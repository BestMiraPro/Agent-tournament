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
  wsStatus: 'connected' | 'reconnecting'
}

export const initialLiveState: LiveState = {
  agents: {},
  scores: [],
  roundStatus: 'idle',
  roundIdx: 0,
  busy: false,
  lastBreach: null,
  wsStatus: 'connected',
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
    /**
     * Seed standings from the HTTP snapshot.
     *
     * Scores previously arrived only over the websocket, so opening an existing run —
     * or simply reloading the page — showed a grid with no ranks and an empty
     * leaderboard until another round happened to run, even though the server had
     * every score. Live events still win once they arrive; this only fills the gap
     * before the first one.
     */
    case 'hydrate':
      return {
        ...state,
        scores: [...(event.scores as LiveState['scores'])].sort((a, b) => a.rank - b.rank),
        roundIdx: (event.roundIdx as number) ?? state.roundIdx,
      }
    case 'ws.status':
      return { ...state, wsStatus: event.status as LiveState['wsStatus'] }
    default:
      return state
  }
}

/** Exponential backoff in ms: 1s -> 2s -> 4s -> ... capped at 30s. Pure so it can be tested without a socket. */
export function nextDelay(attempt: number): number {
  const ms = 1000 * 2 ** attempt
  return Math.min(ms, 30000)
}

export function useLiveRun(snapshot: RunSnapshot | null): LiveState {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState)

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let closed = false

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${proto}://${location.host}/ws`)
      socket.onopen = () => {
        attempt = 0
        dispatch({ type: 'ws.status', status: 'connected' })
      }
      socket.onmessage = (m) => {
        try {
          dispatch(JSON.parse(m.data as string))
        } catch {
          /* ignore malformed frames rather than killing the stream */
        }
      }
      socket.onclose = () => {
        if (closed) return
        dispatch({ type: 'ws.status', status: 'reconnecting' })
        timer = setTimeout(() => { attempt++; open() }, nextDelay(attempt))
      }
    }
    open()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }, [])

  // Hydrate from the snapshot whenever it moves to a run/round the live state has
  // not seen. Guarded on roundIdx so an in-flight round's fresher websocket scores
  // are never overwritten by the older snapshot the arena polls alongside it.
  const snapRunId = snapshot?.runId ?? null
  const snapRoundIdx = snapshot?.lastRoundIdx ?? 0
  useEffect(() => {
    if (!snapshot) return
    if (snapshot.scores.length === 0) return
    dispatch({ type: 'hydrate', scores: snapshot.scores, roundIdx: snapshot.lastRoundIdx })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapRunId, snapRoundIdx])

  return state
}
