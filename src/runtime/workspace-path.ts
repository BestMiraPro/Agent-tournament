import { cp, lstat, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export class WorkspaceEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEscapeError'
  }
}

// The configured anchor and its ancestors are trusted, stable operator paths.
// Reject links below it, including the workspace directory and every destination.
// ponytail: lstat/open races remain; hostile concurrent writers need OS isolation
// or a stable snapshot. Unconfirmed quiesce still permits unsealed preservation reads.
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
      // there is nothing left to check. The caller's own operation reports the reason.
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

export async function seedWorkspace(dir: string, seedDir: string | undefined, anchor: string): Promise<void> {
  await resolveInWorkspace(dir, '', anchor)
  await mkdir(dir, { recursive: true })
  if (seedDir === undefined) return
  // Operator-selected seed links are trusted; agent-controlled destinations are not.
  await cp(seedDir, dir, {
    recursive: true,
    dereference: true,
    filter: async (_source, destination) => {
      await resolveInWorkspace(dir, relative(dir, destination), anchor)
      return true
    },
  })
}
