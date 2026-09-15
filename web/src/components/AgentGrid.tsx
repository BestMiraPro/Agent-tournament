import { useEffect, useState, type KeyboardEvent } from 'react'
import type { Placement, SnapshotAgent } from '../api.js'
import { evidenceAgeLabel } from '../lib/activity.js'
import type { LiveAgent, LiveState, PendingPermission } from '../useLiveRun.js'

const STATUS_LABEL: Record<string, string> = {
  pending: 'waiting',
  running: 'working',
  done: 'done',
  failed: 'failed',
}

const PAGE_SIZE = 24

/**
 * What the usage line can honestly say.
 *
 * A count is shown only once usage was actually reported — then even 0 is a fact. Before
 * that it is pending; and an attempt that ended without any report has unavailable usage,
 * which is not the same thing as having spent nothing.
 */
export function usageLabel(live: LiveAgent | undefined): string {
  if (!live) return ' '
  if (live.usageReported) return `${live.tokensIn + live.tokensOut} tok`
  return live.status === 'done' || live.status === 'failed' ? 'Usage unavailable' : 'Usage pending'
}

/** What an agent stalled on an unanswered permission request is waiting for, and for how long. */
export function permissionLabel(p: PendingPermission, now: number): string {
  const seconds = Math.max(0, Math.floor((now - p.since) / 1000))
  const age = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
  const target = p.patterns.length > 0 ? ` ${p.patterns.join(', ')}` : ''
  return `Waiting for permission: ${p.permission}${target} · ${age}`
}

/**
 * Which container an agent is planned into this round, and whether others share it. Plans are
 * made per round from the active population, so this is the current placement, not a fixed one.
 */
export function placementLabel(placement: Placement[] | null | undefined, agentId: string): string | null {
  const container = placement?.find((p) => p.agentIds.includes(agentId))
  if (!container) return null
  const others = container.agentIds.length - 1
  return others <= 0
    ? `Container ${container.shardIndex} · own container`
    : `Container ${container.shardIndex} · shared with ${others} other agent${others === 1 ? '' : 's'}`
}

export function AgentGrid({ agents, live, onSelect, placement }: {
  agents: SnapshotAgent[]
  live: LiveState
  onSelect?: (agentId: string) => void
  placement?: Placement[] | null
}) {
  const rankOf = new Map(live.scores.map((s) => [s.agentId, s.rank]))
  // Rank alone shows the order but not the gap, so the strength of selection
  // pressure — whether #1 is barely ahead or running away with it — was invisible
  // without opening each agent's drawer.
  const scoreOf = new Map(live.scores.map((s) => [s.agentId, s.score]))
  const scoredAsFailed = new Set(live.scores.filter((s) => s.failed === true).map((s) => s.agentId))
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [agents.length])
  // Ages are only honest if they advance while no event arrives, so re-render on a timer.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])
  const totalPages = Math.ceil(agents.length / PAGE_SIZE)
  const visible = agents.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <div className="grid">
        {visible.map((a) => {
          const l = live.agents[a.agentId]
          const status = l?.status ?? 'pending'
          const rank = rankOf.get(a.agentId)
          const score = scoreOf.get(a.agentId)
          // A failed agent can still hold rank 1 with a zero score; it is not a winner.
          const failed = status === 'failed' || scoredAsFailed.has(a.agentId)
          const statusLabel = STATUS_LABEL[status] ?? status
          return (
            <div
              key={a.agentId}
              className={`cell cell--${status}${onSelect ? ' cell--selectable' : ''}`}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={`Agent ${a.label}, ${a.modelId}, ${statusLabel}${l?.failure ? `: ${l.failure.message}` : ''}`}
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
                {/* data-rank styles the podium; a failed agent never gets it, whatever its rank. */}
                {rank !== undefined && (
                  <span
                    className={`cell__rank${failed ? ' cell__rank--failed' : ''}`}
                    data-rank={failed ? undefined : rank}
                    title={failed ? 'Ranked, but this attempt failed' : undefined}
                  >
                    #{rank}
                  </span>
                )}
              </div>
              <div className="cell__model" title={a.modelId}>{a.modelId}</div>
              {placementLabel(placement, a.agentId) && (
                <div className="cell__placement">{placementLabel(placement, a.agentId)}</div>
              )}
              {score !== undefined && (
                <div className="cell__score">{score.toFixed(1)}</div>
              )}
              <div className="cell__status">{statusLabel}</div>
              {l?.failure && (
                <div className="cell__failure" title={l.failure.message}>{l.failure.message}</div>
              )}
              {l?.permission ? (
                <div className="cell__permission" title={permissionLabel(l.permission, now)}>
                  {permissionLabel(l.permission, now)}
                </div>
              ) : (
                <div className="cell__activity" title={l?.activity || undefined}>{l?.activity || ' '}</div>
              )}
              {l?.lastObservedAt ? (
                <div className="cell__evidence">{evidenceAgeLabel(l.lastObservedAt, now, status)}</div>
              ) : null}
              <div className="cell__usage">{usageLabel(l)}</div>
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
