import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'

/**
 * Per-run transient files under the workspace root: `<run id>/shard-N/{TOOLS.md,tools.json}` and,
 * for protected runs, `<run id>/shard-N-config/{opencode.json,models.json}`. Shards mount only
 * their own `shard-N` workspace and these read-only folders, never the rest.
 */
export const RUNTIME_DIR = '.arena-runtime'

const RUN_ID = /^[A-Za-z0-9._-]+$/

/**
 * Removes runtime folders a previous process left behind when it stopped without disposing its
 * runs (a crash, a killed terminal). Saved results live elsewhere in the workspace and are never
 * touched.
 *
 * Only a real folder directly inside `<workspace>/.arena-runtime`, named like a run id and not
 * belonging to an active run, is removed — and only after its resolved path is confirmed to sit
 * inside the runtime folder, so a link cannot redirect a recursive delete. Never throws.
 */
export async function sweepOrphanRuntimeDirs(opts: {
  workspaceRoot: string
  activeRunIds: readonly string[]
  onWarning?: (message: string) => void
}): Promise<string[]> {
  const runtimeRoot = join(opts.workspaceRoot, RUNTIME_DIR)
  let base: string
  try {
    const info = await lstat(runtimeRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) return []
    base = await realpath(runtimeRoot)
  } catch {
    return []
  }
  const removed: string[] = []
  let entries
  try {
    entries = await readdir(runtimeRoot)
  } catch (e) {
    opts.onWarning?.(`Could not list stale runtime folders in ${runtimeRoot}: ${(e as Error).message}`)
    return removed
  }
  for (const name of entries) {
    if (!RUN_ID.test(name) || name === '.' || name === '..' || opts.activeRunIds.includes(name)) continue
    const dir = join(runtimeRoot, name)
    try {
      const info = await lstat(dir)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      const resolved = await realpath(dir)
      if (!resolved.startsWith(base + sep)) continue
      await rm(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (e) {
      opts.onWarning?.(`Could not remove the stale runtime folder ${dir}: ${(e as Error).message}`)
    }
  }
  return removed
}
