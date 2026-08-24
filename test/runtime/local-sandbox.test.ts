import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { LocalSandbox } from '../../src/runtime/local-sandbox.js'

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'arena-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('LocalSandbox', () => {
  test('provision creates a directory per agent', async () => {
    const root = await tmp()
    const sb = new LocalSandbox(root)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    expect(h1.workspacePath).not.toBe(h2.workspacePath)
    await sb.writeFile(h1, 'X.md', 'one')
    await sb.writeFile(h2, 'X.md', 'two')
    expect(await sb.readFile(h1, 'X.md')).toBe('one')
    expect(await sb.readFile(h2, 'X.md')).toBe('two')
  })

  test('readFile returns null for a missing file', async () => {
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', {})
    expect(await sb.readFile(h, 'nope.md')).toBeNull()
  })

  test('writeFile creates nested directories', async () => {
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, '.opencode/agents/competitor.md', 'genome')
    expect(await sb.readFile(h, '.opencode/agents/competitor.md')).toBe('genome')
  })

  test('reset clears the workspace', async () => {
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'X.md', 'data')
    await sb.reset(h, {})
    expect(await sb.readFile(h, 'X.md')).toBeNull()
  })

  test('reset re-seeds from the seed directory', async () => {
    const seed = await tmp()
    await mkdir(join(seed, 'sub'), { recursive: true })
    await writeFile(join(seed, 'README.md'), 'hello')
    await writeFile(join(seed, 'sub', 'nested.txt'), 'deep')
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', { seedDir: seed })
    await sb.reset(h, { seedDir: seed })
    expect(await sb.readFile(h, 'README.md')).toBe('hello')
    expect(await sb.readFile(h, 'sub/nested.txt')).toBe('deep')
  })

  test('listFiles reports relative paths and byte counts, recursively', async () => {
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'A.md', 'abc')
    await sb.writeFile(h, 'sub/B.md', 'de')
    const files = (await sb.listFiles(h)).sort((x, y) => x.path.localeCompare(y.path))
    expect(files).toEqual([
      { path: 'A.md', bytes: 3 },
      { path: 'sub/B.md', bytes: 2 },
    ])
  })

  test('teardown marks the handle unusable but preserves files on disk', async () => {
    const root = await tmp()
    const sb = new LocalSandbox(root)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'X.md', 'keep me')
    await sb.teardown(h)
    await expect(sb.readFile(h, 'X.md')).rejects.toThrow(/torn down/i)
    const sb2 = new LocalSandbox(root)
    const h2 = await sb2.provision('a1', {})
    expect(await sb2.readFile(h2, 'X.md')).toBe('keep me')
  })

  test('rejects paths that escape the workspace', async () => {
    const sb = new LocalSandbox(await tmp())
    const h = await sb.provision('a1', {})
    await expect(sb.writeFile(h, '../escape.md', 'x')).rejects.toThrow(/escape|outside/i)
  })
})
