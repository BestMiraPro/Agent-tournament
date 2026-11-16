import type { ChannelMessage, TeamOutput } from '../api.js'

/** Which members' activity showed them writing each file of a round's output. */
export function fileContributors(output: Pick<TeamOutput, 'contributions'>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const c of Object.values(output.contributions)) {
    for (const path of c.files) out.set(path, [...(out.get(path) ?? []), c.label].sort())
  }
  return out
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

/** `agent-02 → @agent-01 · 10:00:05` for a channel entry's header. */
export function channelHeader(m: Pick<ChannelMessage, 'author' | 'target' | 'postedAt'>): string {
  const at = new Date(m.postedAt)
  const time = Number.isNaN(at.getTime()) ? m.postedAt : at.toISOString().slice(11, 19)
  return `${m.author}${m.target ? ` → @${m.target}` : ''} · ${time}`
}

/** One line on what the seal says about a snapshot. */
export function sealLine(output: Pick<TeamOutput, 'sealed' | 'hashesComplete' | 'digest' | 'fileCount' | 'totalBytes'>): string {
  const seal = output.sealed && output.hashesComplete
    ? 'sealed after every agent stopped'
    : output.sealed ? 'sealed, but too large to hash in full' : 'not certifiable: an agent was not confirmed stopped'
  return `${output.fileCount} file${output.fileCount === 1 ? '' : 's'}, ${formatBytes(output.totalBytes)} · ${seal} · ${output.digest.slice(0, 19)}…`
}
