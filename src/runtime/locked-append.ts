import { appendFile, mkdir, rmdir, stat } from 'node:fs/promises'

/**
 * Appends to a file under the team channel helper's lock (`<file>.lock`, a directory), with the
 * same bounded wait and stale-lock rule as POST_HELPER_SOURCE, so a post the engine writes and
 * one an agent writes never lose each other. The write itself is an append either way: past the
 * wait it goes ahead, as the helper's does.
 */
export async function appendUnderLock(file: string, text: string): Promise<void> {
  const lock = `${file}.lock`
  const deadline = Date.now() + 5000
  let locked = false
  while (!locked) {
    try {
      await mkdir(lock)
      locked = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 10_000) {
          await rmdir(lock)
          continue
        }
      } catch {
        /* the holder let go between the two calls */
      }
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    await appendFile(file, text, 'utf8')
  } finally {
    if (locked) await rmdir(lock).catch(() => {})
  }
}
