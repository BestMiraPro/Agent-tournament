import { describe, expect, test } from 'vitest'
import {
  assertHostCapacity,
  makeClientResolver,
  resolveSandboxMode,
  runTournamentCli,
  sweepBeforeRun,
  type DockerStartupHooks,
} from '../src/cli.js'
import { DEFAULT_CONFIG, type RunConfig } from '../src/core/types.js'
import type { HostCapacity } from '../src/runtime/docker/capacity.js'
import type { SweepOptions } from '../src/runtime/docker/sweep.js'

const roomyHost: HostCapacity = {
  totalMemoryBytes: 16 * 1024 ** 3,
  usedMemoryBytes: 1 * 1024 ** 3,
  cpus: 8,
}
import { OpenCodeClient } from '../src/runtime/opencode/client.js'
import type { AgentHandle, Sandbox } from '../src/runtime/sandbox.js'

/** Stand-in for the single shared client real+local mode uses. Never called. */
const fallbackClient = new OpenCodeClient({ baseUrl: 'http://127.0.0.1:9999', timeoutMs: 1000 })

describe('runTournamentCli', () => {
  test('runs the requested number of rounds and reports fitness per round', async () => {
    const out = await runTournamentCli({
      goal: 'write a good answer',
      rounds: 3,
      population: 6,
      seed: 42,
      dbPath: ':memory:',
      criteria: null,
    })
    expect(out.rounds).toHaveLength(3)
    expect(out.rounds[0]!.meanScore).toBeGreaterThan(0)
    expect(out.rounds.at(-1)!.meanScore).toBeGreaterThan(out.rounds[0]!.meanScore)
  })

  test('reports the winning strategy of the final round', async () => {
    const out = await runTournamentCli({
      goal: 'write a good answer', rounds: 2, population: 4,
      seed: 1, dbPath: ':memory:', criteria: null,
    })
    expect(out.winner.strategyMd.length).toBeGreaterThan(0)
  })
})

describe('CLI mode selection', () => {
  test('mock mode still runs and improves', async () => {
    const out = await runTournamentCli({
      goal: 'write a good answer', rounds: 3, population: 6, seed: 42,
      dbPath: ':memory:', criteria: null, mode: 'mock',
    })
    expect(out.rounds).toHaveLength(3)
    expect(out.rounds.at(-1)!.meanScore).toBeGreaterThan(out.rounds[0]!.meanScore)
  })

  test('real mode requires a workspace root', async () => {
    await expect(
      runTournamentCli({
        goal: 'g', rounds: 1, population: 2, seed: 1,
        dbPath: ':memory:', criteria: null, mode: 'real',
      }),
    ).rejects.toThrow(/workspaceRoot/i)
  })
})

describe('CLI docker mode', () => {
  test('docker mode requires a workspace root', async () => {
    await expect(
      runTournamentCli({
        goal: 'g', rounds: 1, population: 2, seed: 1,
        dbPath: ':memory:', criteria: null, mode: 'real', sandbox: 'docker',
      }),
    ).rejects.toThrow(/workspaceRoot/i)
  })

  test('mock mode ignores the sandbox flag entirely', async () => {
    const out = await runTournamentCli({
      goal: 'g', rounds: 2, population: 4, seed: 42,
      dbPath: ':memory:', criteria: null, mode: 'mock', sandbox: 'docker',
    })
    expect(out.rounds).toHaveLength(2)
  })
})

describe('CLI host-capacity preflight', () => {
  const dockerConfig = (over: Partial<RunConfig> = {}): RunConfig => ({
    ...DEFAULT_CONFIG,
    sandbox: 'docker',
    maxContainers: 4,
    containerMemory: '1g',
    containerCpus: 1,
    ...over,
  })

  // 16 GiB total / 1 GiB used / 8 CPUs leaves ~12 GiB committable, so 4x1g fits.
  const roomy: HostCapacity = {
    totalMemoryBytes: 16 * 1024 ** 3,
    usedMemoryBytes: 1 * 1024 ** 3,
    cpus: 8,
  }
  const cramped: HostCapacity = {
    totalMemoryBytes: 2 * 1024 ** 3,
    usedMemoryBytes: 1 * 1024 ** 3,
    cpus: 8,
  }

  test('refuses a run whose containers would overcommit host memory', async () => {
    await expect(assertHostCapacity(dockerConfig(), async () => cramped)).rejects.toThrow(
      /docker sandbox: Requested 4 containers/i,
    )
  })

  test('refuses a run that would oversubscribe the host CPUs', async () => {
    await expect(
      assertHostCapacity(dockerConfig({ maxContainers: 8, containerCpus: 4 }), async () => ({
        ...roomy,
        cpus: 2,
      })),
    ).rejects.toThrow(/Oversubscribing CPUs/i)
  })

  test('allows a run that fits within the host headroom', async () => {
    await expect(assertHostCapacity(dockerConfig(), async () => roomy)).resolves.toBeUndefined()
  })

  test('an unreadable host warns and proceeds rather than refusing every run', async () => {
    const warnings: string[] = []
    await expect(
      assertHostCapacity(
        dockerConfig(),
        async () => {
          throw new Error('docker info unavailable')
        },
        (m) => warnings.push(m),
      ),
    ).resolves.toBeUndefined()
    expect(warnings.join('\n')).toMatch(/preflight was skipped/i)
  })

  test('the CLI refuses to start a docker run that would overcommit the host', async () => {
    const hooks: DockerStartupHooks = {
      readCapacity: async () => cramped,
      sweep: async () => [],
    }
    await expect(
      runTournamentCli(
        {
          goal: 'g', rounds: 1, population: 2, seed: 1,
          dbPath: ':memory:', criteria: null, mode: 'real', sandbox: 'docker',
          workspaceRoot: '/tmp/does-not-need-to-exist',
        },
        hooks,
      ),
    ).rejects.toThrow(/docker sandbox: Requested/i)
  })
})

