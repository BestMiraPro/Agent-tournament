import { useEffect, useState } from 'react'
import { getRoundStats, type RoundStats } from '../api.js'
import { comparableRoundSegments } from '../lib/goals.js'
import { WORKER_COST_HEADING, WORKER_COST_TITLE } from '../lib/cost.js'

export interface AnalyticsAgent {
  agentId: string
  label: string
  parentAgentId: string | null
}

interface TreeNode {
  agent: AnalyticsAgent
  children: TreeNode[]
}

const byLabel = (a: TreeNode, b: TreeNode): number =>
  a.agent.label < b.agent.label ? -1 : a.agent.label > b.agent.label ? 1 : 0

function buildTree(agents: AnalyticsAgent[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(agents.map((a) => [a.agentId, { agent: a, children: [] }]))
  const roots: TreeNode[] = []
  for (const n of nodes.values()) {
    const parent = n.agent.parentAgentId ? nodes.get(n.agent.parentAgentId) : undefined
    if (parent) parent.children.push(n)
    // A null parent, or a parent missing from the snapshot (dead), starts a root.
    else roots.push(n)
  }
  roots.sort(byLabel)
  for (const n of nodes.values()) n.children.sort(byLabel)
  return roots
}

const W = 480
const H = 180
const PAD_L = 44
const PAD_R = 8
const PAD_T = 8
const PAD_B = 20

function FitnessChart({ rounds }: { rounds: RoundStats[] }) {
  const segments = comparableRoundSegments(rounds).map((segment) => segment.map((round) => rounds.indexOf(round)))
  let lo = Math.min(...rounds.map((r) => r.fitness.min))
  let hi = Math.max(...rounds.map((r) => r.fitness.max))
  // Flat scale: equal values would divide by zero, so pad the domain.
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const n = rounds.length
  const x = (i: number): number => (n === 1 ? W / 2 : PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R))
  const y = (v: number): number => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B)

  const series = [
    { key: 'mean', cls: 'chart-line chart-line--mean', get: (r: RoundStats) => r.fitness.mean, label: 'mean' },
    { key: 'max', cls: 'chart-line chart-line--max', get: (r: RoundStats) => r.fitness.max, label: 'max' },
    { key: 'min', cls: 'chart-line chart-line--min', get: (r: RoundStats) => r.fitness.min, label: 'min' },
  ] as const
  const mid = (lo + hi) / 2

  return (
    <figure className="analytics__chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fitness over rounds">
        {[lo, mid, hi].map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD_L - 4} y={y(t) + 3} textAnchor="end" className="chart-tick">{t.toFixed(2)}</text>
          </g>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            {segments.map((seg, si) => (
              <polyline
                key={si}
                className={s.cls}
                points={seg.map((i) => `${x(i)},${y(s.get(rounds[i]!))}`).join(' ')}
              />
            ))}
            {/* Dots keep single-point segments (one completed round) visible. */}
            {rounds.map((r, i) => (
              <circle key={i} cx={x(i)} cy={y(s.get(r))} r={2} className={s.cls} />
            ))}
          </g>
        ))}
        {rounds.map((r, i) => (
          <text key={r.idx} x={x(i)} y={H - 6} textAnchor="middle" className="chart-tick">{r.idx}</text>
        ))}
        {/*
          Rounds judged in batched mode have rank-derived scores, not judge scores, so
          they sit on a different scale from the rest of the line. Marking them keeps
          the axis honest instead of letting the curve imply a comparison that is not
          there.
        */}
        {rounds.map((r, i) => (
          r.scoreScale === 'rank'
            ? <rect key={`sc-${r.idx}`} className="chart-scalemark" x={x(i) - 4} y={0} width={8} height={H - 16} />
            : null
        ))}
      </svg>
      <figcaption className="analytics__legend">
        <span className="legend-swatch legend-swatch--mean" /> mean
        <span className="legend-swatch legend-swatch--max" /> max
        <span className="legend-swatch legend-swatch--min" /> min
        {segments.length > 1 && <span className="muted"> · line breaks where the goal or score scale changed</span>}
        {rounds.some((r) => r.scoreScale === 'rank') && (
          <span className="muted">
            {' '}· shaded rounds were judged in batches, so their scores are derived from
            rank rather than the judge and are not comparable with the rest
          </span>
        )}
      </figcaption>
    </figure>
  )
}

function RoundTable({ rounds }: { rounds: RoundStats[] }) {
  // Union of models across rounds, first-appearance order.
  const models: string[] = []
  for (const r of rounds) {
    for (const m of r.modelShare) {
      if (!models.includes(m.modelId)) models.push(m.modelId)
    }
  }
  return (
    <table className="leaderboard">
      <thead>
        <tr>
          <th>Round</th><th>Mean</th><th>Min</th><th>Max</th>
          <th title={WORKER_COST_TITLE}>{WORKER_COST_HEADING}</th><th>Diversity</th>
          {models.map((m) => <th key={m} title={m}>{m}</th>)}
        </tr>
      </thead>
      <tbody>
        {rounds.map((r) => {
          const total = r.modelShare.reduce((sum, m) => sum + m.count, 0)
          const countOf = new Map(r.modelShare.map((m) => [m.modelId, m.count]))
          return (
            <tr key={r.idx}>
              <td>{r.idx}</td>
              <td>{r.fitness.mean.toFixed(2)}</td>
              <td>{r.fitness.min.toFixed(2)}</td>
              <td>{r.fitness.max.toFixed(2)}</td>
              <td>{`$${r.costUsd.toFixed(4)}`}</td>
              <td>{r.diversity.toFixed(3)}</td>
              {models.map((m) => {
                const count = countOf.get(m) ?? 0
                const pct = total === 0 ? 0 : (count / total) * 100
                return <td key={m} title={`${pct.toFixed(1)}%`}>{count}</td>
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function LineageTree({ nodes, onOpenAgent }: {
  nodes: TreeNode[]
  onOpenAgent: (agentId: string) => void
}) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.agent.agentId}>
          <button className="tree__node" onClick={() => onOpenAgent(n.agent.agentId)}>
            {n.agent.label}
          </button>
          {n.children.length > 0 && <LineageTree nodes={n.children} onOpenAgent={onOpenAgent} />}
        </li>
      ))}
    </ul>
  )
}

export function AnalyticsPanel({ runId, agents, onOpenAgent, refreshKey }: {
  runId: string
  agents: AnalyticsAgent[]
  onOpenAgent: (agentId: string) => void
  refreshKey: unknown
}) {
  const [rounds, setRounds] = useState<RoundStats[] | null>(null)
  const [loading, setLoading] = useState(true)

  // First load shows a line; later refreshes stay silent so a flaky fetch never
  // wipes the chart — the arena's own refresh already surfaces connection problems.
  useEffect(() => {
    let alive = true
    getRoundStats(runId)
      .then((r) => { if (alive) { setRounds(r); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshKey])

  if (loading && rounds === null) return <p className="muted">Loading analytics…</p>
  if (!rounds || rounds.length === 0) return null

  return (
    <section className="analytics" aria-label="Run analytics" aria-busy={loading && rounds === null}>
      <h2>Analytics</h2>
      <FitnessChart rounds={rounds} />
      <RoundTable rounds={rounds} />
      <section>
        <h3>Lineage</h3>
        {/* Snapshot carries active agents only — dead agents are not tree nodes. */}
        <LineageTree nodes={buildTree(agents)} onOpenAgent={onOpenAgent} />
      </section>
    </section>
  )
}
