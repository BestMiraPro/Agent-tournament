import { describe, expect, test, vi } from 'vitest'
import { parsePortMapping, buildProtectedRunArgs, buildRunArgs, removeContainer } from '../../../src/runtime/docker/cli.js'

describe('buildProtectedRunArgs', () => {
  const spec = {
    name: 'arena-run-7-0',
    image: 'agent-arena:tc-x',
    hostDir: 'C:\\ws\\shard-0',
    memory: '1g',
    cpus: 1,
    network: 'arena-run-7-net-0',
    configDir: 'C:\\ws\\.arena-runtime\\run-7\\shard-0\\config',
    toolsDir: 'C:\\ws\\.arena-runtime\\run-7\\shard-0\\tools',
    contextDir: null,
  }

  test('joins only its shard network, publishes nothing and mounts no credentials', () => {
    const args = buildProtectedRunArgs(spec)
    const joined = args.join(' ')
    expect(joined).toContain('--network arena-run-7-net-0 --network-alias worker')
    expect(args).not.toContain('-p')
    expect(joined).not.toContain('auth.json')
    expect(joined).not.toContain('/root/')
  })

  test('runs as a fixed non-root user on a read-only root with bounded writable scratch', () => {
    const joined = buildProtectedRunArgs(spec).join(' ')
    for (const expected of [
      '--read-only', '--user 1000:1000', '-e HOME=/home/arena',
      '--tmpfs /home/arena:rw,uid=1000,gid=1000,size=256m', '--tmpfs /tmp:rw,uid=1000,gid=1000,size=256m',
      '-v C:\\ws\\shard-0:/work',
    ]) expect(joined).toContain(expected)
  })

  test('keeps every existing limit', () => {
    const joined = buildProtectedRunArgs(spec).join(' ')
    for (const expected of ['-m 1g', '--memory-swap 1g', '--cpus 1', '--pids-limit 256', '--cap-drop ALL', '--security-opt no-new-privileges', '--ulimit fsize=268435456', '-e OMP_NUM_THREADS=1']) {
      expect(joined).toContain(expected)
    }
  })

  test('reads its relay config, catalogue and tool manifest read-only, copying the catalogue into its home at start', () => {
    const args = buildProtectedRunArgs(spec)
    const joined = args.join(' ')
    expect(joined).toContain('-v C:\\ws\\.arena-runtime\\run-7\\shard-0\\config:/run/arena-config:ro')
    expect(joined).toContain('-v C:\\ws\\.arena-runtime\\run-7\\shard-0\\tools:/run/arena:ro')
    expect(joined).toContain('-e OPENCODE_CONFIG=/run/arena-config/opencode.json')
    expect(joined).toContain('-e OPENCODE_DISABLE_MODELS_FETCH=1')
    expect(args.slice(-4)).toEqual([
      'agent-arena:tc-x', 'sh', '-c',
      'mkdir -p "$HOME/.cache/opencode" && cp /run/arena-config/models.json "$HOME/.cache/opencode/models.json" && exec opencode serve --hostname 0.0.0.0 --port 4096',
    ])
  })

  test('mounts a context folder read-only when the run has one', () => {
    expect(buildProtectedRunArgs({ ...spec, contextDir: 'C:\\research' }).join(' ')).toContain('-v C:\\research:/context:ro')
  })
})

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

  test('mounts the tool manifest read-only at /run/arena, and nothing when absent', () => {
    expect(buildRunArgs({ ...base, toolsDir: 'C:\\ws\\.arena-runtime\\r\\shard-0' }).join(' '))
      .toContain('-v C:\\ws\\.arena-runtime\\r\\shard-0:/run/arena:ro')
    expect(buildRunArgs(base).join(' ')).not.toContain('/run/arena')
  })

  test('sizes numeric thread pools to the CPU budget, never below one', () => {
    const a = buildRunArgs({ ...base, cpus: 2 }).join(' ')
    for (const v of ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS']) expect(a).toContain(`-e ${v}=2`)
    expect(buildRunArgs({ ...base, cpus: 0.5 }).join(' ')).toContain('-e OMP_NUM_THREADS=1')
  })

  test('mounts a context folder read-only at /context, and nothing when absent', () => {
    expect(buildRunArgs({ ...base, contextDir: 'C:\\research' }).join(' ')).toContain('-v C:\\research:/context:ro')
    expect(buildRunArgs(base).join(' ')).not.toContain('/context')
  })

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

  // A fresh container has no models.dev cache, so OpenCode 1.18.21 answers from its bundled
  // catalogue until a background fetch lands — the September 13 shards lost that race and
  // lacked two W&B models the host listed. Pinning the host's catalogue removes the race.
  test('pins a host model catalogue read-only and stops the runtime replacing it', () => {
    const args = buildRunArgs({ ...base, modelsFile: '/host/models.json' })
    const a = args.join(' ')
    expect(a).toContain('-v /host/models.json:/root/.cache/opencode/models.json:ro')
    expect(a).toContain('-e OPENCODE_DISABLE_MODELS_FETCH=1')
    expect(args.at(-1)).toBe('agent-arena:latest')
  })

  test('leaves the runtime catalogue alone when no host catalogue is given', () => {
    for (const spec of [base, { ...base, modelsFile: null }]) {
      const a = buildRunArgs(spec).join(' ')
      expect(a).not.toContain('models.json')
      expect(a).not.toContain('OPENCODE_DISABLE_MODELS_FETCH')
    }
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
