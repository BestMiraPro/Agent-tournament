import { describe, expect, test } from 'vitest'
import { MockSandbox } from '../../src/runtime/mock-sandbox.js'

describe('MockSandbox', () => {
  test('provisions a handle with an isolated workspace', async () => {
    const sb = new MockSandbox()
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    await sb.writeFile(h1, 'X.md', 'one')
    await sb.writeFile(h2, 'X.md', 'two')
    expect(await sb.readFile(h1, 'X.md')).toBe('one')
    expect(await sb.readFile(h2, 'X.md')).toBe('two')
  })

  test('readFile returns null for a missing file', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    expect(await sb.readFile(h, 'nope.md')).toBeNull()
  })

  test('reset clears the workspace', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'X.md', 'data')
    await sb.reset(h, {})
    expect(await sb.readFile(h, 'X.md')).toBeNull()
  })

  test('reset re-seeds from the seed directory', async () => {
    const sb = new MockSandbox({ seedFiles: { 'README.md': 'hello' } })
    const h = await sb.provision('a1', { seedDir: '/seed' })
    await sb.reset(h, { seedDir: '/seed' })
    expect(await sb.readFile(h, 'README.md')).toBe('hello')
  })

  test('listFiles reports paths and byte counts', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'A.md', 'abc')
    const files = await sb.listFiles(h)
    expect(files).toEqual([{ path: 'A.md', bytes: 3 }])
  })

  test('teardown makes the handle unusable', async () => {
    const sb = new MockSandbox()
    const h = await sb.provision('a1', {})
    await sb.teardown(h)
    await expect(sb.readFile(h, 'X.md')).rejects.toThrow(/torn down/i)
  })
})
