import { createHash } from 'node:crypto'
import type { FileEntry } from '../core/types.js'
import type { AgentHandle, Sandbox } from '../runtime/sandbox.js'

export const SUBMISSION_FILE = 'SUBMISSION.md'

/**
 * Whether an agent's execution is known to have stopped.
 *
 * `unsupported` means the runner offers no way to stop it (a mock, or a runner predating
 * this interface); `unconfirmed` means we asked and did not get an acknowledgement. Both
 * are reasons NOT to certify a capture, which is why they are distinct from `stopped`.
 */
export type QuiesceStatus = 'stopped' | 'unconfirmed' | 'unsupported'

/** A runner that can stop one agent and confirm the agent is no longer executing. */
export interface Quiescer {
  quiesce(handle: AgentHandle): Promise<QuiesceStatus>
}

/**
 * Stops one agent before its workspace is read.
 *
 * Without this the runner returning only means the orchestrator stopped *waiting*: the
 * agent's own session can still be mid-tool-call and can still write into the directory
 * that is about to be hashed, so the hash would certify a file the agent kept editing.
 * Capability-checked rather than required, so a runner without `quiesce` still works —
 * it just reports `unsupported`, and the caller must not certify what it captures.
 */
export async function quiesceAgent(runner: unknown, handle: AgentHandle): Promise<QuiesceStatus> {
  const q = (runner as Partial<Quiescer>).quiesce
  if (typeof q !== 'function') return 'unsupported'
  try {
    return await q.call(runner as Quiescer, handle)
  } catch {
    // A failed abort is not a failed round; it is a capture we may not certify.
    return 'unconfirmed'
  }
}

/**
 * A sandbox that can say whether an agent's workspace is reachable by anyone else.
 *
 * Docker shards a population across containers, and agents sharing one container share a
 * bind mount: each can write into the others' workspaces. Whether that is the case is a
 * fact about the topology, which only the sandbox knows.
 */
export interface Isolator {
  isolatedWorkspace(handle: AgentHandle): boolean
}

/**
 * Whether this agent is the only party that could have written into its workspace.
 *
 * Capability-checked, and pessimistic when unsupported: a sandbox that cannot answer is
 * treated as if it had co-tenants. Guessing the other way would let an unverifiable
 * capture be reported as certified, which is the one outcome this module exists to
 * prevent.
 */
export function workspaceIsolated(sandbox: unknown, handle: AgentHandle): boolean {
  const f = (sandbox as Partial<Isolator>).isolatedWorkspace
  if (typeof f !== 'function') return false
  try {
    return f.call(sandbox as Isolator, handle) === true
  } catch {
    return false
  }
}

export interface Capture {
  submissionMd: string | null
  /** Hash of SUBMISSION.md; also present in `hashes` under that path. */
  sha256: string | null
  files: FileEntry[]
  /** path -> sha256 of the whole manifest, so auxiliary evidence is covered too. */
  hashes: Record<string, string>
  /** False when the manifest was too large to hash within the budget. */
  hashesComplete: boolean
  /**
   * True only when the caller proved that no party OTHER than the agent itself could
   * write here at capture time — the agent stopped, and nobody shares its workspace.
   * An unsealed capture may already hold a rival's substitute, so it is a preservation
   * copy and never evidence of what the agent produced.
   */
  sealed: boolean
  capturedAt: number
}

export interface CaptureOpts {
  /**
   * Assert that every process able to write into this workspace has stopped — the agent
   * (see `quiesceAgent`) and any co-tenant that shares it (see `workspaceIsolated`). The
   * caller owns this proof; capture cannot observe it.
   */
  executionStopped?: boolean
  /**
   * Ceiling on the work hashing may do. A workspace beyond it is captured but left
   * unhashed rather than reading a hostile agent's million files into the orchestrator.
   */
  hashBudget?: { maxFiles: number; maxBytes: number }
}

const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * Reads an agent's output the moment it finishes, rather than after the whole round.
 *
 * Agents in a shared container can reach each other's workspaces, and a tournament that
 * rewards rank can evolve toward deleting a rival's submission. Capturing immediately
 * shrinks the window in which that sabotage can destroy already-produced work.
 *
 * Capturing early does NOT by itself make the capture trustworthy: while co-tenants are
 * still executing, a substituted file is indistinguishable from the agent's own. That is
 * what `sealed` records, and why an unsealed capture is only ever a preservation copy.
 */
