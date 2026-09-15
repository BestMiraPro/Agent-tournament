import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DockerSandbox } from '../../../src/runtime/docker/sandbox.js'
import { workspaceIsolated } from '../../../src/engine/capture.js'

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'arena-docker-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** Stands in for the container layer so these tests need no Docker daemon. */
const fakeContainers = () => {
  const started: { shardIndex: number; hostDir: string }[] = []
  const stopped: string[] = []
  return {
    started,
    stopped,
    start: async (shardIndex: number, hostDir: string) => {
      started.push({ shardIndex, hostDir })
      return { name: `arena-t-${shardIndex}`, baseUrl: `http://127.0.0.1:${40000 + shardIndex}`, shardIndex }
    },
    stop: async (name: string) => { stopped.push(name) },
  }
}

const make = async (agentIds: string[], maxContainers: number) => {
  const root = await tmp()
  const c = fakeContainers()
  const sb = new DockerSandbox({
    runId: 't', root, maxContainers, image: 'x', memory: '1g', cpus: 1, authFile: null,
    startContainer: c.start, stopContainer: c.stop,
  })
  await sb.planFor(agentIds)
  return { sb, c, root }
}

describe('DockerSandbox placement and protected isolation', () => {
  test('protected isolation refuses a round with more agents than containers, before anything starts', async () => {
    const root = await tmp()
    const c = fakeContainers()
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 2, image: 'x', memory: '1g', cpus: 1, authFile: null,
      isolation: 'protected', startContainer: c.start, stopContainer: c.stop,
    })
    await expect(sb.planFor(['a1', 'a2', 'a3'])).rejects.toThrow(
      /Protected isolation needs one container per agent, but this round has 3 agents and 2 containers/,
    )
    expect(c.started).toEqual([])
    await expect(sb.planFor(['a1', 'a2'])).resolves.toBeUndefined()
  })

  test('reports each container and whether its agents share it', async () => {
    const { sb } = await make(['a1', 'a2', 'a3'], 2)
    expect(sb.placement()).toEqual([
      { shardIndex: 0, agentIds: ['a1', 'a3'], occupancy: 'shared' },
      { shardIndex: 1, agentIds: ['a2'], occupancy: 'single' },
    ])
  })

  test('names the container an agent runs in once it has started', async () => {
    const { sb } = await make(['a1', 'a2'], 2)
    expect(sb.containerNameFor('a1')).toBeNull()
    await sb.provision('a1', {})
    expect(sb.containerNameFor('a1')).toBe('arena-t-0')
    expect(sb.containerNameFor('ghost')).toBeNull()
  })
})

describe('DockerSandbox.isolatedWorkspace', () => {
  test('one agent alone on a shard is isolated', async () => {
    const { sb } = await make(['a1', 'a2'], 2)
    const h1 = await sb.provision('a1', {})
    expect(sb.isolatedWorkspace(h1)).toBe(true)
  })

  test('two agents sharing a shard are NOT isolated — for both of them', async () => {
    const { sb } = await make(['a1', 'a2'], 1)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    expect(sb.isolatedWorkspace(h1)).toBe(false)
    expect(sb.isolatedWorkspace(h2)).toBe(false)
  })

  test('three agents on two shards: only the one that is alone is isolated', async () => {
    // Round-robin puts a1+a3 on shard 0 and a2 alone on shard 1.
    const { sb } = await make(['a1', 'a2', 'a3'], 2)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    const h3 = await sb.provision('a3', {})
    expect(sb.isolatedWorkspace(h1)).toBe(false)
    expect(sb.isolatedWorkspace(h2)).toBe(true)
    expect(sb.isolatedWorkspace(h3)).toBe(false)
  })

  test('an agent that was never planned is not isolated', async () => {
    const { sb } = await make(['a1'], 4)
    expect(
      sb.isolatedWorkspace({ agentId: 'ghost', workspacePath: '/work/ghost', baseUrl: '' }),
    ).toBe(false)
  })

  test('with no plan at all, nothing is isolated', async () => {
    const root = await tmp()
    const c = fakeContainers()
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 8, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: c.start, stopContainer: c.stop,
    })
    // planFor deliberately not called.
    expect(
      sb.isolatedWorkspace({ agentId: 'a1', workspacePath: '/work/a1', baseUrl: '' }),
    ).toBe(false)
  })

  test('re-planning a solo agent alongside a co-tenant revokes its isolation', async () => {
    const { sb } = await make(['a1'], 4)
    const h1 = await sb.provision('a1', {})
    expect(sb.isolatedWorkspace(h1)).toBe(true)
    // Breeding grows the population; the next round shards it differently.
    await sb.planFor(['a1', 'a2', 'a3', 'a4', 'a5'])
    expect(sb.isolatedWorkspace(h1)).toBe(false)
  })

  test('a torn-down co-tenant does not restore isolation — it could already have written', async () => {
    const { sb } = await make(['a1', 'a2'], 1)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    await sb.teardown(h2)
    expect(sb.isolatedWorkspace(h1)).toBe(false)
  })

  test('capability-detected by workspaceIsolated rather than assumed', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    expect(workspaceIsolated(sb, h)).toBe(true)
    const shared = await make(['b1', 'b2'], 1)
    const hb = await shared.sb.provision('b1', {})
    expect(workspaceIsolated(shared.sb, hb)).toBe(false)
  })
})

