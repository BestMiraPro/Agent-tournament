import { describe, expect, test } from 'vitest'
import { buildGatewayRunArgs, gatewayName, gatewayScript } from '../../../src/runtime/docker/gateway.js'

describe('shard gateway', () => {
  test('is named per run and shard, in a form the orphan sweep can attribute to its run', () => {
    expect(gatewayName('run-7', 2)).toBe('arena-run-7-gw-2')
  })

  test('forwards exactly three fixed routes: host to worker API, worker to the host relay, worker to the host tool bridge', () => {
    const script = gatewayScript(41234, 41300)
    expect(script).toContain('pipe(14096,"worker",4096)')
    expect(script).toContain('pipe(8787,"host.docker.internal",41234)')
    expect(script).toContain('pipe(8788,"host.docker.internal",41300)')
    expect(script.match(/pipe\(\d+,/g)).toHaveLength(3)
    for (const bad of [0, 70000, 1.5, Number.NaN]) {
      expect(() => gatewayScript(bad, 41300)).toThrow(/relay port/)
      expect(() => gatewayScript(41234, bad)).toThrow(/tool bridge port/)
    }
  })

  test('the gateway\'s run arguments carry exactly the three routes, whatever the run enables', () => {
    const args = buildGatewayRunArgs({ runId: 'run-7', shardIndex: 0, image: 'agent-arena:tc-x', relayPort: 41234, toolsPort: 41300 })
    const script = args.at(-1)!
    expect(script.match(/pipe\((\d+),/g)).toEqual(['pipe(14096,', 'pipe(8787,', 'pipe(8788,'])
  })

  test('forwards model calls to the app\'s bridge address when the app itself runs in a container', () => {
    const script = gatewayScript(41234, 41300, '172.17.0.2')
    expect(script).toContain('pipe(8787,"172.17.0.2",41234)')
    expect(script).toContain('pipe(8788,"172.17.0.2",41300)')
    expect(script).toContain('pipe(14096,"worker",4096)')
    const args = buildGatewayRunArgs({ runId: 'run-7', shardIndex: 0, image: 'agent-arena:tc-x', relayPort: 41234, toolsPort: 41300, relayHost: '172.17.0.2' })
    expect(args.at(-1)).toBe(script)
    // Interpolated into the forwarder's source, so anything but a plain host name or address is refused.
    for (const bad of ['', 'a b', '1.2.3.4",1);process.exit(1);("']) expect(() => gatewayScript(41234, 41300, bad)).toThrow(/relay host/)
  })

  test('runs unprivileged, read-only and small, publishing only the worker API on loopback', () => {
    const args = buildGatewayRunArgs({ runId: 'run-7', shardIndex: 0, image: 'agent-arena:tc-x', relayPort: 41234, toolsPort: 41300 })
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
    expect(args.at(-1)).toBe(gatewayScript(41234, 41300))
  })
})
