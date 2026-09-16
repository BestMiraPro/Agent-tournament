import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import { AuditCollector } from '../../src/engine/audit.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { CapacityLedger } from '../../src/runtime/docker/capacity.js'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'
import { composeRun, type ShardServerEvent } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const GiB = 1024 ** 3
const TOOLCHAIN = 'abc123def4567890'
const inventoryFixture = {
  schemaVersion: 1 as const,
  toolchainId: TOOLCHAIN,
  python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
  tools: ['python3', 'node', 'git', 'opencode', 'rg'].map((name) => ({ name, version: '1.0', executable: `/usr/bin/${name}` })),
  pythonPackages: [{ name: 'numpy', version: '2.3.3' }],
}
const catalogJson = JSON.stringify({
  mock: { api: 'https://api.m.example/v1', npm: '@ai-sdk/openai-compatible', models: {} },
})
const authJson = JSON.stringify({ mock: { type: 'api', key: 'FAKE-MOCK-KEY' } })

/** Fake daemon: live containers by ID, gateways by name; removal deletes. */
const fakeDaemon = () => {
  const live = new Map<string, { name: string; gateway?: string }>()
  const liveGateways = new Set<string>()
  const removed: string[] = []
  let seq = 0
  return {
    removed,
    liveCount: () => live.size + liveGateways.size,
    start: async (spec: { shardIndex: number }) => {
      seq++
      const id = `cid-${spec.shardIndex}-${seq}`
      const name = `arena-run-${spec.shardIndex}`
      const gateway = `arena-run-gw-${spec.shardIndex}`
      live.set(id, { name, gateway })
      liveGateways.add(gateway)
      return { name, baseUrl: `http://127.0.0.1:${45000 + spec.shardIndex}`, shardIndex: spec.shardIndex, containerId: id, gatewayName: gateway }
    },
    remove: async (name: string) => {
      removed.push(name)
      for (const [id, c] of live) {
        if (c.name === name) {
          live.delete(id)
          if (c.gateway) liveGateways.delete(c.gateway)
        }
      }
      liveGateways.delete(name)
    },
    stateOf: async (id: string): Promise<'running' | 'stopped' | 'unknown'> => {
      if (live.has(id) || liveGateways.has(id)) return 'running'
      for (const c of live.values()) if (c.name === id || c.gateway === id) return 'running'
      return 'stopped'
    },
  }
}

/** Fake shard OpenCode client: prompts succeed by writing the submission. */
const fakeShardClient = (opts: {
  writeSubmission: (agentId: string, text: string) => Promise<void>
  tag: (clientId: string) => void
  served: (clientId: string) => void
  catalogue: () => { providers: { id: string; models: Record<string, unknown> }[] }
}) => {
  const clientId = `client-${Math.random().toString(36).slice(2)}`
  opts.tag(clientId)
  return {
    health: async () => true,
    version: async () => '9.9.9-test',
    providers: async () => opts.catalogue(),
    createSession: async () => ({ id: `ses-${clientId}` }),
    prompt: async (_session: string, directory: string) => {
      opts.served(clientId)
      const agentId = directory.slice('/work/'.length)
      await opts.writeSubmission(agentId, '# Submission\n\nFITNESS=0.80\n')
      return { info: {}, parts: [] }
    },
    abort: async () => {},
  }
}

const seamsFor = (daemon: ReturnType<typeof fakeDaemon>, over: Record<string, unknown> = {}) => {
  const createdClients: string[] = []
  const servedBy: string[] = []
  let catalogue: { providers: { id: string; models: Record<string, unknown> }[] } = {
    providers: [{ id: 'mock', models: { model: {} } }],
  }
  const api = {
    createdClients,
    servedBy,
    setCatalogue: (c: typeof catalogue) => { catalogue = c },
  }
  const seams = {
    startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
    ensureImageFn: vi.fn(async () => {}),
    toolchainId: vi.fn(async () => TOOLCHAIN),
    readImageInventory: vi.fn(async () => inventoryFixture),
    readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * GiB, usedMemoryBytes: 0, cpus: 16, containers: [] })),
    sweepFn: vi.fn(async () => [] as string[]),
    validateModels: vi.fn(async () => {}),
    inspectPath: vi.fn(() => 'file' as const),
    ledger: new CapacityLedger(),
    hostModelsFile: vi.fn(() => '/host/models.json'),
    readTextFile: vi.fn(async (path: string) => (path.endsWith('models.json') ? catalogJson : authJson)),
    relay: vi.fn(async () => ({ policy: new RelayPolicy(), port: 45678 })),
    createShardNetworkFn: vi.fn(async (runId: string, i: number) => `arena-${runId}-net-${i}`),
    removeShardNetworkFn: vi.fn(async () => true),
    startShardContainerFn: vi.fn(daemon.start),
    removeContainerFn: vi.fn(daemon.remove),
    createShardClient: vi.fn((baseUrl: string) => fakeShardClient({
      writeSubmission: async (agentId, text) => {
        await sandboxRef!.writeFile({ agentId, workspacePath: `/work/${agentId}`, baseUrl }, 'SUBMISSION.md', text)
      },
      tag: (id) => createdClients.push(`${baseUrl}=${id}`),
      served: (id) => servedBy.push(`${baseUrl}=${id}`),
      catalogue: () => catalogue,
    })),
    runtimeStateOf: vi.fn(daemon.stateOf),
    ...over,
  }
  // Assigned after composeRun returns; the client factory only runs during rounds.
  let sandboxRef: { writeFile: (h: { agentId: string; workspacePath: string; baseUrl: string }, p: string, c: string) => Promise<void> } | null = null
  return { seams, api, setSandbox: (s: typeof sandboxRef) => { sandboxRef = s } }
}