describe('DockerSandbox', () => {
  test('concurrent provisions on one shard share a single pending start', async () => {
    const root = await tmp()
    let release!: (container: { name: string; baseUrl: string; shardIndex: number }) => void
    let entered!: () => void
    const pending = new Promise<{ name: string; baseUrl: string; shardIndex: number }>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let starts = 0
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async () => {
        starts++
        entered()
        return pending
      },
      stopContainer: async () => {},
    })
    await sb.planFor(['a1', 'a2'])

    const p1 = sb.provision('a1', {})
    const p2 = sb.provision('a2', {})
    await started
    expect(starts).toBe(1)
    release({ name: 'arena-t-0', baseUrl: 'http://127.0.0.1:40000', shardIndex: 0 })

    const [h1, h2] = await Promise.all([p1, p2])
    expect(h1.baseUrl).toBe('http://127.0.0.1:40000')
    expect(h2.baseUrl).toBe(h1.baseUrl)
  })

  test('a shared failed start reaches every waiter and a later provision retries', async () => {
    const root = await tmp()
    let rejectFirst!: (error: Error) => void
    let entered!: () => void
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let starts = 0
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async () => {
        starts++
        if (starts === 1) {
          entered()
          return first
        }
        return { name: 'arena-t-0', baseUrl: 'http://127.0.0.1:40000', shardIndex: 0 }
      },
      stopContainer: async () => {},
    })
    await sb.planFor(['a1', 'a2'])

    const p1 = sb.provision('a1', {})
    const p2 = sb.provision('a2', {})
    await started
    rejectFirst(new Error('start failed'))
    const failed = await Promise.allSettled([p1, p2])

    expect(starts).toBe(1)
    expect(failed.every((result) => result.status === 'rejected')).toBe(true)
    expect(failed.map((result) => result.status === 'rejected' ? result.reason.message : '')).toEqual([
      'start failed',
      'start failed',
    ])
    await expect(sb.provision('a1', {})).resolves.toMatchObject({
      baseUrl: 'http://127.0.0.1:40000',
    })
    expect(starts).toBe(2)
  })

  test('different shards may start concurrently', async () => {
    const root = await tmp()
    let release!: () => void
    let bothEntered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { bothEntered = resolve })
    const starts: number[] = []
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 2, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async (shardIndex) => {
        starts.push(shardIndex)
        if (starts.length === 2) bothEntered()
        await gate
        return {
          name: `arena-t-${shardIndex}`,
          baseUrl: `http://127.0.0.1:${40000 + shardIndex}`,
          shardIndex,
        }
      },
      stopContainer: async () => {},
    })
    await sb.planFor(['a1', 'a2'])

    const provisions = Promise.all([sb.provision('a1', {}), sb.provision('a2', {})])
    await started
    expect(starts.slice().sort()).toEqual([0, 1])
    release()
    await provisions
  })

  test('workspacePath is the CONTAINER path, not the host path', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    expect(h.workspacePath).toBe('/work/a1')
  })

  test('endpoint returns the shard container base url', async () => {
    const { sb } = await make(['a1', 'a2'], 2)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    expect(sb.endpoint(h1).baseUrl).not.toBe(sb.endpoint(h2).baseUrl)
  })

  test('agents in the same shard share a base url', async () => {
    const { sb } = await make(['a1', 'a2'], 1)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    expect(sb.endpoint(h1).baseUrl).toBe(sb.endpoint(h2).baseUrl)
  })

  test('starts one container per shard, not per agent', async () => {
    const { sb, c } = await make(['a1', 'a2', 'a3', 'a4'], 2)
    for (const id of ['a1', 'a2', 'a3', 'a4']) await sb.provision(id, {})
    expect(c.started).toHaveLength(2)
  })

  test('each shard mounts its own directory, isolating shards from each other', async () => {
    const { sb, c, root } = await make(['a1', 'a2'], 2)
    // Containers start lazily, on the first provision into each shard.
    await sb.provision('a1', {})
    await sb.provision('a2', {})
    expect(c.started.map((s) => s.hostDir).sort()).toEqual(
      [join(root, 'shard-0'), join(root, 'shard-1')].sort(),
    )
  })

  test('file operations use the host path and round-trip', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'answer')
    expect(await sb.readFile(h, 'SUBMISSION.md')).toBe('answer')
  })

  test('writes nested paths such as the genome file', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, '.opencode/agents/competitor.md', 'genome')
    expect(await sb.readFile(h, '.opencode/agents/competitor.md')).toBe('genome')
  })

  test('listFiles excludes opencode plumbing', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'SUBMISSION.md', 'a')
    await sb.writeFile(h, '.opencode/node_modules/x.js', 'b')
    expect((await sb.listFiles(h)).map((f) => f.path)).toEqual(['SUBMISSION.md'])
  })

  test('reset clears the workspace but keeps the container', async () => {
    const { sb, c } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await sb.writeFile(h, 'X.md', 'data')
    await sb.reset(h, {})
    expect(await sb.readFile(h, 'X.md')).toBeNull()
    expect(c.stopped).toEqual([])
  })

  test('teardown stops every shard container exactly once', async () => {
    const { sb, c } = await make(['a1', 'a2', 'a3'], 2)
    const h1 = await sb.provision('a1', {})
    const h2 = await sb.provision('a2', {})
    await sb.teardown(h1)
    await sb.teardown(h2)
    expect(new Set(c.stopped).size).toBe(c.stopped.length)
  })

  test('rejects paths escaping the workspace', async () => {
    const { sb } = await make(['a1'], 1)
    const h = await sb.provision('a1', {})
    await expect(sb.writeFile(h, '../escape.md', 'x')).rejects.toThrow(/escape|outside/i)
  })

  test('teardown on an unplanned agent does not throw', async () => {
    const { sb } = await make(['a1'], 1)
    await sb.provision('a1', {})
    // A population change can remove an agent from the plan entirely; a later
    // teardown for it must be a quiet no-op, not a thrown error.
    await expect(
      sb.teardown({ agentId: 'ghost', workspacePath: '', baseUrl: '' }),
    ).resolves.toBeUndefined()
  })
})

