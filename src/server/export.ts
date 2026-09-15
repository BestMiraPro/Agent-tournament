import type { AgentRow, GenomeRow, RunConfig } from '../core/types.js'
import type { Repos, RoundRow, RunRow } from '../db/repos.js'
import { readRoundAudit, type RoundAuditView } from '../engine/audit.js'
// One shape, one type. The local copy had already drifted: it declared durationMs as
// non-nullable while the row it is built from is nullable.
import { submissionView, type SubmissionView } from './submission-view.js'

/** RFC 4180: quote-and-escape when the field has comma/quote/newline/CR, else
 * raw. null/undefined and empty string render as empty (no quotes). */
export function csvEscape(field: unknown): string {
  if (field === null || field === undefined) return ''
  const s = String(field)
  if (s === '') return ''
  if (/["\n\r,]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export interface ExportEntry {
  agentId: string
  label: string
  modelId: string
  score: number
  rank: number
  band: string | null
  rationaleMd: string
  submission: SubmissionView | null
}

export interface JsonDump {
  run: RunRow
  config: RunConfig
  /** Each round carries its audit and grading record exactly as the endpoints return them. */
  rounds: (RoundRow & { entries: ExportEntry[]; audit: RoundAuditView; judging: unknown[] })[]
  agents: AgentRow[]
  genomes: GenomeRow[]
}

const CSV_HEADER = 'round,agentLabel,modelId,score,rank,band,tokensIn,tokensOut,costUsd,submissionStatus'

/** One row per (round x agent), rank-ordered within each round, CRLF line
 * endings (Excel-friendly). Unscored rounds contribute no rows. */
export function buildCsvRows(runId: string, repos: Repos): string {
  const byId = new Map(repos.agents.listAll(runId).map((a) => [a.id, a]))
  const lines = [CSV_HEADER]
  for (const round of repos.rounds.listForRun(runId)) {
    // scores.forRound is rank-ordered, so rows inherit that order.
    for (const s of repos.scores.forRound(round.id)) {
      const sub = repos.submissions.forAgent(round.id, s.agentId)
      const modelId = repos.genomes.forRound(s.agentId, round.idx)?.modelId ?? ''
      const label = byId.get(s.agentId)?.label ?? ''
      lines.push([
        csvEscape(round.idx),
        csvEscape(label),
        csvEscape(modelId),
        csvEscape(s.score),
        csvEscape(s.rank),
        csvEscape(s.band),
        csvEscape(sub?.tokensIn),
        csvEscape(sub?.tokensOut),
        csvEscape(sub?.costUsd),
        csvEscape(sub?.status),
      ].join(','))
    }
  }
  return lines.join('\r\n') + '\r\n'
}

/** Full run dump: run row + config, every round with its rank-ordered entries
 * (same submission join as the round-detail view), all agents, all genomes.
 * Returns null for a missing run; the export endpoint 404s before calling. */
export function buildJsonDump(runId: string, repos: Repos): JsonDump | null {
  const run = repos.runs.get(runId)
  if (!run) return null
  const byId = new Map(repos.agents.listAll(runId).map((a) => [a.id, a]))
  const rounds = repos.rounds.listForRun(runId).map((round) => {
    const entries = repos.scores.forRound(round.id).map((s) => {
      const sub = repos.submissions.forAgent(round.id, s.agentId)
      return {
        agentId: s.agentId,
        label: byId.get(s.agentId)?.label ?? '',
        modelId: repos.genomes.forRound(s.agentId, round.idx)?.modelId ?? '',
        score: s.score,
        rank: s.rank,
        band: s.band,
        rationaleMd: s.rationaleMd,
        submission: sub ? submissionView(sub) : null,
      }
    })
    return {
      ...round,
      entries,
      audit: readRoundAudit(repos, round.id),
      judging: repos.judgingAudits.forRound(round.id).map((row) => row.payload),
    }
  })
  const agents = repos.agents.listAll(runId)
  const genomes = agents.flatMap((a) => repos.genomes.forAgent(a.id))
  return { run, config: run.config, rounds, agents, genomes }
}
