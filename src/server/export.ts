import type { AgentRow, GenomeRow, RunConfig } from '../core/types.js'
import type { Repos, RoundRow, RunRow } from '../db/repos.js'
import { readRoundAudit, type RoundAuditView } from '../engine/audit.js'
// One shape, one type. The local copy had already drifted: it declared durationMs as
// non-nullable while the row it is built from is nullable.
import { submissionView, type SubmissionView } from './submission-view.js'
import { teamRoundView, type TeamRoundView } from './team-views.js'

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
  /** Collaboration rounds also carry `team`: the score, the sealed output manifest and the channel. */
  rounds: (RoundRow & { entries: ExportEntry[]; audit: RoundAuditView; judging: unknown[]; team: TeamRoundView | null })[]
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
      team: teamRoundView(repos, round.id),
    }
  })
  const agents = repos.agents.listAll(runId)
  const genomes = agents.flatMap((a) => repos.genomes.forAgent(a.id))
  return { run, config: run.config, rounds, agents, genomes }
}

/**
 * The run as a markdown report another reader, or another agent, can act on without the
 * dashboard: what was asked, how each round went, who won, the strategy that won and
 * where it came from, and the winning submission with the judge's reasons.
 * The winner is rank 1 of the last scored round. Returns null for a missing run.
 */
export function buildMarkdownReport(runId: string, repos: Repos): string | null {
  const run = repos.runs.get(runId)
  if (!run) return null
  const agents = repos.agents.listAll(runId)
  const labelOf = new Map(agents.map((a) => [a.id, a.label]))
  const genomeById = new Map(agents.flatMap((a) => repos.genomes.forAgent(a.id)).map((g) => [g.id, g]))
  const rounds = repos.rounds.listForRun(runId)
  const scored = rounds
    .map((round) => ({ round, scores: repos.scores.forRound(round.id) }))
    .filter((r) => r.scores.length > 0)
  const subs = rounds.flatMap((round) => repos.submissions.forRound(round.id))
  const sum = (pick: (s: (typeof subs)[number]) => number): number => subs.reduce((n, s) => n + pick(s), 0)

  const out = [
    `# Tournament report: ${run.name}`,
    '',
    `- Run: ${run.id}`,
    `- Goal: ${rounds.at(-1)?.goalMd ?? run.initialGoal ?? ''}`,
    `- Sandbox: ${run.config.sandbox}`,
    `- Population: ${agents.length}, rounds scored: ${scored.length}`,
    `- Judge: ${run.config.judge.modelId}, reflector: ${run.config.reflect.modelId}`,
    `- Worker usage: ${sum((s) => s.tokensIn)} tokens in, ${sum((s) => s.tokensOut)} tokens out, $${sum((s) => s.costUsd).toFixed(4)}`,
    '',
  ]
  const last = scored.at(-1)
  if (!last) {
    out.push('No round has been scored yet.', '')
    return out.join('\n')
  }

  out.push('## Leaderboard by round', '', '| Round | Best | Mean | Leader | Model |', '|---|---|---|---|---|')
  for (const { round, scores } of scored) {
    const top = scores[0]!
    const mean = scores.reduce((n, s) => n + s.score, 0) / scores.length
    const model = repos.genomes.forRound(top.agentId, round.idx)?.modelId ?? ''
    out.push(`| ${round.idx} | ${top.score} | ${mean.toFixed(2)} | ${labelOf.get(top.agentId) ?? ''} | ${model} |`)
  }

  const winner = last.scores[0]!
  const genome = repos.genomes.forRound(winner.agentId, last.round.idx)
  out.push('', `## Winner: ${labelOf.get(winner.agentId) ?? ''} (round ${last.round.idx}, score ${winner.score})`, '')
  out.push('### Lineage', '')
  for (let g = genome; g; g = g.parentGenomeId ? genomeById.get(g.parentGenomeId) ?? null : null) {
    out.push(`- Round ${g.roundIdx}: ${g.origin}, ${labelOf.get(g.agentId) ?? ''}, ${g.modelId}`)
  }
  out.push('', '### Strategy', '', genome?.strategyMd ?? '_Not recorded_', '')
  out.push("### Judge's rationale", '', winner.rationaleMd, '')
  out.push(
    '### Submission',
    '',
    repos.submissions.forAgent(last.round.id, winner.agentId)?.submissionMd ?? '_No submission_',
    '',
  )
  if (last.round.criteriaMd) out.push(`## Criteria (round ${last.round.idx})`, '', last.round.criteriaMd, '')
  return out.join('\n')
}