describe('CLI orphan sweep', () => {
  const dockerConfig: RunConfig = { ...DEFAULT_CONFIG, sandbox: 'docker' }

  test('passes the live run id so the sweep cannot destroy the run performing it', async () => {
    const seen: SweepOptions[] = []
    await sweepBeforeRun(
      dockerConfig,
      'run-abc',
      { readCapacity: async () => roomyHost, sweep: async (o) => (seen.push(o), []) },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.activeRunIds).toEqual(['run-abc'])
  })

  test('reports the containers it swept', async () => {
    const removed = await sweepBeforeRun(dockerConfig, 'run-abc', {
      readCapacity: async () => roomyHost,
      sweep: async () => ['arena-old-0', 'arena-old-1'],
    })
    expect(removed).toEqual(['arena-old-0', 'arena-old-1'])
  })

  test('does not sweep outside docker mode', async () => {
    let called = false
    const removed = await sweepBeforeRun(
      { ...DEFAULT_CONFIG, sandbox: 'local' },
      'run-abc',
      { readCapacity: async () => roomyHost, sweep: async () => ((called = true), ['x']) },
    )
    expect(called).toBe(false)
    expect(removed).toEqual([])
  })

  test('a failing sweep warns but never stops the run from starting', async () => {
    const warnings: string[] = []
    const removed = await sweepBeforeRun(
      dockerConfig,
      'run-abc',
      {
        readCapacity: async () => roomyHost,
        sweep: async () => {
          throw new Error('daemon down')
        },
      },
      (m) => warnings.push(m),
    )
    expect(removed).toEqual([])
    expect(warnings.join('\n')).toMatch(/sweep failed: daemon down/i)
  })

  test('mock mode never sweeps — there are no containers to strand', async () => {
    const seen: unknown[] = []
    await runTournamentCli(
      {
        goal: 'g', rounds: 1, population: 2, seed: 42,
        dbPath: ':memory:', criteria: null, mode: 'mock',
      },
      {
        readCapacity: async () => {
          throw new Error('should not be read in mock mode')
        },
        sweep: async (o) => {
          seen.push(o)
          return []
        },
      },
    )
    expect(seen).toHaveLength(0)
  })
})

describe('resolveSandboxMode', () => {
  test('mock mode always yields the mock sandbox, whatever --sandbox says', () => {
    expect(resolveSandboxMode('mock', 'docker')).toBe('mock')
    expect(resolveSandboxMode('mock', 'local')).toBe('mock')
    expect(resolveSandboxMode('mock', undefined)).toBe('mock')
  })

  test('real mode defaults to local and honours docker', () => {
    expect(resolveSandboxMode('real', undefined)).toBe('local')
    expect(resolveSandboxMode('real', 'docker')).toBe('docker')
  })

  test('an unknown sandbox is rejected rather than silently downgraded', () => {
    // `--sandbox` arrives as an unvalidated string; falling back to 'local' on a typo
    // would run the whole tournament unsandboxed while the operator believed it was
    // containerised. That must be loud.
    expect(() => resolveSandboxMode('real', 'dokcer' as never)).toThrow(/unknown sandbox/i)
  })
})

describe('makeClientResolver', () => {
  const handle = (agentId: string, baseUrl: string): AgentHandle => ({
    agentId, workspacePath: `/work/${agentId}`, baseUrl,
  })
  const endpointOnly = (): Sandbox =>
    ({ endpoint: (h: AgentHandle) => ({ baseUrl: h.baseUrl }) }) as unknown as Sandbox

  test('caches one client per baseUrl, not per agent', () => {
    let created = 0
    const resolve = makeClientResolver(endpointOnly(), fallbackClient, (baseUrl) => {
      created++
      return new OpenCodeClient({ baseUrl, timeoutMs: 1000 })
    })

    const a = resolve(handle('a', 'http://127.0.0.1:1111'))
    const b = resolve(handle('b', 'http://127.0.0.1:1111'))
    const c = resolve(handle('c', 'http://127.0.0.1:2222'))

    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(created).toBe(2)
  })

  test('falls back to the shared client when the sandbox publishes no endpoint', () => {
    const resolve = makeClientResolver(
      ({ endpoint: () => ({ baseUrl: '' }) }) as unknown as Sandbox,
      fallbackClient,
      () => {
        throw new Error('must not create a per-shard client without a baseUrl')
      },
    )
    expect(resolve(handle('a', ''))).toBe(fallbackClient)
  })
})

describe('capacity preflight uses the effective container count', () => {
  test('a small population is not refused because maxContainers is high', async () => {
    // 2 agents can only ever start 2 containers, whatever maxContainers says.
    const cfg = { ...DEFAULT_CONFIG, populationSize: 2, maxContainers: 8, containerMemory: '1g', containerCpus: 1 }
    const host = { totalMemoryBytes: 4.1 * 1024 ** 3, usedMemoryBytes: 0.8 * 1024 ** 3, cpus: 16 }
    await expect(assertHostCapacity(cfg, async () => host, () => {})).resolves.toBeUndefined()
  })

  test('a genuinely oversized run is still refused', async () => {
    const cfg = { ...DEFAULT_CONFIG, populationSize: 40, maxContainers: 40, containerMemory: '1g', containerCpus: 1 }
    const host = { totalMemoryBytes: 4.1 * 1024 ** 3, usedMemoryBytes: 0.8 * 1024 ** 3, cpus: 16 }
    await expect(assertHostCapacity(cfg, async () => host, () => {})).rejects.toThrow(/memory/i)
  })
})