const specFor = (root: string, extra: Record<string, unknown> = {}) => parseRunSpec({
  name: 'd', goal: 'g', sandbox: 'docker', isolation: 'shared',
  roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
  workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 2, containerMemory: '1g', ...extra,
})

async function composedEngine(root: string, opts: { isolation?: 'shared' | 'protected'; seamsOver?: Record<string, unknown> } = {}) {
  const daemon = fakeDaemon()
  const helper = seamsFor(daemon, opts.seamsOver)
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const holder = { value: '' }
  const composed = await composeRun(
    specFor(root, opts.isolation ? { isolation: opts.isolation } : {}),
    helper.seams as never,
    { runIdHolder: holder },
  )
  helper.setSandbox(composed.sandbox as never)
  const engine = new TournamentEngine({
    repos,
    config: composed.config,
    sandbox: composed.sandbox,
    runner: composed.runner,
    judge: new Judge(new MockProvider(11), composed.config.judge, 11),
    reflector: new Reflector(new MockProvider(11), composed.config.reflect, ['mock/model']),
    seedStrategy: (i) => `strategy variant ${i} alpha`,
    preparePopulation: composed.planFor ?? undefined,
    releasePopulation: composed.releasePopulation ?? undefined,
    audit: new AuditCollector(repos),
  })
  const run = engine.createRun('docker-recycle', 'goal')
  holder.value = run.id
  return { daemon, helper, db, repos, composed, engine, run }
}

