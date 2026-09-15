import { describe, expect, test } from 'vitest'
import { buildGatewayRunArgs, gatewayName, gatewayScript } from '../../../src/runtime/docker/gateway.js'

describe('shard gateway', () => {
  test('is named per run and shard, in a form the orphan sweep can attribute to its run', () => {
    expect(gatewayName('run-7', 2)).toBe('arena-run-7-gw-2')
  })

  test('forwards exactly two fixed routes: host to worker API, worker to the host relay', () => {
    const script = gatewayScript(41234)
    expect(script).toContain('pipe(14096,"worker",4096)')
    expect(script).toContain('pipe(8787,"host.docker.internal",41234)')
    expect(script.match(/pipe\(\d+,/g)).toHaveLength(2)
    for (const bad of [0, 70000, 1.5, Number.NaN]) expect(() => gatewayScript(bad)).toThrow(/relay port/)
  })

  test('runs unprivileged, read-only and small, publishing only the worker API on loopback', () => {
    const args = buildGatewayRunArgs({ runId: 'run-7', shardIndex: 0, image: 'agent-arena:tc-x', relayPort: 41234 })
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'arena-run-7-gw-0'])
    const joined = args.join(' ')
    for (const expected of [
      '--label arena.owner=agent-tournament', '--label arena.run=run-7',
      '-m 64m', '--memory-swap 64m', '--cpus 0.25', '--pids-limit 64',
      '--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--user 1000:1000',
      '-p 127.0.0.1:0:14096',
    ]) expect(joined).toContain(expected)
    expect(joined).not.toContain('auth.json')
    expect(args.filter((a) => a === '-p')).toHaveLength(1)
    expect(args.slice(-4, -1)).toEqual(['agent-arena:tc-x', 'node', '-e'])
    expect(args.at(-1)).toBe(gatewayScript(41234))
  })
})