describe('DockerSandbox.disposeAll', () => {
  test('waits for an owned pending start and stops its container once', async () => {
    const root = await tmp()
    let release!: (container: { name: string; baseUrl: string; shardIndex: number }) => void
    let entered!: () => void
    const pending = new Promise<{ name: string; baseUrl: string; shardIndex: number }>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const stopped: string[] = []
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async () => {
        entered()
        return pending
      },
      stopContainer: async (name) => { stopped.push(name) },
    })
    await sb.planFor(['a1'])

    const provision = sb.provision('a1', {})
    await started
    let disposed = false
    const disposal = sb.disposeAll().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release({ name: 'arena-t-0', baseUrl: 'http://127.0.0.1:40000', shardIndex: 0 })

    await disposal
    await expect(provision).rejects.toThrow(/disposed/)
    expect(stopped).toEqual(['arena-t-0'])
  })

  test('stops every started container, regardless of live state', async () => {
    const { sb, c } = await make(['a1', 'a2', 'a3', 'a4'], 2)
    // a1 and a2 each start their shard's container (shard-0 and shard-1
    // respectively). a3 and a4 are planned into those same shards but are
    // never provisioned — simulating a sibling whose provisioning failed, or
    // a planned agent that was never provisioned at all. Neither shard's
    // container is ever torn down via `teardown`.
    await sb.provision('a1', {})
    await sb.provision('a2', {})
    await sb.disposeAll()
    expect(c.stopped.slice().sort()).toEqual(['arena-t-0', 'arena-t-1'])
  })

  test('a container that will not stop is reported, and does not strand the rest', async () => {
    // disposeAll is the last line of defence against leaked containers. If one
    // stop fails it must neither throw nor abandon the containers after it in
    // the loop — and the failure must be visible rather than silent.
    const root = await tmp()
    const stopped: string[] = []
    const warnings: string[] = []
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 2, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async (shardIndex: number) => ({
        name: `arena-t-${shardIndex}`,
        baseUrl: `http://127.0.0.1:${40000 + shardIndex}`,
        shardIndex,
      }),
      stopContainer: async (name: string) => {
        if (name === 'arena-t-0') throw new Error('daemon gone')
        stopped.push(name)
      },
      onWarning: (m) => warnings.push(m),
    })
    await sb.planFor(['a1', 'a2'])
    await sb.provision('a1', {})
    await sb.provision('a2', {})

    await expect(sb.disposeAll()).resolves.toBeUndefined()
    expect(stopped).toEqual(['arena-t-1'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/arena-t-0/)
    expect(warnings[0]).toMatch(/daemon gone/)
  })

  test('is safe to call twice: each container is stopped only once', async () => {
    const { sb, c } = await make(['a1', 'a2'], 2)
    await sb.provision('a1', {})
    await sb.provision('a2', {})
    await sb.disposeAll()
    await sb.disposeAll()
    expect(c.stopped.slice().sort()).toEqual(['arena-t-0', 'arena-t-1'])
  })
})

