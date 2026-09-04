import { useEffect, useState, type KeyboardEvent } from 'react'
import type { SnapshotAgent } from '../api.js'
import type { LiveState } from '../useLiveRun.js'

const STATUS_LABEL: Record<string, string> = {
  pending: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
}

const PAGE_SIZE = 24

export function AgentGrid({ agents, live, onSelect }: {
  agents: SnapshotAgent[]
  live: LiveState
  onSelect?: (agentId: string) => void
}) {
  const rankOf = new Map(live.scores.map((s) => [s.agentId, s.rank]))
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [agents.length])
  const totalPages = Math.ceil(agents.length / PAGE_SIZE)
  const visible = agents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <div className="grid">
        {visible.map((a) => {
          const l = live.agents[a.agentId]
          const status = l?.status ?? 'pending'
          const rank = rankOf.get(a.agentId)
          return (
            <div
              key={a.agentId}
              className={`cell cell--${status}${onSelect ? ' cell--selectable' : ''}`}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={`Agent ${a.label}, ${a.modelId}, ${STATUS_LABEL[status] ?? status}`}
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
                {/* data-rank lets the leader be styled distinctly; rank is the one
                    number on this cell a spectator is actually looking for. */}
                {rank !== undefined && (
                  <span className="cell__rank" data-rank={rank}>#{rank}</span>
                )}
              </div>
              <div className="cell__model" title={a.modelId}>{a.modelId}</div>
              <div className="cell__status">{STATUS_LABEL[status] ?? status}</div>
              <div className="cell__activity">{l?.activity || ' '}</div>
              <div className="cell__usage">
                {l ? `${l.tokensIn + l.tokensOut} tok` : ' '}
              </div>
            </div>
          )
        })}
      </div>
      {agents.length > PAGE_SIZE && (
        <div className="grid__pager">
          <button className="pager__btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹</button>
          <span className="pager__info" aria-current="page">Page {page} of {totalPages} ({agents.length} agents)</span>
          <button className="pager__btn" aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>›</button>
        </div>
      )}
    </div>
  )
}
