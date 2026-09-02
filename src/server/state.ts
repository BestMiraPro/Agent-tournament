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
}

export interface RunSnapshot {
  runId: string
  name: string
  lastRoundIdx: number
  goalMd: string | null
  agents: SnapshotAgent[]
  scores: SnapshotScore[]
}

/** The full picture the dashboard renders on connect, before any live event arrives. */
export function buildRunSnapshot(repos: Repos, runId: string): RunSnapshot | null {
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
  let goalMd: string | null = null
  if (lastRoundIdx > 0) {
    const rounds = repos.rounds.listForRun?.(runId) ?? []
    const last = rounds.find((r) => r.idx === lastRoundIdx)
    if (last) {
      goalMd = last.goalMd
      scores = repos.scores.forRound(last.id).map((s) => ({
        agentId: s.agentId,
        rank: s.rank,
        score: s.score,
        band: s.band,
        rationaleMd: s.rationaleMd,
      }))
    }
  }

  return { runId, name: run.name, lastRoundIdx, goalMd, agents: snapshotAgents, scores }
}
