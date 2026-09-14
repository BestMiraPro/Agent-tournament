import { useEffect, useRef, useState } from 'react'
import { getRun, type AgentFailure, type RunSnapshot } from './api.js'

export interface LiveAgent {
  status: 'pending' | 'running' | 'done' | 'failed'
  activity: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** Why the current attempt failed, as published the moment it ended. */
  failure: AgentFailure | null
  /** Whether usage was actually reported. Until it is, the counts above are not facts. */
  usageReported: boolean
}

export interface LiveScore {
  agentId: string
  rank: number
  score: number
  /** Ranked, but the attempt failed: never presented as a win. */
  failed?: boolean
}

export interface LiveState {
  agents: Record<string, LiveAgent>
  scores: LiveScore[]
  roundStatus: string
  roundIdx: number
  busy: boolean
  lastBreach: string | null
  /** Why the latest round failed outright — distinct from a budget breach. */
  lastError: string | null
  wsStatus: 'connected' | 'reconnecting'
}

export const initialLiveState: LiveState = {
  agents: {},
  scores: [],
  roundStatus: 'idle',
  roundIdx: 0,
  busy: false,
  lastBreach: null,
  lastError: null,
  wsStatus: 'connected',
}

function stateFromSnapshot(snapshot: RunSnapshot): LiveState {
  return {
    ...initialLiveState,
    scores: snapshot.scores.map(({ agentId, rank, score, failed }) => ({ agentId, rank, score, failed })).sort((a, b) => a.rank - b.rank),
    roundIdx: snapshot.lastRoundIdx,
    busy: snapshot.busy,
  }
}

const blank: LiveAgent = { status: 'pending', activity: '', tokensIn: 0, tokensOut: 0, costUsd: 0, failure: null, usageReported: false }

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
      return {
        ...state, roundStatus: status, roundIdx: event.roundIdx as number, busy: true, agents,
        // A new round is a new attempt: the previous round's outright failure no longer applies.
        lastError: status === 'preparing' ? null : state.lastError,
      }
    }
    case 'agent.status': {
      if (!agentId) return state
      const status = event.status as LiveAgent['status']
      const failure = status === 'failed' ? ((event.failure as AgentFailure | undefined) ?? null) : null
      return {
        ...state,
        agents: { ...state.agents, [agentId]: { ...current, status, failure } },
      }
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
            // Terminal totals, set rather than summed, so a second report of the same
            // attempt cannot double the count.
            tokensIn: event.tokensIn as number,
            tokensOut: event.tokensOut as number,
            costUsd: event.costUsd as number,
            usageReported: true,
          },
        },
      }
    case 'round.scored':
      return {
        ...state,
        scores: [...(event.scores as LiveState['scores'])].sort((a, b) => a.rank - b.rank),
      }
    case 'round.complete':
      return {
        ...state,
        busy: false,
        lastBreach: (event.budgetBreach as string | null) ?? null,
        lastError: (event.error as string | null | undefined) ?? null,
      }
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

/** The production hook uses this small controller so tests can cover socket/fetch races without a DOM. */
export function applyLiveEvent(state: LiveState, runId: string, event: { type: string } & Record<string, unknown>): LiveState {
  return event.runId !== runId ? state : liveReducer(state, event)
}

export function createLiveSession(runId: string, seed: LiveState) {
  let currentRunId = runId
  let current = seed
  let revision = 0
  let refreshId = 0
  return {
    get state() { return current },
    beginRefresh(requestedRunId = currentRunId) { return { runId: currentRunId, requestedRunId, revision, refreshId: ++refreshId } },
    switchRun(nextRunId: string, snapshot?: RunSnapshot) {
      currentRunId = nextRunId
      revision++
      current = snapshot ? stateFromSnapshot(snapshot) : initialLiveState
    },
    event(event: { type: string } & Record<string, unknown>) {
      const next = applyLiveEvent(current, currentRunId, event)
      if (next !== current) { current = next; revision++ }
    },
    snapshot(next: LiveState, request: { runId: string; requestedRunId: string; revision: number; refreshId: number }) {
      if (request.runId === currentRunId && request.requestedRunId === currentRunId && request.revision === revision && request.refreshId === refreshId) current = next
    },
  }
}

/** Exponential backoff in ms: 1s -> 2s -> 4s -> ... capped at 30s. Pure so it can be tested without a socket. */
export function nextDelay(attempt: number): number {
  const ms = 1000 * 2 ** attempt
  return Math.min(ms, 30000)
}

export function useLiveRun(snapshot: RunSnapshot | null): LiveState {
  const [state, setState] = useState<LiveState>(initialLiveState)
  const session = useRef(createLiveSession(snapshot?.runId ?? '', snapshot ? stateFromSnapshot(snapshot) : initialLiveState))
  const runId = snapshot?.runId ?? ''

  const publish = () => setState({ ...session.current.state, agents: { ...session.current.state.agents }, scores: [...session.current.state.scores] })

  useEffect(() => {
    session.current.switchRun(runId, snapshot ?? undefined)
    publish()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let closed = false

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${proto}://${location.host}/ws`)
      socket.onopen = () => {
        if (closed) return
        attempt = 0
        session.current.event({ type: 'ws.status', runId, status: 'connected' })
        const request = session.current.beginRefresh(runId)
        void getRun(runId).then((fresh) => { if (!closed) { session.current.snapshot(stateFromSnapshot(fresh), request); publish() } }, () => undefined)
      }
      socket.onmessage = (m) => {
        if (closed) return
        try {
          session.current.event(JSON.parse(m.data as string))
          publish()
        } catch {
          /* ignore malformed frames rather than killing the stream */
        }
      }
      socket.onclose = () => {
        if (closed) return
        session.current.event({ type: 'ws.status', runId, status: 'reconnecting' }); publish()
        timer = setTimeout(() => { attempt++; open() }, nextDelay(attempt))
      }
    }
    open()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }, [runId])

  return state
}
