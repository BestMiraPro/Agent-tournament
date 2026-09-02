import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG, type RunConfig } from '../../../src/core/types.js'
import { openDb } from '../../../src/db/open.js'
import { makeRepos } from '../../../src/db/repos.js'
import { TournamentEngine } from '../../../src/engine/driver.js'
import { Reflector } from '../../../src/evolution/reflect.js'
import { Judge } from '../../../src/judge/judge.js'
import { MockAgentRunner } from '../../../src/runtime/agent-runner.js'
import { GOOD_KEYWORDS, MockProvider } from '../../../src/runtime/mock-provider.js'
import { DockerSandbox } from '../../../src/runtime/docker/sandbox.js'
import type { AgentHandle } from '../../../src/runtime/sandbox.js'

/**
 * End-to-end proof that `isolatedWorkspace` actually reaches the capture decision.
 *
 * The unit tests above assert the predicate in isolation, which is not the same claim:
 * `workspaceIsolated` is capability-detected, so a method that exists but is never found
 * — wrong name, wrong shape, not on the prototype the driver sees — fails silently and
 * the system goes on refusing to certify anything. Three guardrails in this project have
 * already shipped plumbed-but-mute, so the only claim worth making is the one measured at
 * the entry point: run a real round through the real driver against a real DockerSandbox
 * and read the `submission.captured` event it wrote.
 *
 * No Docker daemon is involved: the container layer is faked, but every host-side path,
 * the shard plan, the capture, and the tamper verification are the production code.
 */

const dirs: string[] = []
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'arena-iso-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const fakeContainers = () => ({
  start: async (shardIndex: number) => ({
    name: `arena-iso-${shardIndex}`,
    baseUrl: `http://127.0.0.1:${41000 + shardIndex}`,
    shardIndex,
  }),
  stop: async () => {},
})

/**
 * Builds a real engine on a real DockerSandbox.
 *
 * `maxContainers` is the only knob that matters here: equal to the population it gives
 * one container per agent, below it forces co-tenancy. That is exactly the tradeoff
 * DEFAULT_CONFIG currently resolves against isolation.
 */
async function makeDockerEngine(opts: { populationSize: number; maxContainers: number; seed?: number }) {
  const seed = opts.seed ?? 7
  const root = await tmp()
  const db = openDb(':memory:')
  const repos = makeRepos(db)

  const config: RunConfig = {
    ...DEFAULT_CONFIG,
    populationSize: opts.populationSize,
    sandbox: 'docker',
    maxContainers: opts.maxContainers,
    concurrency: 2,
    roster: [{ modelId: 'mock/model', count: opts.populationSize, temperature: 0.7 }],
  }

  const c = fakeContainers()
  const sandbox = new DockerSandbox({
    runId: 'iso', root, maxContainers: opts.maxContainers, image: 'x',
    memory: config.containerMemory, cpus: config.containerCpus, authFile: null,
    startContainer: c.start, stopContainer: c.stop,
  })

  const provider = new MockProvider(seed)
  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner: new MockAgentRunner(sandbox, seed),
    judge: new Judge(provider, config.judge, seed),
    reflector: new Reflector(provider, config.reflect, ['mock/model']),
    seedStrategy: (i) => `attempt the goal, variant ${i}, focus on ${GOOD_KEYWORDS[i % GOOD_KEYWORDS.length]}`,
  })

  return { engine, repos, sandbox, root }
}

/** Runs one round, doing the shard planning the CLI does before each round. */
async function runOneRound(h: Awaited<ReturnType<typeof makeDockerEngine>>) {
  const run = h.engine.createRun('iso', 'goal')
  await h.sandbox.planFor(h.repos.agents.listActive(run.id).map((a) => a.id))
  const round = await h.engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
  const captured = h.repos.events
    .forRun(run.id)
    .filter((e) => e.type === 'submission.captured' && e.roundId === round.roundId)
  return { run, round, captured }
}

