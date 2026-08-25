import { describe, expect, test } from 'vitest'
import { makeClientResolver, resolveSandboxMode, runTournamentCli } from '../src/cli.js'
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
