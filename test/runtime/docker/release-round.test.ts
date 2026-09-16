import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DockerSandbox, type StartedContainer } from '../../../src/runtime/docker/sandbox.js'

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'arena-release-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/**
 * A fake container layer with a fake daemon behind it: removal actually deletes
 * the instance, and the verifier answers from what the daemon still holds — so
 * the sandbox's strict confirmation path is exercised, not stubbed out.
 */
const fakeDaemon = () => {
  const liveById = new Map<string, { name: string; gateway?: string }>()
  const liveGateways = new Set<string>()
  /** Worker name → gateway, kept after the worker entry is gone so a retry still finds it. */
  const gatewayOf = new Map<string, string>()
  const removed: string[] = []
  let seq = 0
  const daemon = {
    removed,
    start: async (shardIndex: number): Promise<StartedContainer> => {
      seq++
      const id = `cid-${shardIndex}-${seq}`
      const name = `arena-t-${shardIndex}`
      const gateway = `arena-t-gw-${shardIndex}`
      liveById.set(id, { name, gateway })
      liveGateways.add(gateway)
      gatewayOf.set(name, gateway)
      return { name, baseUrl: `http://127.0.0.1:${40000 + shardIndex}`, shardIndex, containerId: id, gatewayName: gateway }
    },
    stop: async (name: string) => {
      removed.push(name)
      for (const [id, c] of liveById) {
        if (c.name === name) {
          liveById.delete(id)
          if (c.gateway) liveGateways.delete(c.gateway)
        }
      }
      // Gateways are removed by name as their own resource.
      liveGateways.delete(name)
      const gw = gatewayOf.get(name)
      if (gw) liveGateways.delete(gw)
    },
    stateOf: async (id: string): Promise<'running' | 'stopped' | 'unknown'> => {
      if (liveById.has(id)) return 'running'
      if (liveGateways.has(id)) return 'running'
      for (const c of liveById.values()) {
        if (c.name === id || c.gateway === id) return 'running'
      }
      return 'stopped'
    },
    liveCount: () => liveById.size + liveGateways.size,
    /** Simulates a remover that reported success while the gateway survived. */
    resurrectGateway: (gateway: string) => { liveGateways.add(gateway) },
  }
  return daemon
}

const make = async (agentIds: string[], daemon = fakeDaemon()) => {
  const root = await tmp()
  const sb = new DockerSandbox({
    runId: 't', root, maxContainers: agentIds.length, image: 'x', memory: '1g', cpus: 1, authFile: null,
    isolation: 'protected',
    startContainer: daemon.start,
    stopContainer: daemon.stop,
    runtimeStateOf: daemon.stateOf,
  })
  await sb.planFor(agentIds)
  return { sb, daemon, root }
}

