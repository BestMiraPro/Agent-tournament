import { describe, expect, test, vi } from 'vitest'
import { parseArenaName, parseGatewayName, sweepOrphanContainers, sweepOrphanNetworks } from '../../../src/runtime/docker/sweep.js'

describe('parseGatewayName', () => {
  test('parses gateway names, including dashed run ids, and never a worker name', () => {
    expect(parseGatewayName('arena-run1-gw-0')).toEqual({ runId: 'run1', shardIndex: 0 })
    expect(parseGatewayName('arena-2026-08-25-abc-gw-3')).toEqual({ runId: '2026-08-25-abc', shardIndex: 3 })
    expect(parseGatewayName('arena-run1-0')).toBeNull()
    expect(parseGatewayName('arena-run1-gw-x')).toBeNull()
    expect(parseGatewayName('arena--gw-0')).toBeNull()
  })
})

describe('sweepOrphanNetworks', () => {
  const fakeNetworks = (rows: string[], rmCode: (name: string) => number = () => 0) => {
    const calls: string[][] = []
    const run = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'ls') return { stdout: rows.join('\n') + '\n', stderr: '', code: 0 }
      if (args[1] === 'rm') {
        const code = rmCode(args[args.length - 1]!)
        return { stdout: '', stderr: code === 0 ? '' : 'error while removing network: network has active endpoints', code }
      }
      return { stdout: '', stderr: '', code: 0 }
    })
    return { run, calls }
  }

  test('removes only owned networks of runs that are not active', async () => {
    const d = fakeNetworks(['arena-live-net-0|live', 'arena-dead-net-0|dead', 'arena-dead-net-1|dead'])
    expect(await sweepOrphanNetworks({ activeRunIds: ['live'] }, d.run)).toEqual(['arena-dead-net-0', 'arena-dead-net-1'])
    expect(d.calls[0]).toEqual(['network', 'ls', '--filter', 'label=arena.owner=agent-tournament', '--format', '{{.Name}}|{{.Label "arena.run"}}'])
  })

  test('never removes a network without a run label, or one whose name does not match its label', async () => {
    const d = fakeNetworks(['bridge|', 'arena-x-net-0|', 'arena-a-net-0|b', 'someones-net|c', 'arena-c-net-0|c'])
    expect(await sweepOrphanNetworks({}, d.run)).toEqual(['arena-c-net-0'])
  })

  test('a network still in use is reported and kept; the rest continue', async () => {
    const d = fakeNetworks(['arena-a-net-0|a', 'arena-b-net-0|b'], (n) => (n === 'arena-a-net-0' ? 1 : 0))
    const warnings: string[] = []
    expect(await sweepOrphanNetworks({ onWarning: (m) => warnings.push(m) }, d.run)).toEqual(['arena-b-net-0'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/arena-a-net-0/)
  })

  test('never throws when the daemon cannot be listed', async () => {
    const warnings: string[] = []
    await expect(sweepOrphanNetworks({ onWarning: (m) => warnings.push(m) }, vi.fn(async () => { throw new Error('spawn ENOENT') }))).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
  })
})

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
    const removed = await sweepOrphanContainers({ activeRunIds: ['live'] }, d.run)
    expect(removed).toEqual(['arena-dead-0'])
    expect(d.removeAttempts()).toEqual(['arena-dead-0'])
  })

  // A gateway name also ends in a number. Read as a worker, `arena-live-gw-0` belongs to a run
  // called "live-gw", which is not active — so a sweep would have removed a live run's gateway.
  test('never sweeps a live run\'s gateway, and sweeps a dead run\'s', async () => {
    const d = fakeDocker(['arena-live-gw-0', 'arena-live-0', 'arena-dead-gw-1'])
    const removed = await sweepOrphanContainers({ activeRunIds: ['live'] }, d.run)
    expect(removed).toEqual(['arena-dead-gw-1'])
    expect(d.removeAttempts()).toEqual(['arena-dead-gw-1'])
  })

  test('a run id that merely prefixes the live one is still swept', async () => {
    const d = fakeDocker(['arena-live-extra-0'])
    const removed = await sweepOrphanContainers({ activeRunIds: ['live'] }, d.run)
    expect(removed).toEqual(['arena-live-extra-0'])
  })

  // The server path sweeps while other runs are still up: every live run in the
  // set must survive, not only the one performing the sweep.
  test('never sweeps any run in the active set, even concurrently', async () => {
    const d = fakeDocker(['arena-a-0', 'arena-a-1', 'arena-b-2', 'arena-dead-0'])
    const removed = await sweepOrphanContainers(
      { activeRunIds: ['a', 'b'] },
      d.run,
    )
    expect(removed).toEqual(['arena-dead-0'])
    expect(d.removeAttempts()).toEqual(['arena-dead-0'])
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
