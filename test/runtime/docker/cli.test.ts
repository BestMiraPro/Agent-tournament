import { describe, expect, test, vi } from 'vitest'
import { parsePortMapping, buildRunArgs, removeContainer } from '../../../src/runtime/docker/cli.js'

describe('parsePortMapping', () => {
  test('extracts the host port from docker port output', () => {
    expect(parsePortMapping('4096/tcp -> 127.0.0.1:32769')).toBe(32769)
  })

  test('handles 0.0.0.0 bindings', () => {
    expect(parsePortMapping('4096/tcp -> 0.0.0.0:41000')).toBe(41000)
  })

  test('takes the first mapping when several are printed', () => {
    expect(parsePortMapping('4096/tcp -> 127.0.0.1:32769\n4096/tcp -> [::1]:32770')).toBe(32769)
  })

  test('returns null when there is no mapping', () => {
    expect(parsePortMapping('')).toBeNull()
  })
})

describe('buildRunArgs', () => {
  const base = {
    name: 'arena-run1-0',
    image: 'agent-arena:latest',
    hostDir: '/host/shard-0',
    memory: '1g',
    cpus: 1,
    authFile: '/host/auth.json',
    pidsLimit: 256,
    maxFileBytes: 268_435_456,
  }

  test('publishes an ephemeral port bound to loopback only', () => {
    expect(buildRunArgs(base).join(' ')).toContain('-p 127.0.0.1:0:4096')
  })

  test('applies memory and cpu limits', () => {
    const a = buildRunArgs(base).join(' ')
    expect(a).toContain('-m 1g')
    expect(a).toContain('--cpus 1')
  })

  test('pins swap to the memory limit so a leak cannot thrash the host disk', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--memory-swap 1g')
  })

  test('caps process count to stop a fork bomb taking the machine down', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--pids-limit 256')
  })

  test('caps single-file size so an agent cannot fill the disk', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--ulimit fsize=268435456')
  })

  test('caps open file descriptors', () => {
    expect(buildRunArgs(base).join(' ')).toMatch(/--ulimit nofile=\d+/)
  })

  test('never grants GPU access', () => {
    expect(buildRunArgs(base).join(' ')).not.toContain('--gpus')
  })

  test('drops all Linux capabilities and blocks privilege escalation', () => {
    const a = buildRunArgs(base).join(' ')
    expect(a).toContain('--cap-drop ALL')
    expect(a).toContain('--security-opt no-new-privileges')
  })

  test('mounts the workspace read-write and auth read-only', () => {
    const a = buildRunArgs(base).join(' ')
    expect(a).toContain('/host/shard-0:/work')
    expect(a).toContain('/host/auth.json:/root/.local/share/opencode/auth.json:ro')
  })

  test('omits the auth mount when no auth file is configured', () => {
    expect(buildRunArgs({ ...base, authFile: null }).join(' ')).not.toContain('auth.json')
  })

  test('names the container', () => {
    expect(buildRunArgs(base).join(' ')).toContain('--name arena-run1-0')
  })
})

describe('removeContainer', () => {
  test('makes a failed removal visible instead of silently leaking the container', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: 'permission denied', code: 1 }))
    const warnings: string[] = []
    await expect(
      removeContainer('arena-run1-0', (m) => warnings.push(m), run),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/arena-run1-0/)
    expect(warnings[0]).toMatch(/permission denied/)
  })

  test('stays silent on success and never throws when docker itself rejects', async () => {
    const ok = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }))
    const warnings: string[] = []
    await removeContainer('arena-run1-0', (m) => warnings.push(m), ok)
    expect(warnings).toEqual([])

    const boom = vi.fn(async () => { throw new Error('spawn ENOENT') })
    await expect(
      removeContainer('arena-run1-0', (m) => warnings.push(m), boom),
    ).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})

describe('parsePortMapping bare host form', () => {
  // `docker port <name> 4096/tcp` prints only the host side, with no arrow.
  // Verified against a live daemon: this is what the production call site receives.
  test('parses the bare host:port form', () => {
    expect(parsePortMapping('127.0.0.1:32773')).toBe(32773)
  })

  test('parses a bare form with trailing whitespace', () => {
    expect(parsePortMapping(['127.0.0.1:32773', ''].join('\n'))).toBe(32773)
  })

  test('parses a bare 0.0.0.0 binding', () => {
    expect(parsePortMapping('0.0.0.0:41000')).toBe(41000)
  })

  test('parses a bare bracketed IPv6 binding', () => {
    expect(parsePortMapping('[::1]:41000')).toBe(41000)
  })

  test('still parses the arrow form from a bare `docker port` call', () => {
    expect(parsePortMapping('4096/tcp -> 127.0.0.1:32769')).toBe(32769)
  })

  test('returns null for unrelated output', () => {
    expect(parsePortMapping('Error: No such container')).toBeNull()
  })
})