describe('DockerSandbox.releaseRound', () => {
  test('removes every owned worker and its gateway, then allows the next round', async () => {
    const { sb, daemon } = await make(['a1', 'a2'])
    await sb.provision('a1', {})
    await sb.provision('a2', {})
    expect(daemon.liveCount()).toBe(4)

    await sb.releaseRound()

    expect(daemon.liveCount()).toBe(0)
    expect(daemon.removed.sort()).toEqual(['arena-t-0', 'arena-t-1'])

    // Nonterminal: the next round plans and provisions fresh workers.
    await sb.planFor(['a1', 'a2'])
    const h = await sb.provision('a1', {})
    expect(h.baseUrl).toContain('127.0.0.1')
    expect(daemon.liveCount()).toBe(2)
  })

  test('a worker removal failure retains ownership and is retried', async () => {
    const daemon = fakeDaemon()
    const root = await tmp()
    let failNames = new Set(['arena-t-0'])
    const warnings: string[] = []
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 2, image: 'x', memory: '1g', cpus: 1, authFile: null,
      isolation: 'protected',
      startContainer: daemon.start,
      stopContainer: async (name: string) => {
        if (failNames.has(name)) throw new Error('daemon gone')
        await daemon.stop(name)
      },
      runtimeStateOf: daemon.stateOf,
      onWarning: (m) => warnings.push(m),
    })
    await sb.planFor(['a1', 'a2'])
    await sb.provision('a1', {})
    await sb.provision('a2', {})

    await expect(sb.releaseRound()).rejects.toThrow(/arena-t-0/)
    expect(warnings.some((w) => w.includes('arena-t-0'))).toBe(true)

    // The failed worker is still owned: the retry removes it.
    failNames = new Set()
    await expect(sb.releaseRound()).resolves.toBeUndefined()
    expect(daemon.liveCount()).toBe(0)
  })

  test('a lingering gateway keeps the worker owned until both are gone', async () => {
    const daemon = fakeDaemon()
    const root = await tmp()
    let dropGateway = true
    const warnings: string[] = []
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      isolation: 'protected',
      startContainer: daemon.start,
      stopContainer: async (name: string) => {
        await daemon.stop(name)
        if (dropGateway) daemon.resurrectGateway('arena-t-gw-0')
      },
      runtimeStateOf: daemon.stateOf,
      onWarning: (m) => warnings.push(m),
    })
    await sb.planFor(['a1'])
    await sb.provision('a1', {})

    await expect(sb.releaseRound()).rejects.toThrow(/arena-t-0/)
    expect(warnings.some((w) => w.includes('arena-t-gw-0') && w.includes('still running'))).toBe(true)
    dropGateway = false
    await expect(sb.releaseRound()).resolves.toBeUndefined()
    expect(daemon.liveCount()).toBe(0)
  })

  test('confirmation addresses the original container ID, not a reused name', async () => {
    const daemon = fakeDaemon()
    const root = await tmp()
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      isolation: 'protected',
      startContainer: daemon.start,
      // A remover that only deletes by name would "succeed" while the original
      // instance is still running elsewhere; the verifier below still sees it.
      stopContainer: async () => {},
      runtimeStateOf: daemon.stateOf,
    })
    await sb.planFor(['a1'])
    const h = await sb.provision('a1', {})
    expect(h.runtimeId).toMatch(/^cid-/)

    // Nothing was actually removed: the original ID is still running.
    await expect(sb.releaseRound()).rejects.toThrow()
  })

  test('concurrent cleanups join one in-flight attempt', async () => {
    const { sb, daemon } = await make(['a1'])
    await sb.provision('a1', {})
    const before = daemon.removed.length

    await Promise.all([sb.releaseRound(), sb.releaseRound(), sb.releaseRound()])

    expect(daemon.removed.length - before).toBe(1)
    expect(daemon.liveCount()).toBe(0)
  })

  test('a second release after success is a no-op: bookkeeping stays bounded', async () => {
    const { sb, daemon } = await make(['a1'])
    await sb.provision('a1', {})
    await sb.releaseRound()
    const removed = daemon.removed.length

    await expect(sb.releaseRound()).resolves.toBeUndefined()
    expect(daemon.removed).toHaveLength(removed)

    const owned = (sb as unknown as { owned: Map<string, unknown> }).owned
    expect(owned.size).toBe(0)
  })

  test('terminal disposal still retries a release failure', async () => {
    const daemon = fakeDaemon()
    const root = await tmp()
    let fail = true
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      isolation: 'protected',
      startContainer: daemon.start,
      stopContainer: async (name: string) => {
        if (fail) throw new Error('daemon gone')
        await daemon.stop(name)
      },
      runtimeStateOf: daemon.stateOf,
    })
    await sb.planFor(['a1'])
    await sb.provision('a1', {})

    await expect(sb.releaseRound()).rejects.toThrow()
    fail = false
    await expect(sb.disposeAll()).resolves.toBeUndefined()
    expect(daemon.liveCount()).toBe(0)
  })
})
