import type { Repos } from '../db/repos.js'

export interface SnapshotAgent {
  agentId: string
  label: string
  modelId: string
  temperature: number
  strategyMd: string
  bornRound: number
  parentAgentId: string | null
}

export interface SnapshotScore {
  agentId: string
  rank: number
  score: number
  band: string | null
  rationaleMd: string
  /** The agent's submission for that round did not succeed; its rank is not a win. */
  failed: boolean
}

/** The criteria a round actually has on record, as distinct from any editor draft. */
export interface AppliedCriteria {
  roundIdx: number
  /** Null while a round that asked for generated criteria is still waiting for them. */
  criteriaMd: string | null
  source: 'user' | 'generated'
  status: string
}

export interface RunSnapshot {
  runId: string
  name: string
  lastRoundIdx: number
  goalMd: string | null
  /**
   * Criteria supplied when the run was created — the draft default before round 1. Kept
   * on the server so it is visible in the editor and survives a reload, instead of living
   * in a browser variable that could be sent without ever being shown.
   */
  initialCriteria: string | null
  /** What the latest round (in flight or finished) has recorded; null before round 1. */
  lastRoundCriteria: AppliedCriteria | null
  agents: SnapshotAgent[]
  scores: SnapshotScore[]
  sandbox: string
  roster: { modelId: string; count: number; temperature: number }[]
  capacity: { committed: number; maxContainers: number } | null
  warnings: string[]
}

export interface RunSnapshotExtra {
  sandbox?: string
  roster?: { modelId: string; count: number; temperature: number }[]
  capacity?: { committed: number; maxContainers: number } | null
  warnings?: string[]
}

/** The full picture the dashboard renders on connect, before any live event arrives. */
export function buildRunSnapshot(repos: Repos, runId: string, extra?: RunSnapshotExtra): RunSnapshot | null {
  const run = repos.runs.get(runId)
  if (!run) return null

  const lastRoundIdx = repos.rounds.lastIdx(runId)
  const agents = repos.agents.listActive(runId)

  const snapshotAgents: SnapshotAgent[] = agents.map((a) => {
    // A newly bred agent has a genome for the NEXT round, not the last completed one.
    const genome =
      repos.genomes.forRound(a.id, lastRoundIdx + 1) ??
      repos.genomes.forRound(a.id, lastRoundIdx)
    return {
      agentId: a.id,
      label: a.label,
      modelId: genome?.modelId ?? 'unknown',
      temperature: genome?.temperature ?? 0,
      strategyMd: genome?.strategyMd ?? '',
      bornRound: a.bornRound,
      parentAgentId: a.parentAgentId,
    }
  })

  let scores: SnapshotScore[] = []
  let goalMd: string | null = run.initialGoal
  let lastRoundCriteria: AppliedCriteria | null = null
  if (lastRoundIdx > 0) {
    const rounds = repos.rounds.listForRun?.(runId) ?? []
    const last = rounds.find((r) => r.idx === lastRoundIdx)
    if (last) {
      goalMd = last.goalMd
      lastRoundCriteria = {
        roundIdx: last.idx,
        criteriaMd: last.criteriaMd,
        source: last.criteriaSource === 'user' ? 'user' : 'generated',
        status: last.status,
      }
      const failedAgents = new Set(
        repos.submissions.forRound(last.id).filter((sub) => sub.status !== 'ok').map((sub) => sub.agentId),
      )
      scores = repos.scores.forRound(last.id).map((s) => ({
        agentId: s.agentId,
        rank: s.rank,
        score: s.score,
        band: s.band,
        rationaleMd: s.rationaleMd,
        failed: failedAgents.has(s.agentId),
      }))
    }
  }

  return {
    runId, name: run.name, lastRoundIdx, goalMd,
    initialCriteria: run.initialCriteria,
    lastRoundCriteria,
    agents: snapshotAgents, scores,
    sandbox: extra?.sandbox ?? run.config.sandbox,
    roster: extra?.roster ?? run.config.roster,
    capacity: extra?.capacity ?? null,
    warnings: extra?.warnings ?? [],
  }
}