export async function captureSubmission(
  sandbox: Sandbox,
  handle: AgentHandle,
  opts: CaptureOpts = {},
): Promise<Capture> {
  const submissionMd = await sandbox.readFile(handle, SUBMISSION_FILE)
  const files = await sandbox.listFiles(handle)

  const budget = opts.hashBudget
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  const withinBudget =
    budget === undefined || (files.length <= budget.maxFiles && totalBytes <= budget.maxBytes)

  const hashes: Record<string, string> = {}
  if (withinBudget) {
    for (const f of files) {
      // SUBMISSION.md is already in hand; re-reading it would open a second window in
      // which its content could change between the two reads.
      const content =
        f.path === SUBMISSION_FILE ? submissionMd : await sandbox.readFile(handle, f.path)
      if (content !== null) hashes[f.path] = hash(content)
    }
  }

  return {
    submissionMd,
    sha256: submissionMd === null ? null : hash(submissionMd),
    files,
    hashes,
    hashesComplete: withinBudget,
    sealed: opts.executionStopped === true,
    capturedAt: Date.now(),
  }
}

export interface TamperVerdict {
  tampered: boolean
  detail: string | null
  /**
   * Whether `tampered` is a claim worth making, in whichever direction it points.
   * False when something could still have been writing, or when the capture was too
   * large to hash.
   */
  verified: boolean
}

const list = (paths: readonly string[]): string =>
  paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} (+${paths.length - 3} more)`

/**
 * Re-reads at collect time and compares against the capture.
 *
 * Every hashed path is re-checked, not just SUBMISSION.md: the judge is handed the file
 * manifest as supporting evidence, so a rival who rewrites `evidence/data.csv` and leaves
 * SUBMISSION.md alone would otherwise be reported as having changed nothing.
 */
export async function verifyCapture(
  sandbox: Sandbox,
  handle: AgentHandle,
  capture: Capture,
  opts: { executionStopped?: boolean } = {},
): Promise<TamperVerdict> {
  const missing: string[] = []
  const modified: string[] = []
  for (const [path, digest] of Object.entries(capture.hashes)) {
    const now = await sandbox.readFile(handle, path)
    if (now === null) missing.push(path)
    else if (hash(now) !== digest) modified.push(path)
  }

  let planted: string[] = []
  if (capture.hashesComplete) {
    const known = new Set(capture.files.map((f) => f.path))
    planted = (await sandbox.listFiles(handle)).map((f) => f.path).filter((p) => !known.has(p))
  }

  const detail =
    missing.includes(SUBMISSION_FILE)
      ? 'submission was deleted after it was captured'
      : modified.includes(SUBMISSION_FILE)
        ? 'submission was modified after it was captured'
        : missing.length > 0
          ? `captured files missing after capture: ${list(missing)}`
          : modified.length > 0
            ? `captured files modified after capture: ${list(modified)}`
            : planted.length > 0
              ? `files planted after capture: ${list(planted)}`
              : null

  const tampered = detail !== null

  // What makes a verdict trustworthy differs by direction, and conflating the two is how
  // a capture ends up certifying an attacker's file as the agent's own work.
  //
  // A POSITIVE finding needs the round-wide barrier. Without it, "changed since capture"
  // may simply be the agent still working on its own submission, which is not
  // interference at all. Given the barrier, a difference is an observed fact.
  //
  // A NEGATIVE finding needs that AND a sealed capture. An unsealed capture was read
  // while a co-tenant could write, so the recorded bytes may already BE the substitute;
  // re-reading them unchanged proves only that the attacker finished before we looked.
  // That is the TOCTOU window, and calling it "intact, verified" is exactly the lie this
  // flag exists to prevent.
  const verified =
    opts.executionStopped === true && capture.hashesComplete && (tampered || capture.sealed)

  return { tampered, detail, verified }
}

export interface Quota {
  maxBytes: number
  maxFiles: number
}

export interface QuotaVerdict {
  ok: boolean
  reason: string | null
  totalBytes: number
  fileCount: number
}

/**
 * Caps what one agent may leave behind. Docker's `fsize` ulimit bounds a single file and
 * `--pids-limit` bounds processes; neither stops ONE process from creating files until the
 * filesystem runs out of inodes, so the file count is capped as well as the byte total.
 */
export function checkQuota(files: readonly FileEntry[], quota: Quota): QuotaVerdict {
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  const fileCount = files.length

  if (fileCount > quota.maxFiles) {
    return {
      ok: false,
      totalBytes,
      fileCount,
      reason: `workspace holds ${fileCount} files, limit is ${quota.maxFiles}`,
    }
  }
  if (totalBytes > quota.maxBytes) {
    return {
      ok: false,
      totalBytes,
      fileCount,
      reason: `workspace holds ${totalBytes} bytes, limit is ${quota.maxBytes}`,
    }
  }
  return { ok: true, reason: null, totalBytes, fileCount }
}
