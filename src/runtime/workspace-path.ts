import { cp, lstat, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Thrown instead of returning, reading or writing something outside the workspace.
 *
 * Distinct from ENOENT on purpose: a caller that maps "missing file" to `null` must not
 * also map "this path leaves the workspace" to `null`, which would turn a rejected
 * escape into a silent empty answer.
 */
export class WorkspaceEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEscapeError'
  }
}

/**
 * Resolves an agent-supplied relative path to a host path inside its workspace.
 *
 * The lexical check alone was not enough. `resolve()` collapses `..` textually, so a
 * path that stays inside the workspace *as text* still lands wherever a link points
 * once the host opens it: the agent writes `SUBMISSION.md -> C:/Users/me/.ssh/id_rsa`,
 * capture reads the workspace copy, and the orchestrator hands a host file to a judge.
 * Ancestor links are the same problem one level up — `notes/` as a junction makes every
 * path under it leave the workspace. Docker does not help: the host follows the link
 * during capture whether or not it resolves to anything inside the container.
 *
 * The policy is therefore no links at all, anywhere between `anchor` and the target,
 * checked with `lstat` (which describes the entry itself, not what it points at, and
 * which reports a Windows junction as a link too). Every component is checked, not just
 * the last one.
 *
 * `anchor` is where checking starts, and it matters for shared shards. The workspace
 * directory itself is a component a co-tenant can delete and replace with a link, which
 * is the ancestor attack one level above the workspace; passing the sandbox root as the
 * anchor puts `shard-N/<agentId>` under the same policy as everything inside it. What is
 * never checked is the configured root itself — that is ours, and demanding it be
 * link-free would reject ordinary setups where a temp or home directory is a link.
 *
 * RESIDUAL RACE — this is a containment check, not a security boundary. Between this
 * walk and the caller's open/write, a writer that still has the workspace can swap a
 * checked component for a link. Two things narrow that window and neither closes it:
 * B15 refuses to prepare or capture while an agent's own execution is unconfirmed, and
 * `sealed`/`verified` stay false for a shared shard, where co-tenants are never stopped
 * by one agent's quiesce. Treat a shared shard as reachable by its co-tenants.
 */
export async function resolveInWorkspace(
  base: string,
  relPath: string,
  anchor?: string,
): Promise<string> {
  const root = resolve(base)
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new WorkspaceEscapeError(`path "${relPath}" escapes the workspace`)
  }

  const from = anchor === undefined ? root : resolve(anchor)
  if (root !== from && !root.startsWith(from + sep)) {
    // A caller wiring error, not something an agent can cause.
    throw new Error(`anchor "${anchor}" does not contain workspace "${base}"`)
  }

  const rest = relative(from, target)
  if (rest === '') return target

  let current = from
  for (const part of rest.split(sep)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // Nothing exists below a component that is missing or is not a directory, so
      // there is nothing left to check. The caller's own operation reports the reason:
      // ENOENT for a read, or a fresh directory created under our control for a write.
      if (code === 'ENOENT' || code === 'ENOTDIR') break
      throw e
    }
    if (info.isSymbolicLink()) {
      const at = relative(from, current).split(sep).join('/')
      throw new WorkspaceEscapeError(`path "${relPath}" crosses a link at "${at}"`)
    }
  }

  return target
}

/**
 * Creates a workspace directory and copies the optional seed into it.
 *
 * `dereference` is deliberate: a link inside the seed would otherwise be copied AS a
 * link, and every later read of that path would be refused by the policy above — a
 * confusing failure for something the operator supplied rather than something an agent
 * did. Copying what the link points at keeps the workspace link-free by construction.
 * The seed directory is configuration, so following its links is the operator's choice.
 */
export async function seedWorkspace(dir: string, seedDir?: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  if (seedDir === undefined) return
  await cp(seedDir, dir, { recursive: true, dereference: true })
}
