import { createHash } from 'node:crypto'
import type { SubmissionStatus } from '../core/types.js'
import type { TeamContribution, TeamFileEntry } from '../db/repos.js'
import type { AgentHandle, Sandbox } from '../runtime/sandbox.js'
import { OUTPUT_DIR, OUTPUT_README } from '../runtime/team-prompt.js'
import type { AuditEvidence } from './audit.js'
import { checkQuota, type Quota } from './capture.js'
import { CHANNEL_FILE, type ChannelMember, type RecordedEntry } from './channel.js'

/** Text stored per file and per round with a snapshot; larger files are listed and hashed only. */
export const MAX_STORED_FILE_CHARS = 256 * 1024
export const MAX_STORED_ROUND_CHARS = 8 * 1024 * 1024
/** CHANNEL.md stored with a snapshot (its tail, when longer). */
export const MAX_STORED_CHANNEL_CHARS = 2 * 1024 * 1024

export interface TeamCapture {
  status: SubmissionStatus
  errorText: string | null
  files: TeamFileEntry[]
  /** Stored text by path. */
  contents: Map<string, string>
  digest: string
  sealed: boolean
  hashesComplete: boolean
  fileCount: number
  totalBytes: number
  readmeMd: string | null
  channelMd: string | null
  channelSha256: string | null
  capturedAt: number
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** What `readFile` decoded from bytes that were not text: a NUL, or replacement characters. */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000') || text.includes('�')
}

/**
 * Captures a team's output folder and channel ONCE, at the round-wide barrier.
 *
 * Every member has been quiesced by now, and a team workspace has no other writer, so
 * `executionStopped` is the whole proof a seal needs: per-agent capture and re-verification
 * exist to catch rivals, and a team has none. The digest covers every hashed file and the
 * channel, so the copy the grader reads and the dashboard shows can be checked against it.
 */
export async function captureTeamOutput(
  sandbox: Sandbox,
  handle: AgentHandle,
  opts: {
    executionStopped: boolean
    /** The team's caps: one agent's workspace caps per member. */
    quota: Quota
    /** Seeded paths and sizes; a seeded file still at its size does not count against the quota. */
    seeded?: ReadonlyMap<string, number>
  },
): Promise<TeamCapture> {
  const all = await sandbox.listFiles(handle)
  const counted = opts.seeded ? all.filter((f) => opts.seeded!.get(f.path) !== f.bytes) : all
  const quota = checkQuota(counted, opts.quota)

  const outputs = all.filter((f) => f.path.startsWith(`${OUTPUT_DIR}/`)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const totalBytes = outputs.reduce((n, f) => n + f.bytes, 0)
  const hashesComplete = outputs.length <= opts.quota.maxFiles && totalBytes <= opts.quota.maxBytes

  const files: TeamFileEntry[] = []
  const contents = new Map<string, string>()
  let storedChars = 0
  for (const f of outputs) {
    if (!hashesComplete) {
      files.push({ path: f.path, bytes: f.bytes, sha256: null, binary: false, stored: false })
      continue
    }
    const text = await sandbox.readFile(handle, f.path)
    if (text === null) continue
    const binary = looksBinary(text)
    const store = !binary && text.length <= MAX_STORED_FILE_CHARS && storedChars + text.length <= MAX_STORED_ROUND_CHARS
    if (store) {
      contents.set(f.path, text)
      storedChars += text.length
    }
    files.push({ path: f.path, bytes: f.bytes, sha256: sha(text), binary, stored: store })
  }

  const channel = await sandbox.readFile(handle, CHANNEL_FILE)
  const channelSha256 = channel === null ? null : sha(channel)
  const digest = `sha256:${sha(JSON.stringify({
    files: files.map((f) => [f.path, f.bytes, f.sha256]),
    channel: channelSha256,
  }))}`

  const status: SubmissionStatus = !quota.ok ? 'error' : files.length === 0 ? 'no_submission' : 'ok'
  return {
    status,
    errorText: quota.ok ? (files.length === 0 ? `${OUTPUT_DIR}/ is empty: the team produced nothing to judge` : null) : `team ${quota.reason}`,
    files,
    contents,
    digest,
    sealed: opts.executionStopped,
    hashesComplete,
    fileCount: files.length,
    totalBytes,
    readmeMd: contents.get(OUTPUT_README) ?? null,
    channelMd: channel === null ? null : channel.length > MAX_STORED_CHANNEL_CHARS ? channel.slice(-MAX_STORED_CHANNEL_CHARS) : channel,
    channelSha256,
    capturedAt: Date.now(),
  }
}

/** OpenCode tools that write files, as the event bridge summarises them (`<tool>: <target>`). */
const WRITING_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch'])
const MAX_CONTRIBUTION_FILES = 200

/** A path an agent reported, relative to the workspace when it is inside it; null otherwise. */
function workspaceRelative(path: string, workspacePath: string): string | null {
  const p = path.trim().replace(/\\/g, '/')
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p.startsWith('./') ? p.slice(2) : p
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:\//.test(rel) || rel.split('/').includes('..')) return null
  return rel
}

/**
 * Per-member contribution evidence: which files each member's own activity shows it writing,
 * how many tool calls it made, and how many channel posts it wrote. Only what was observed:
 * a file written by a shell command inside a tool call does not appear here.
 */
export function teamContributions(
  members: readonly ChannelMember[],
  records: readonly AuditEvidence[],
  entries: readonly RecordedEntry[],
  workspacePath: string,
): Record<string, TeamContribution> {
  const out: Record<string, TeamContribution> = {}
  for (const m of members) {
    const files = new Set<string>()
    let toolCalls = 0
    for (const r of records) {
      if (r.agentId !== m.agentId) continue
      if (r.kind === 'tool') toolCalls++
      let target: string | null = null
      if (r.kind === 'file' && r.summary.startsWith('edited ')) target = r.summary.slice('edited '.length)
      if (r.kind === 'tool' && r.outcome === 'completed') {
        const colon = r.summary.indexOf(': ')
        if (colon > 0 && WRITING_TOOLS.has(r.summary.slice(0, colon))) target = r.summary.slice(colon + 2)
      }
      const rel = target === null ? null : workspaceRelative(target, workspacePath)
      if (rel !== null && files.size < MAX_CONTRIBUTION_FILES) files.add(rel)
    }
    out[m.agentId] = {
      label: m.label,
      files: [...files].sort(),
      posts: entries.filter((e) => e.agentId === m.agentId).length,
      toolCalls,
    }
  }
  return out
}
