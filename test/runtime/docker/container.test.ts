import { describe, expect, test, vi } from 'vitest'
import { buildProtectedRunArgs } from '../../../src/runtime/docker/cli.js'
import { containerName, inspectContainerState, startShardContainer, waitForHealth } from '../../../src/runtime/docker/container.js'
import { buildGatewayRunArgs } from '../../../src/runtime/docker/gateway.js'

describe('startShardContainer with the protected runtime', () => {
  const spec = {
    runId: 'run1', shardIndex: 0, image: 'agent-arena:tc-x', hostDir: '/host/shard-0', memory: '1g', cpus: 1,
    authFile: '/host/auth.json', toolsDir: '/host/tools',
    protectedRuntime: { network: 'arena-run1-net-0', configDir: '/host/config', relayPort: 41234 },
  }
  type Exec = { stdout: string; stderr: string; code: number }
  const fakeDocker = (over: (args: string[]) => Exec | undefined = () => undefined) => {
    const calls: string[][] = []
    const fn = vi.fn(async (args: string[]) => {
      calls.push(args)
      return over(args) ?? (args[0] === 'port' ? { stdout: '127.0.0.1:52000', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 })
    })
    return { fn, calls }
  }

  test('starts the worker on its shard network and the gateway beside it, and serves through the gateway', async () => {
    const d = fakeDocker()
    const r = await startShardContainer(spec, d.fn, async () => true)
    expect(r).toEqual({ name: 'arena-run1-0', baseUrl: 'http://127.0.0.1:52000', shardIndex: 0, gatewayName: 'arena-run1-gw-0', network: 'arena-run1-net-0' })
    const runs = d.calls.filter((c) => c[0] === 'run')
    expect(runs[0]).toEqual(buildProtectedRunArgs({
      name: 'arena-run1-0', image: 'agent-arena:tc-x', hostDir: '/host/shard-0', memory: '1g', cpus: 1,
      network: 'arena-run1-net-0', configDir: '/host/config', toolsDir: '/host/tools', contextDir: null,
    }))
    expect(runs[1]).toEqual(buildGatewayRunArgs({ runId: 'run1', shardIndex: 0, image: 'agent-arena:tc-x', relayPort: 41234 }))
    expect(d.calls).toContainEqual(['network', 'connect', '--alias', 'gateway', 'arena-run1-net-0', 'arena-run1-gw-0'])
    expect(d.calls).toContainEqual(['port', 'arena-run1-gw-0', '14096/tcp'])
    expect(d.calls.some((c) => c[0] === 'port' && c[1] === 'arena-run1-0')).toBe(false)
    expect(d.calls.flat().join(' ')).not.toContain('auth.json')
  })

  test('never adopts an existing worker or gateway: a protected shard starts fresh with this run\'s config', async () => {
    const d = fakeDocker((args) => (args[0] === 'inspect' ? { stdout: 'true', stderr: '', code: 0 } : undefined))
    await startShardContainer(spec, d.fn, async () => true)
    expect(d.calls.slice(0, 2)).toEqual([['rm', '-f', 'arena-run1-0'], ['rm', '-f', 'arena-run1-gw-0']])
    expect(d.calls.filter((c) => c[0] === 'run')).toHaveLength(2)
  })

  test('removes both containers when the gateway never serves', async () => {
    const d = fakeDocker()
    await expect(startShardContainer({ ...spec, healthTimeoutMs: 50 }, d.fn, async () => false)).rejects.toThrow(/health/i)
    const removals = d.calls.filter((c) => c[0] === 'rm').slice(2).map((c) => c[2])
    expect(removals).toEqual(['arena-run1-0', 'arena-run1-gw-0'])
  })

  test('removes the worker when the gateway cannot start, and says which part failed', async () => {
    const d = fakeDocker((args) => (args[0] === 'run' && args.includes('node') ? { stdout: '', stderr: 'port is already allocated', code: 1 } : undefined))
    await expect(startShardContainer(spec, d.fn, async () => true)).rejects.toThrow(/Failed to start gateway arena-run1-gw-0: port is already allocated/)
    expect(d.calls.at(-1)).toEqual(['rm', '-f', 'arena-run1-0'])
  })
})

describe('inspectContainerState', () => {
  const answer = (stdout: string, code = 0) => vi.fn(async () => ({ stdout, stderr: '', code }))

  test('reads whether the kernel OOM-killed the container', async () => {
    const run = answer('true|false\n')
    expect(await inspectContainerState('arena-r-0', run)).toEqual({ oomKilled: true, running: false })
    expect(run).toHaveBeenCalledWith(['inspect', '-f', '{{.State.OOMKilled}}|{{.State.Running}}', 'arena-r-0'], 20_000)
    expect(await inspectContainerState('arena-r-0', answer('false|true'))).toEqual({ oomKilled: false, running: true })
  })

  test('a missing container or unreadable output is unknown, not "not killed"', async () => {
    expect(await inspectContainerState('gone', answer('', 1))).toBeNull()
    expect(await inspectContainerState('odd', answer('<no value>|true'))).toBeNull()
  })
})

describe('containerName', () => {
  test('is stable and includes run and shard', () => {
    expect(containerName('run1', 0)).toBe('arena-run1-0')
    expect(containerName('run1', 3)).toBe('arena-run1-3')
  })
})