describe('compose-run releasePopulation', () => {
  test('a round releases workers before grading and the next round recreates them with history intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compose-release-'))
    try {
      const { daemon, composed, engine, run, repos } = await composedEngine(root)
      expect(composed.releasePopulation).toBeTypeOf('function')

      const events: ShardServerEvent[] = []
      composed.onShardServer!((e) => events.push(e))

      const first = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(first.roundIdx).toBe(1)
      // Workers are gone before the round even returns, let alone before round 2.
      expect(daemon.liveCount()).toBe(0)
      expect(composed.shardServers).toEqual([])
      expect(composed.sessionMap.size).toBe(0)
      expect(events.filter((e) => e.type === 'started')).toHaveLength(2)
      expect(events.filter((e) => e.type === 'stopped')).toHaveLength(2)

      const round1Submissions = repos.submissions.forRound(first.roundId)
      expect(round1Submissions).toHaveLength(2)

      const second = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(second.roundIdx).toBe(2)
      expect(daemon.liveCount()).toBe(0)
      expect(events.filter((e) => e.type === 'started')).toHaveLength(4)
      expect(events.filter((e) => e.type === 'stopped')).toHaveLength(4)

      // Tournament data survived the recycling between rounds.
      expect(repos.submissions.forRound(first.roundId)).toEqual(round1Submissions)
      expect(repos.scores.forRound(first.roundId)).toHaveLength(2)
      expect(repos.scores.forRound(second.roundId)).toHaveLength(2)
      expect(repos.rounds.listForRun(run.id).map((r) => r.status)).toEqual(['complete', 'complete'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('retired endpoints get fresh clients and a fresh catalogue probe, even on a reused port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compose-release-'))
    try {
      const { engine, run, repos, composed, helper } = await composedEngine(root)
      // Fixed ports per shard: each round's runtime reuses the previous endpoints.
      await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      const servedRound1 = new Set(helper.api.servedBy)
      expect(servedRound1.size).toBe(2)

      helper.api.servedBy.length = 0
      await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })

      // Resolver clients were evicted: round 2 prompted through new clients,
      // never the retired round-1 ones.
      const servedRound2 = new Set(helper.api.servedBy)
      expect(servedRound2.size).toBe(2)
      for (const id of servedRound2) expect(servedRound1.has(id)).toBe(false)

      // And the catalogue is probed afresh per runtime: a replacement whose
      // catalogue drops the worker model fails as itself, not from stale cache.
      helper.api.setCatalogue({ providers: [{ id: 'other', models: { 'other/model': {} } }] })
      const agentId = repos.agents.listActive(run.id)[0]!.id
      await composed.planFor!([agentId])
      const handle = await composed.sandbox.provision(agentId, {})
      const refused = await composed.runner.run(handle, {
        agentId, goalMd: 'goal', timeoutMs: 5000,
        genome: { strategyMd: 's', notesMd: '', modelId: 'mock/model', temperature: 0.7 },
      })
      expect(refused.status).toBe('error')
      expect(refused.failure).toMatchObject({ code: 'MODEL_UNAVAILABLE' })
      expect(refused.failure!.message).toMatch(/Docker runtime/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a removal failure preserves the result and the reservation, then retries clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compose-release-'))
    try {
      const daemon = fakeDaemon()
      const helper = seamsFor(daemon)
      // Warning-only remover that "forgets" one worker: resolves, deletes nothing.
      const failing = new Set(['arena-run-0'])
      helper.seams.removeContainerFn.mockImplementation(async (name: string) => {
        if (failing.has(name)) return
        await daemon.remove(name)
      })
      const db = openDb(':memory:')
      const repos = makeRepos(db)
      const holder = { value: '' }
      const composed = await composeRun(specFor(root), helper.seams as never, { runIdHolder: holder })
      helper.setSandbox(composed.sandbox as never)
      const engine = new TournamentEngine({
        repos,
        config: composed.config,
        sandbox: composed.sandbox,
        runner: composed.runner,
        judge: new Judge(new MockProvider(11), composed.config.judge, 11),
        reflector: new Reflector(new MockProvider(11), composed.config.reflect, ['mock/model']),
        seedStrategy: (i) => `strategy variant ${i} alpha`,
        preparePopulation: composed.planFor ?? undefined,
        releasePopulation: composed.releasePopulation ?? undefined,
        audit: new AuditCollector(repos),
      })
      const run = engine.createRun('docker-recycle-fail', 'goal')
      holder.value = run.id

      const first = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      // The round result stands despite the cleanup failure.
      expect(repos.rounds.listForRun(run.id)[0]!.status).toBe('complete')
      expect(repos.scores.forRound(first.roundId)).toHaveLength(2)
      // Reported separately, and the reservation is preserved with the leak.
      expect(composed.warnings.some((w) => w.includes('arena-run-0'))).toBe(true)
      expect((helper.seams.ledger as CapacityLedger).active()).toHaveLength(1)
      expect(daemon.liveCount()).toBeGreaterThan(0)

      // The next round still runs, and its cleanup retries the leak to green.
      failing.clear()
      const second = await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      expect(second.roundIdx).toBe(2)
      expect(daemon.liveCount()).toBe(0)
      db.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('every round re-admits the full population, and an over-limit clone is refused before its row exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'compose-release-'))
    try {
      const daemon = fakeDaemon()
      const helper = seamsFor(daemon)
      const db = openDb(':memory:')
      const repos = makeRepos(db)
      const holder = { value: '' }
      const composed = await composeRun(
        specFor(root, { isolation: 'protected', maxContainers: 2 }),
        helper.seams as never,
        { runIdHolder: holder },
      )
      helper.setSandbox(composed.sandbox as never)
      const engine = new TournamentEngine({
        repos,
        config: composed.config,
        sandbox: composed.sandbox,
        runner: composed.runner,
        judge: new Judge(new MockProvider(11), composed.config.judge, 11),
        reflector: new Reflector(new MockProvider(11), composed.config.reflect, ['mock/model']),
        seedStrategy: (i) => `strategy variant ${i} alpha`,
        preparePopulation: composed.planFor ?? undefined,
        releasePopulation: composed.releasePopulation ?? undefined,
        audit: new AuditCollector(repos),
      })
      const run = engine.createRun('docker-recycle-cap', 'goal')
      holder.value = run.id

      await engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null })
      const readsAfterFirst = (helper.seams.readCapacity as ReturnType<typeof vi.fn>).mock.calls.length
      expect(readsAfterFirst).toBeGreaterThanOrEqual(2)

      // A manual clone grows the population past the protected container limit.
      const victim = repos.agents.listActive(run.id)[0]!
      const genome = repos.genomes.forAgent(victim.id).at(-1)!
      const clone = repos.agents.create({ runId: run.id, label: 'manual-clone', parentAgentId: victim.id, bornRound: 2 })
      repos.genomes.create({
        agentId: clone.id, roundIdx: 2, strategyMd: genome.strategyMd, notesMd: genome.notesMd,
        modelId: genome.modelId, temperature: genome.temperature, parentGenomeId: genome.id, origin: 'manual',
      })

      await expect(engine.runRound(run.id, { goalMd: 'goal', criteriaMd: null }))
        .rejects.toThrow(/Protected isolation needs one container per agent/)
      expect(repos.rounds.listForRun(run.id)).toHaveLength(1)
      db.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('mock composition exposes no releasePopulation', async () => {
    const composed = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }), {})
    expect(composed.releasePopulation ?? null).toBeNull()
  })
})
