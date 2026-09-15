import { describe, expect, test, vi } from 'vitest'
import type { DockerFn } from '../../../src/runtime/docker/cli.js'
import { createShardNetwork, removeShardNetwork, shardNetworkName } from '../../../src/runtime/docker/network.js'

const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 })
const fail = (stderr: string) => ({ stdout: '', stderr, code: 1 })

describe('shard networks', () => {
  test('are named per run and shard', () => {
    expect(shardNetworkName('run-7', 2)).toBe('arena-run-7-net-2')
  })

  test('are created internal, labelled with the run that owns them', async () => {
    const calls: string[][] = []
    const docker: DockerFn = async (args) => { calls.push(args); return ok('abc123') }
    await expect(createShardNetwork('run-7', 0, docker)).resolves.toBe('arena-run-7-net-0')
    expect(calls).toEqual([[
      'network', 'create', '--internal',
      '--label', 'arena.owner=agent-tournament', '--label', 'arena.run=run-7',
      'arena-run-7-net-0',
    ]])
  })

  test('an existing network is adopted only when this run owns it', async () => {
    const existing = (label: string): DockerFn => async (args) =>
      args[1] === 'create' ? fail('Error response from daemon: network with name arena-run-7-net-0 already exists') : ok(label)
    await expect(createShardNetwork('run-7', 0, existing('run-7'))).resolves.toBe('arena-run-7-net-0')
    await expect(createShardNetwork('run-7', 0, existing('someone-else'))).rejects.toThrow(
      /arena-run-7-net-0 already exists and belongs to "someone-else", not run run-7/,
    )
  })

  test('refuses a run id that cannot be part of a network name', async () => {
    const docker = vi.fn<DockerFn>()
    await expect(createShardNetwork('../x', 0, docker)).rejects.toThrow(/unsafe run id/)
    expect(docker).not.toHaveBeenCalled()
  })

  test('removal never throws: a missing network is gone, any other failure is reported', async () => {
    const warnings: string[] = []
    expect(await removeShardNetwork('arena-r-net-0', (m) => warnings.push(m), async () => fail('Error: No such network: arena-r-net-0'))).toBe(true)
    expect(await removeShardNetwork('arena-r-net-0', (m) => warnings.push(m), async () => fail('error while removing network: network has active endpoints'))).toBe(false)
    expect(await removeShardNetwork('arena-r-net-0', (m) => warnings.push(m), async () => { throw new Error('docker gone') })).toBe(false)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/Could not remove network arena-r-net-0: error while removing network: network has active endpoints/)
  })
})
