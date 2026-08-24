import { describe, expect, test, vi } from 'vitest'
import { containerName, startShardContainer, waitForHealth } from '../../../src/runtime/docker/container.js'

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

  test('throws when no port could be discovered', async () => {
    const fake = vi.fn(async (args: string[]) => {
      if (args[0] === 'inspect') return { stdout: 'false', stderr: '', code: 0 }
      if (args[0] === 'port') return { stdout: '', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    await expect(startShardContainer(spec, fake, async () => true)).rejects.toThrow(/port/i)
  })
})
