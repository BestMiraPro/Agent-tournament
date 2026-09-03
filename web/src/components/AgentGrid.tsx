import type { KeyboardEvent } from 'react'
import type { SnapshotAgent } from '../api.js'
import type { LiveState } from '../useLiveRun.js'

const STATUS_LABEL: Record<string, string> = {
  pending: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
}

export function AgentGrid({ agents, live, onSelect }: {
  agents: SnapshotAgent[]
  live: LiveState
  onSelect?: (agentId: string) => void
}) {
  const rankOf = new Map(live.scores.map((s) => [s.agentId, s.rank]))

  return (
    <div className="grid">
      {agents.map((a) => {
        const l = live.agents[a.agentId]
        const status = l?.status ?? 'pending'
        const rank = rankOf.get(a.agentId)
        return (
          <div
            key={a.agentId}
            className={`cell cell--${status}${onSelect ? ' cell--selectable' : ''}`}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onClick={onSelect ? () => onSelect(a.agentId) : undefined}
            // Enter/Space are the keyboard equivalents of a click for role=button.
            onKeyDown={onSelect ? (e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(a.agentId)
              }
            } : undefined}
          >
            <div className="cell__head">
              <span className="cell__label">{a.label}</span>
              {rank !== undefined && <span className="cell__rank">#{rank}</span>}
            </div>
            <div className="cell__model" title={a.modelId}>{a.modelId}</div>
            <div className="cell__status">{STATUS_LABEL[status] ?? status}</div>
            <div className="cell__activity">{l?.activity || ' '}</div>
            <div className="cell__usage">
              {l ? `${l.tokensIn + l.tokensOut} tok` : ' '}
            </div>
          </div>
        )
      })}
    </div>
  )
}
