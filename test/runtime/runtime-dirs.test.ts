import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { sweepOrphanRuntimeDirs } from '../../src/runtime/runtime-dirs.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-dirs-'))
  roots.push(root)
  const runtime = join(root, '.arena-runtime')
  for (const run of ['live', 'dead-1', 'dead-2']) {
    mkdirSync(join(runtime, run, 'shard-0'), { recursive: true })
    writeFileSync(join(runtime, run, 'shard-0', 'TOOLS.md'), 'x')
  }
  return { root, runtime }
}

describe('sweepOrphanRuntimeDirs', () => {
  test('removes the runtime folders of runs that are not active, and keeps the rest of the workspace', async () => {
    const { root, runtime } = workspace()
    mkdirSync(join(root, 'shard-0', 'a1'), { recursive: true })
    const removed = await sweepOrphanRuntimeDirs({ workspaceRoot: root, activeRunIds: ['live'] })
    expect(removed.sort()).toEqual([join(runtime, 'dead-1'), join(runtime, 'dead-2')])
    expect(existsSync(join(runtime, 'live', 'shard-0', 'TOOLS.md'))).toBe(true)
    expect(existsSync(join(root, 'shard-0', 'a1'))).toBe(true)
  })

  test('never follows a link out of the runtime folder, and skips names that are not run ids', async () => {
    const { root, runtime } = workspace()
    const outside = mkdtempSync(join(tmpdir(), 'runtime-dirs-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'keep.txt'), 'precious')
    let linked = true
    try {
      symlinkSync(outside, join(runtime, 'linked-run'), 'junction')
    } catch {
      linked = false // no permission to create links here; the name check below still runs
    }
    writeFileSync(join(runtime, 'a-file'), 'not a run folder')
    mkdirSync(join(runtime, 'bad name!'))
    const warnings: string[] = []
    await sweepOrphanRuntimeDirs({ workspaceRoot: root, activeRunIds: ['live'], onWarning: (m) => warnings.push(m) })
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    if (linked) expect(existsSync(join(runtime, 'linked-run'))).toBe(true)
    expect(existsSync(join(runtime, 'a-file'))).toBe(true)
    expect(existsSync(join(runtime, 'bad name!'))).toBe(true)
  })

  test('a workspace with no runtime folder is nothing to do, not an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-dirs-empty-'))
    roots.push(root)
    await expect(sweepOrphanRuntimeDirs({ workspaceRoot: root, activeRunIds: [] })).resolves.toEqual([])
  })
})
