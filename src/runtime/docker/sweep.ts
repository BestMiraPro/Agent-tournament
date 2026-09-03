import { docker, type DockerFn } from './cli.js'

/**
 * The exact shape `containerName()` produces: `arena-<runId>-<shardIndex>`.
 *
 * This regex is the safety boundary of the whole sweep, so it is deliberately strict.
 * `.+` is greedy and the shard index must be the final segment and purely numeric, which
 * is what keeps a container merely *resembling* one of ours out of the sweep:
 * `arena-lookalike-notours` has no numeric tail, `my-arena-db` is not anchored at
 * `arena-`, and `arena-run1-0-suffix` has trailing junk. All three are left alone.
 */
const ARENA_NAME = /^arena-(.+)-(\d+)$/

export interface ArenaName {
  runId: string
  shardIndex: number
}

/** Returns the run and shard a container name encodes, or null if it is not ours. */
export function parseArenaName(name: string): ArenaName | null {
  const m = ARENA_NAME.exec(name.trim())
  if (!m) return null
  return { runId: m[1]!, shardIndex: Number(m[2]) }
}

export interface SweepOptions {
  /**
   * Runs that are starting or already running. Their containers are never removed.
   * Matched exactly, so a run whose id merely shares a prefix is still swept.
   * A set, not a single id: on a host that runs several tournaments at once, every
   * live run's containers must survive, not only the one performing the sweep.
   */
  activeRunIds?: string[]
  onWarning?: (message: string) => void
}

/**
 * Removes shard containers stranded by a previous run and returns the names removed.
 *
 * If the orchestrator is SIGKILLed or the machine loses power, `disposeAll` never runs
 * and every container it started survives indefinitely — holding memory and a published
 * port until someone removes them by hand. The stable `arena-<runId>-<shardIndex>` naming
 * makes them recoverable: this is the startup sweep that collects them.
 *
 * Two rules make it safe to run unattended, and both are enforced here rather than
 * trusted to the daemon's own filtering:
 *
 *  1. A name is only ever removed if it parses as exactly `arena-<runId>-<shardIndex>`.
 *     Anything else — including a container that merely contains "arena" — is skipped
 *     without a removal even being attempted.
 *  2. Containers belonging to any run in `activeRunIds` are skipped, so a sweep at the
 *     start of a run can never destroy that run — or any other live run on the host.
 *
 * Never throws: a sweep failure must not stop a run from starting.
 *
 * NOTE: a run NOT passed in `activeRunIds` is indistinguishable from an orphan, and will
 * be swept. The caller must therefore pass every live run id it knows about (the server
 * path passes every registered docker run plus the run starting now).
 */
export async function sweepOrphanContainers(
  opts: SweepOptions = {},
  run: DockerFn = docker,
): Promise<string[]> {
  const removed: string[] = []
  let listed
  try {
    // The anchored filter is a cheap narrowing, not the safety boundary — every name it
    // returns is re-validated below.
    listed = await run(['ps', '-a', '--filter', 'name=^arena-', '--format', '{{.Names}}'], 20_000)
  } catch (e) {
    opts.onWarning?.(`Could not list containers to sweep: ${(e as Error).message}`)
    return removed
  }
  if (listed.code !== 0) {
    opts.onWarning?.(
      `Could not list containers to sweep: ${(listed.stderr || listed.stdout).trim().slice(-300)}`,
    )
    return removed
  }

  for (const raw of listed.stdout.split('\n')) {
    const name = raw.trim()
    if (!name) continue
    const parsed = parseArenaName(name)
    if (!parsed) continue
    if (opts.activeRunIds?.includes(parsed.runId)) continue

    try {
      const r = await run(['rm', '-f', name], 30_000)
      if (r.code !== 0) {
        opts.onWarning?.(
          `Could not remove stranded container ${name}: ` +
            `${(r.stderr || r.stdout).trim().slice(-300)}`,
        )
        continue
      }
      removed.push(name)
    } catch (e) {
      opts.onWarning?.(`Could not remove stranded container ${name}: ${(e as Error).message}`)
    }
  }
  return removed
}
