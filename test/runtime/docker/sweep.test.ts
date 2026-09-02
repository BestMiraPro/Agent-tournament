import { describe, expect, test, vi } from 'vitest'
import { parseArenaName, sweepOrphanContainers } from '../../../src/runtime/docker/sweep.js'

/** Reuses the argv-recording fake-docker shape used across the docker tests. */
const fakeDocker = (names: string[], rmCode: (name: string) => number = () => 0) => {
  const calls: string[][] = []
  const run = vi.fn(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'ps') return { stdout: names.join('\n') + '\n', stderr: '', code: 0 }
    if (args[0] === 'rm') {
      const code = rmCode(args[args.length - 1]!)
      return { stdout: '', stderr: code === 0 ? '' : 'No such container', code }
    }
    return { stdout: '', stderr: '', code: 0 }
  })
  const removeAttempts = () => calls.filter((c) => c[0] === 'rm').map((c) => c[c.length - 1])
  return { run, calls, removeAttempts }
}

describe('parseArenaName', () => {
  test('parses names produced by containerName, including dashed run ids', () => {
    expect(parseArenaName('arena-run1-0')).toEqual({ runId: 'run1', shardIndex: 0 })
    expect(parseArenaName('arena-2026-08-25-abc-3')).toEqual({ runId: '2026-08-25-abc', shardIndex: 3 })
  })

  test('rejects anything that is not exactly arena-<runId>-<shardIndex>', () => {
    // A trailing segment that is not a shard index is not one of ours.
    expect(parseArenaName('arena-lookalike-notours')).toBeNull()
    // Not prefixed with arena- at all: someone else's container that merely
    // contains the word "arena".
    expect(parseArenaName('my-arena-db')).toBeNull()
    expect(parseArenaName('arena-')).toBeNull()
    expect(parseArenaName('arena--1')).toBeNull()
    expect(parseArenaName('arena-run1-0-suffix')).toBeNull()
    expect(parseArenaName('prefix-arena-run1-0')).toBeNull()
  })
})

describe('sweepOrphanContainers', () => {
  test('force-removes stranded arena containers and returns their names', async () => {
    const d = fakeDocker(['arena-old-0', 'arena-old-1'])
    await expect(sweepOrphanContainers({}, d.run)).resolves.toEqual(['arena-old-0', 'arena-old-1'])
    expect(d.calls).toContainEqual(['rm', '-f', 'arena-old-0'])
  })

  test('asks the daemon for an anchored arena- name filter', async () => {
    const d = fakeDocker([])
    await sweepOrphanContainers({}, d.run)
    const ps = d.calls.find((c) => c[0] === 'ps')!
    expect(ps).toContain('name=^arena-')
  })

  // NEGATIVE SAFETY TEST 1: nothing outside the exact arena-<runId>-<shard> shape
  // may ever be removed, no matter what the daemon lists back at us.
  test('never touches a container that is not exactly arena-<runId>-<shardIndex>', async () => {
    const d = fakeDocker([
      'arena-lookalike-notours',
      'my-arena-db',
      'postgres',
      'arena-run1-0-suffix',
      'arena-real-0',
    ])
    const removed = await sweepOrphanContainers({}, d.run)
    expect(removed).toEqual(['arena-real-0'])
    expect(d.removeAttempts()).toEqual(['arena-real-0'])
    expect(d.removeAttempts()).not.toContain('arena-lookalike-notours')
    expect(d.removeAttempts()).not.toContain('my-arena-db')
  })

  // NEGATIVE SAFETY TEST 2: a tournament that is running right now must survive
  // a sweep, even though its containers are perfectly arena-shaped.
  test('never sweeps the live run', async () => {
    const d = fakeDocker(['arena-live-0', 'arena-live-1', 'arena-dead-0'])
    const removed = await sweepOrphanContainers({ activeRunId: 'live' }, d.run)
    expect(removed).toEqual(['arena-dead-0'])
    expect(d.removeAttempts()).toEqual(['arena-dead-0'])
  })

  test('a run id that merely prefixes the live one is still swept', async () => {
    const d = fakeDocker(['arena-live-extra-0'])
    const removed = await sweepOrphanContainers({ activeRunId: 'live' }, d.run)
    expect(removed).toEqual(['arena-live-extra-0'])
  })

  test('warns and keeps going when one removal fails', async () => {
    const d = fakeDocker(['arena-a-0', 'arena-b-0'], (n) => (n === 'arena-a-0' ? 1 : 0))
    const warnings: string[] = []
    const removed = await sweepOrphanContainers(
      { onWarning: (m) => warnings.push(m) },
      d.run,
    )
    expect(removed).toEqual(['arena-b-0'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/arena-a-0/)
  })

  test('warns and returns nothing when the daemon cannot be listed', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: 'daemon not running', code: 1 }))
    const warnings: string[] = []
    await expect(
      sweepOrphanContainers({ onWarning: (m) => warnings.push(m) }, run),
    ).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })

  test('never throws, even if the docker call itself rejects', async () => {
    const run = vi.fn(async () => { throw new Error('spawn ENOENT') })
    const warnings: string[] = []
    await expect(
      sweepOrphanContainers({ onWarning: (m) => warnings.push(m) }, run),
    ).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })
})
