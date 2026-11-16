import { createHash } from 'node:crypto'
import type { FileEntry } from '../core/types.js'
import type { AgentHandle, Sandbox } from '../runtime/sandbox.js'
import { WorkspaceEscapeError } from '../runtime/workspace-path.js'

export const SUBMISSION_FILE = 'SUBMISSION.md'

/**
 * Whether an agent's execution is known to have stopped.
 *
 * `unsupported` means the runner offers no way to stop it (a mock, or a runner predating
 * this interface); `unconfirmed` means remote termination was not proven. Both
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
  // Installed packages are not the agent's work: listed, never read or hashed.
  const work = files.filter((f) => !isDependencyPath(f.path))

  const budget = opts.hashBudget
  const totalBytes = work.reduce((n, f) => n + f.bytes, 0)
  const withinBudget =
    budget === undefined || (work.length <= budget.maxFiles && totalBytes <= budget.maxBytes)

  const hashes: Record<string, string> = {}
  if (withinBudget) {
    for (const f of work) {
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
    let now: string | null
    try {
      now = await sandbox.readFile(handle, path)
    } catch (e) {
      // Narrow on purpose. The path WAS a readable file inside the workspace when it was
      // hashed, so the workspace refusing it now means it is no longer that file — a link
      // swapped in, most obviously — which is a change to report rather than an exception
      // to fail the round with. Left to propagate, replacing one's own captured file with
      // a symlink at collect time would abort everyone's round.
      //
      // Anything else (EIO, EACCES, a full disk) is NOT evidence of interference, and
      // reporting it as tampering would accuse an agent of something never observed. Those
      // still propagate.
      if (!(e instanceof WorkspaceEscapeError)) throw e
      modified.push(path)
      continue
    }
    if (now === null) missing.push(path)
    else if (hash(now) !== digest) modified.push(path)
  }

  let planted: string[] = []
  if (capture.hashesComplete) {
    const known = new Set(capture.files.map((f) => f.path))
    planted = (await sandbox.listFiles(handle)).map((f) => f.path).filter((p) => !known.has(p) && !isDependencyPath(p))
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
  /** Disk an agent's workspace may use, as `diskUsage` counts it. */
  maxBytes: number
}

export interface QuotaVerdict {
  ok: boolean
  reason: string | null
  /** Disk used, as `diskUsage` counts it. */
  totalBytes: number
  fileCount: number
}

/**
 * The least disk one file is counted as using: a filesystem allocates whole blocks, and an
 * empty file still takes an inode. Counting every file as at least this much lets a disk limit
 * alone also bound the file count, so no process can exhaust the inodes with empty files.
 */
export const MIN_FILE_BYTES = 4096

/** What a set of files is counted as using on disk: each file at least `MIN_FILE_BYTES`. */
export function diskUsage(files: readonly FileEntry[]): number {
  return files.reduce((n, f) => n + Math.max(f.bytes, MIN_FILE_BYTES), 0)
}

/**
 * Folders that hold installed packages or caches, not work. They count for disk like anything
 * else, but they are not hashed, stored or judged: an agent that installs a dependency to test
 * its code would otherwise have thousands of library files read into the orchestrator.
 */
export const DEPENDENCY_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
])

/** Whether a workspace-relative path lies inside a dependency folder. */
export function isDependencyPath(path: string): boolean {
  return path.split(/[\\/]/).slice(0, -1).some((segment) => DEPENDENCY_DIRS.has(segment))
}

/**
 * Hashing reads every hashed file into the orchestrator, so it stops past this many files:
 * the capture is kept but left unhashed, as for a hostile agent's million files. A bound on
 * the orchestrator's work, not a limit on agents; dependency folders do not count toward it.
 */
export const HASH_BUDGET_FILES = 2000

/** A disk size for a message: GiB or MiB to one decimal, or whole KiB below a MiB. */
export function formatDiskSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GiB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${Math.ceil(bytes / 1024)} KiB`
}

/**
 * Caps the disk one agent's workspace may use. Docker's `fsize` ulimit bounds a single file
 * and `--pids-limit` bounds processes; neither stops ONE process from creating files until
 * the filesystem runs out of inodes, which `MIN_FILE_BYTES` per file closes without a
 * separate file-count limit.
 */
export function checkQuota(files: readonly FileEntry[], quota: Quota): QuotaVerdict {
  const totalBytes = diskUsage(files)
  const fileCount = files.length
  if (totalBytes > quota.maxBytes) {
    return {
      ok: false,
      totalBytes,
      fileCount,
      reason: `workspace uses ${formatDiskSize(totalBytes)} of disk (${fileCount} files, each counted as at least 4 KiB), limit is ${formatDiskSize(quota.maxBytes)}`,
    }
  }
  return { ok: true, reason: null, totalBytes, fileCount }
}