describe('docker isolation reaches the capture decision', () => {
  test('one agent per container produces a sealed, verified-intact capture', async () => {
    const h = await makeDockerEngine({ populationSize: 4, maxContainers: 4 })
    const { captured } = await runOneRound(h)

    expect(captured).toHaveLength(4)
    for (const e of captured) {
      expect(e.payload.quiesce).toBe('stopped')
      expect(e.payload.sealed).toBe(true)
      expect(e.payload.verified).toBe(true)
      expect(e.payload.tampered).toBe(false)
    }
  })

  test('sharing a container yields sealed: false, so nothing intact is certified', async () => {
    // 4 agents, 2 containers => two co-tenants each. Nobody is provably alone.
    const h = await makeDockerEngine({ populationSize: 4, maxContainers: 2 })
    const { captured } = await runOneRound(h)

    expect(captured).toHaveLength(4)
    for (const e of captured) {
      // The agent still stopped, and nothing was actually tampered with...
      expect(e.payload.quiesce).toBe('stopped')
      expect(e.payload.tampered).toBe(false)
      // ...but "intact" is not a claim we may certify from a shared bind mount.
      expect(e.payload.sealed).toBe(false)
      expect(e.payload.verified).toBe(false)
    }
  })

  test('the stock DEFAULT_CONFIG ratio seals nothing', async () => {
    // populationSize 20 / maxContainers 4 is five agents per container. Scaled down to
    // 5/1 so the test stays fast; the ratio, which is what decides sealing, is identical.
    const h = await makeDockerEngine({ populationSize: 5, maxContainers: 1 })
    const { captured } = await runOneRound(h)

    expect(captured).toHaveLength(5)
    expect(captured.every((e) => e.payload.sealed === false)).toBe(true)
    expect(captured.every((e) => e.payload.verified === false)).toBe(true)
  })

  test('a mixed plan seals exactly the agents that are alone', async () => {
    // 3 agents over 2 containers: round-robin leaves the second agent by itself.
    const h = await makeDockerEngine({ populationSize: 3, maxContainers: 2 })
    const { run, captured } = await runOneRound(h)

    const ids = h.repos.agents.listActive(run.id).map((a) => a.id)
    const sealedFor = (id: string) => captured.find((e) => e.agentId === id)!.payload.sealed
    const alone = ids.filter((_, i) => i % 2 === 1)
    const shared = ids.filter((_, i) => i % 2 === 0)

    expect(alone.map(sealedFor)).toEqual(alone.map(() => true))
    expect(shared.map(sealedFor)).toEqual(shared.map(() => false))
  })

  test('a rival overwriting a co-tenant is caught, and reported as verified tampering', async () => {
    // Tamper detection is the protection that survives co-tenancy: a POSITIVE finding
    // needs only the round barrier, not a sealed capture, so it stays certifiable even
    // when "intact" is not. This is what the stock defaults actually buy.
    const h = await makeDockerEngine({ populationSize: 2, maxContainers: 1 })
    const run = h.engine.createRun('iso', 'goal')
    const ids = h.repos.agents.listActive(run.id).map((a) => a.id)
    await h.sandbox.planFor(ids)

    const real = h.sandbox.readFile.bind(h.sandbox)
    let done = false
    // Substitute the victim's file after its capture read, exactly as a co-tenant with
    // write access to the shared bind mount could.
    h.sandbox.readFile = async (handle: AgentHandle, relPath: string) => {
      const out = await real(handle, relPath)
      if (!done && relPath === 'SUBMISSION.md' && handle.agentId === ids[0]) {
        done = true
        await writeFile(join(h.root, 'shard-0', ids[0]!, 'SUBMISSION.md'), '# rival substitute\n')
      }
      return out
    }

    const round = await h.engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
    const tamperEvents = h.repos.events
      .forRun(run.id)
      .filter((e) => e.type === 'submission.tampered' && e.roundId === round.roundId)

    expect(tamperEvents).toHaveLength(1)
    expect(tamperEvents[0]!.agentId).toBe(ids[0])
    expect(tamperEvents[0]!.payload.detail).toMatch(/submission was modified after it was captured/i)
    expect(tamperEvents[0]!.payload.verified).toBe(true)
  })
})
