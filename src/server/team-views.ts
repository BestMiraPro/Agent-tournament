import type { ChannelMessageRow, Repos, TeamOutputRow } from '../db/repos.js'

/** A collaboration round's sealed output as the API and the export show it: manifest, seal, contributions. */
export type TeamOutputView = Omit<TeamOutputRow, 'channelMd'>

export function teamOutputView(repos: Repos, roundId: string): TeamOutputView | null {
  const out = repos.teamOutputs.get(roundId)
  if (!out) return null
  const { channelMd: _channel, ...view } = out
  return view
}

export interface TeamScoreView {
  score: number
  rationaleMd: string
  status: string
}

export function teamScoreView(repos: Repos, roundId: string): TeamScoreView | null {
  const s = repos.teamScores.forRound(roundId)
  return s ? { score: s.score, rationaleMd: s.rationaleMd, status: s.status } : null
}

/** Everything a collaboration round recorded about its team; null for a tournament round. */
export interface TeamRoundView {
  score: TeamScoreView | null
  output: TeamOutputView | null
  channel: ChannelMessageRow[]
}

export function teamRoundView(repos: Repos, roundId: string): TeamRoundView | null {
  const score = teamScoreView(repos, roundId)
  const output = teamOutputView(repos, roundId)
  const channel = repos.channel.forRound(roundId)
  if (!score && !output && channel.length === 0) return null
  return { score, output, channel }
}