describe('DockerSandbox stop retries', () => {
  /** A stop that fails the first N times for a given container, then succeeds. */
  const flakyStop = (failures: Map<string, number>) => {
    const attempts: string[] = []
    return {
      attempts,
      stop: async (name: string) => {
        attempts.push(name)
        const left = failures.get(name) ?? 0
        if (left > 0) {
          failures.set(name, left - 1)
          throw new Error('daemon gone')
        }
      },
    }
  }

  test('a container that failed to stop during teardown is retried by disposeAll', async () => {
    // The name was recorded as stopped BEFORE the attempt, so a failure permanently
    // marked the container done and disposeAll — the unconditional backstop against
    // leaked containers — skipped it. The leak it exists to prevent, caused by it.
    const root = await tmp()
    const warnings: string[] = []
    const flaky = flakyStop(new Map([['arena-t-0', 1]]))
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async (shardIndex: number) => ({
        name: `arena-t-${shardIndex}`,
        baseUrl: `http://127.0.0.1:${40000 + shardIndex}`,
        shardIndex,
      }),
      stopContainer: flaky.stop,
      onWarning: (m) => warnings.push(m),
    })
    await sb.planFor(['a1'])
    const handle = await sb.provision('a1', {})

    // Teardown is the first attempt, and it fails.
    await sb.teardown(handle)
    expect(flaky.attempts).toEqual(['arena-t-0'])
    expect(warnings).toHaveLength(1)

    // The backstop must try again, and this time it works.
    await sb.disposeAll()
    expect(flaky.attempts).toEqual(['arena-t-0', 'arena-t-0'])
    expect(warnings).toHaveLength(1)
  })

  test('a container that stopped cleanly is never stopped twice', async () => {
    const { sb, c } = await make(['a1'], 1)
    const handle = await sb.provision('a1', {})
    await sb.teardown(handle)
    await sb.disposeAll()
    await sb.disposeAll()
    expect(c.stopped).toEqual(['arena-t-0'])
  })

  test('concurrent stops of one container make a single attempt', async () => {
    const root = await tmp()
    let attempts = 0
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const sb = new DockerSandbox({
      runId: 't', root, maxContainers: 1, image: 'x', memory: '1g', cpus: 1, authFile: null,
      startContainer: async (shardIndex: number) => ({
        name: `arena-t-${shardIndex}`,
        baseUrl: `http://127.0.0.1:${40000 + shardIndex}`,
        shardIndex,
      }),
      stopContainer: async () => { attempts++; await held },
    })
    await sb.planFor(['a1'])
    const handle = await sb.provision('a1', {})

    const teardown = sb.teardown(handle)
    const dispose = sb.disposeAll()
    release()
    await Promise.all([teardown, dispose])
    expect(attempts).toBe(1)
  })
})