describe('waitForHealth', () => {
  test('resolves once the probe succeeds', async () => {
    let n = 0
    await expect(waitForHealth(async () => ++n >= 3, 2000, 5)).resolves.toBe(true)
    expect(n).toBe(3)
  })

  test('resolves false when the deadline passes', async () => {
    await expect(waitForHealth(async () => false, 60, 5)).resolves.toBe(false)
  })
})

describe('startShardContainer', () => {
  const spec = {
    runId: 'run1', shardIndex: 0, image: 'agent-arena:latest',
    hostDir: '/host/shard-0', memory: '1g', cpus: 1, authFile: null,
  }

  test('reuses an already-running container instead of recreating it', async () => {
    const calls: string[][] = []
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect') return { stdout: 'true', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:32769', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const r = await startShardContainer(spec, fake, async () => true)
    expect(r.baseUrl).toBe('http://127.0.0.1:32769')
    expect(calls.some((c) => c[0] === 'run')).toBe(false)
  })

  test('passes a host model catalogue through to docker run', async () => {
    let runArgs: string[] = []
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such object', code: 1 }
      if (args[0] === 'run') { runArgs = args; return { stdout: 'cid', stderr: '', code: 0 } }
      if (args[0] === 'port') return { stdout: '127.0.0.1:41000', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    await startShardContainer({ ...spec, modelsFile: '/host/models.json' }, fake, async () => true)
    expect(runArgs.join(' ')).toContain('/host/models.json:/root/.cache/opencode/models.json:ro')
  })

  test('removes a stopped container before starting a fresh one', async () => {
    const calls: string[][] = []
    let running = false
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect') return { stdout: running ? 'true' : 'false', stderr: '', code: 0 }
      if (args[0] === 'run') { running = true; return { stdout: 'cid', stderr: '', code: 0 } }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const r = await startShardContainer(spec, fake, async () => true)
    expect(calls.some((c) => c[0] === 'rm')).toBe(true)
    expect(calls.some((c) => c[0] === 'run')).toBe(true)
    expect(r.baseUrl).toBe('http://127.0.0.1:41000')
  })

  test('throws when the container starts but never becomes healthy', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: 'false', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(
      startShardContainer({ ...spec, healthTimeoutMs: 100 }, fake, async () => false),
    ).rejects.toThrow(/health/i)
  })

  // A container that `docker run` created is a real, running container even when the
  // post-start checks fail. If startShardContainer throws without removing it, nothing
  // ever learns its name again and it survives the run.
  test('force-removes the container it started when the health probe never succeeds', async () => {
    const calls: string[][] = []
    let running = false
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect') return { stdout: running ? 'true' : 'false', stderr: '', code: 0 }
      if (args[0] === 'run') { running = true; return { stdout: 'cid', stderr: '', code: 0 } }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      if (args[0] === 'rm') { running = false; return { stdout: '', stderr: '', code: 0 } }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(
      startShardContainer({ ...spec, healthTimeoutMs: 50 }, fake, async () => false),
    ).rejects.toThrow(/health/i)

    const verbs = calls.map((c) => c[0])
    expect(verbs.lastIndexOf('rm')).toBeGreaterThan(verbs.indexOf('run'))
    expect(calls.at(-1)).toEqual(['rm', '-f', 'arena-run1-0'])
  })

  test('force-removes the container it started when no port could be discovered', async () => {
    const calls: string[][] = []
    let running = false
    const fake = vi.fn(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'inspect') return { stdout: running ? 'true' : 'false', stderr: '', code: 0 }
      if (args[0] === 'run') { running = true; return { stdout: 'cid', stderr: '', code: 0 } }
      if (args[0] === 'port') return { stdout: '', stderr: '', code: 0 }
      if (args[0] === 'rm') { running = false; return { stdout: '', stderr: '', code: 0 } }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(startShardContainer(spec, fake, async () => true)).rejects.toThrow(/port/i)

    const verbs = calls.map((c) => c[0])
    expect(verbs.lastIndexOf('rm')).toBeGreaterThan(verbs.indexOf('run'))
  })

  test('a cleanup failure does not mask the original error', async () => {
    // inspect code 1 = no such container, so the only `rm` is the cleanup one.
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such object', code: 1 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      if (args[0] === 'rm') throw new Error('docker daemon went away')
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(
      startShardContainer({ ...spec, healthTimeoutMs: 50 }, fake, async () => false),
    ).rejects.toThrow(/health/i)
  })

  test('warns when the failure-path cleanup cannot remove the container', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such object', code: 1 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      if (args[0] === 'rm') return { stdout: '', stderr: 'daemon gone', code: 1 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const warnings: string[] = []
    await expect(
      startShardContainer({ ...spec, healthTimeoutMs: 50 }, fake, async () => false, (m) =>
        warnings.push(m),
      ),
    ).rejects.toThrow(/health/i)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/arena-run1-0/)
    expect(warnings[0]).toMatch(/daemon gone/)
  })

  test('does not warn when the failure-path cleanup succeeds', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: '', stderr: 'No such object', code: 1 }
      if (args[0] === 'port') return { stdout: '4096/tcp -> 127.0.0.1:41000', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const warnings: string[] = []
    await expect(
      startShardContainer({ ...spec, healthTimeoutMs: 50 }, fake, async () => false, (m) =>
        warnings.push(m),
      ),
    ).rejects.toThrow(/health/i)
    expect(warnings).toEqual([])
  })

  test('throws when no port could be discovered', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: 'false', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(startShardContainer(spec, fake, async () => true)).rejects.toThrow(/port/i)
  })
})
