import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../../src/db/open.js'
import { makeRepos } from '../../src/db/repos.js'
import { DEFAULT_CONFIG } from '../../src/core/types.js'
import { TournamentEngine } from '../../src/engine/driver.js'
import { Judge } from '../../src/judge/judge.js'
import { Reflector } from '../../src/evolution/reflect.js'
import { MockProvider } from '../../src/runtime/mock-provider.js'
import { DockerSandbox } from '../../src/runtime/docker/sandbox.js'
import { OpenCodeAgentRunner, QUIESCE_GRACE_MS } from '../../src/runtime/opencode/agent-runner.js'
import { OpenCodeClient, type PromptResponse } from '../../src/runtime/opencode/client.js'

const terminal: PromptResponse = { info: {}, parts: [{ type: 'text', text: 'done' }] }

/** What the fake daemon reports for one container. */
interface DaemonState {
  running: boolean
  oomKilled: boolean
}

/**
 * A client whose prompt fails for the victim's workspace as a transport failure
 * (the OOM-killed server drops the connection), while survivors answer. The real
 * `sessionStatus` implementation is kept: with a rejecting transport, the status
 * endpoint is unavailable and reads `unknown`.
 */
class OomClient extends OpenCodeClient {
  constructor(
    private failDirs: Set<string>,
    private onPrompt: (agentId: string) => Promise<void>,
  ) {
    // No transport reaches the network: the status endpoint is unavailable, so
    // the real `sessionStatus` implementation reads every poll as `unknown`.
    super({
      baseUrl: 'http://fake.invalid',
      timeoutMs: 50,
      transport: async () => { throw new Error('socket hang up') },
    })
  }
  override async createSession(): Promise<{ id: string }> {
    return { id: `sess-${Math.random()}` }
  }
  override async prompt(_sessionId: string, directory: string): Promise<PromptResponse> {
    const agentId = directory.slice('/work/'.length)
    if (this.failDirs.has(directory)) throw new TypeError('fetch failed')
    await this.onPrompt(agentId)
    return terminal
  }
  override async abort(): Promise<void> {}
}

interface OomFixture {
  root: string
  engine: TournamentEngine
  repos: ReturnType<typeof makeRepos>
  sandbox: DockerSandbox
  runner: OpenCodeAgentRunner
  client: OomClient
  failDirs: Set<string>
  daemon: Map<string, DaemonState>
  nameToId: Map<string, string>
  /**
   * Resolves once `n` agents have settled their run in total (done or failed) —
   * the real-I/O gate to reach before advancing fake timers. Prompt dispatch is
   * too early: the survivor's submission write is still in flight then, and the
   * driver's deadline would win the race once fake time moves.
   */
  waitForSettled: (n: number) => Promise<void>
  failures: { agentId: string; code: string | undefined }[]
  close: () => Promise<void>
}

async function oomFixture(opts: { bottomPct?: number } = {}): Promise<OomFixture> {
  const root = await mkdtemp(join(tmpdir(), 'arena-oom-recovery-'))
  const db = openDb(':memory:')
  const repos = makeRepos(db)
  const failDirs = new Set<string>()
  const daemon = new Map<string, DaemonState>()
  const nameToId = new Map<string, string>()
  let settled = 0
  const settleWaiters = new Map<number, () => void>()
  const waitForSettled = (n: number): Promise<void> =>
    settled >= n ? Promise.resolve() : new Promise<void>((resolve) => { settleWaiters.set(n, resolve) })
  const noteSettled = () => {
    settled++
    settleWaiters.get(settled)?.()
  }
  const failures: { agentId: string; code: string | undefined }[] = []
  const config = {
    ...DEFAULT_CONFIG,
    populationSize: 2,
    sandbox: 'docker' as const,
    isolation: 'protected' as const,
    maxContainers: 2,
    concurrency: 2,
    agentTimeoutMs: 50,
    roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    selection: { ...DEFAULT_CONFIG.selection, topPct: 0.5, bottomPct: opts.bottomPct ?? 0.5 },
  }
  const sandbox = new DockerSandbox({
    runId: 'fake',
    root,
    maxContainers: 2,
    image: 'fake',
    memory: '1g',
    cpus: 1,
    authFile: null,
    isolation: 'protected',
    startContainer: async (shardIndex: number) => {
      const name = `fake-shard-${shardIndex}`
      const containerId = `fake-cid-${shardIndex}`
      nameToId.set(name, containerId)
      return { name, baseUrl: 'http://fake.invalid', shardIndex, containerId }
    },
    stopContainer: async () => {},
  })
  const client = new OomClient(failDirs, async (agentId) => {
    await sandbox.writeFile(
      { agentId, workspacePath: `/work/${agentId}`, baseUrl: 'http://fake.invalid' },
      'SUBMISSION.md',
      '# Submission\nFITNESS=0.9\n',
    )
  })
  const runner = new OpenCodeAgentRunner(client, sandbox, {
    // Mirrors the dashboard/CLI composition: OOM evidence by container name, exactly
    // like the daemon's own record; termination by the invocation's original ID.
    resourceFailure: async (handle) => {
      const name = sandbox.containerNameFor(handle.agentId)
      const state = name ? daemon.get(nameToId.get(name) ?? '') : undefined
      if (!state?.oomKilled) return null
      return {
        code: 'CONTAINER_OOM',
        message: `Container ${name} was stopped for exceeding its 1g memory limit.`,
      }
    },
    runtimeState: async (handle) => {
      const id = handle.runtimeId
      if (!id) return 'unknown'
      const state = daemon.get(id)
      if (!state) return 'stopped'
      return state.running ? 'running' : 'stopped'
    },
  })
  const provider = new MockProvider(1)
  const engine = new TournamentEngine({
    repos,
    config,
    sandbox,
    runner,
    judge: new Judge(provider, config.judge, 1),
    reflector: new Reflector(provider, config.reflect, ['mock/model']),
    seedStrategy: () => 'strategy',
    preparePopulation: (ids) => sandbox.planFor(ids),
    onEvent: (event) => {
      if (event.type === 'agent.status' && (event.status === 'done' || event.status === 'failed')) {
        noteSettled()
        if (event.status === 'failed') {
          failures.push({ agentId: event.agentId, code: event.failure?.code })
        }
      }
    },
  })
  return {
    root,
    engine,
    repos,
    sandbox,
    runner,
    client,
    failDirs,
    daemon,
    nameToId,
    waitForSettled,
    failures,
    close: async () => {
      await sandbox.disposeAll()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function firstRoundWithOomVictim(fx: OomFixture, opts: { oom?: boolean } = {}) {
  const oom = opts.oom ?? true
  const run = fx.engine.createRun('oom-recovery', 'original goal')
  const [victim, survivor] = fx.repos.agents.listActive(run.id).map((a) => a.id)
  fx.failDirs.add(`/work/${victim}`)
  // The daemon's account of the victim's original container: exited and
  // OOM-killed — or still running, for the refusal case.
  fx.daemon.set('fake-cid-0', oom ? { running: false, oomKilled: true } : { running: true, oomKilled: false })
  fx.daemon.set('fake-cid-1', { running: true, oomKilled: false })
  const first = fx.engine.runRound(run.id, { goalMd: 'original goal', criteriaMd: null })
  // Both runs must have returned before fake time moves: their submission
  // writes are real filesystem I/O, and the driver's deadline would win the
  // race once the clock advances.
  await fx.waitForSettled(2)
  await vi.advanceTimersByTimeAsync(50 + QUIESCE_GRACE_MS)
  const result = await first
  expect(result.roundIdx).toBe(1)
  const submissions = fx.repos.submissions.forRound(result.roundId)
  const victimSubmission = submissions.find((s) => s.agentId === victim)!
  expect(victimSubmission.status).toBe('error')
  // No terminal response arrived, so usage stays unknown — never a zero.
  expect(victimSubmission.usageKnown).toBe(false)
  if (oom) {
    // The OOM classification survives reconciliation: Docker-confirmed
    // termination proves the worker cannot continue writing, not that its
    // prior output was valid.
    expect(fx.failures.filter((f) => f.agentId === victim).map((f) => f.code)).toEqual(['CONTAINER_OOM'])
  }
  return { run, victim: victim!, survivor: survivor! }
}

describe('OOM-killed worker recovery', () => {
  test('retire the dead agent and clone it: the next round plans and provisions the current roster', async () => {
    // No natural cull: the dead agent stays active until the operator retires
    // it, so retire-plus-clone keeps the population (and the container count).
    const fx = await oomFixture({ bottomPct: 0 })
    try {
      const { run, victim, survivor } = await firstRoundWithOomVictim(fx)

      fx.repos.agents.retire(victim, 1, 'retired')
      const victimGenome = fx.repos.genomes.forAgent(victim).at(-1)!
      const clone = fx.repos.agents.create({
        runId: run.id, label: 'competitor-r2-manual-3', parentAgentId: victim, bornRound: 2,
      })
      fx.repos.genomes.create({
        agentId: clone.id, roundIdx: 2, strategyMd: victimGenome.strategyMd, notesMd: victimGenome.notesMd,
        modelId: victimGenome.modelId, temperature: victimGenome.temperature,
        parentGenomeId: victimGenome.id, origin: 'manual',
      })

      // A fresh worker serves the next round; the fake reuses shard containers.
      fx.daemon.set('fake-cid-0', { running: true, oomKilled: false })
      fx.failDirs.clear()
      const provision = vi.spyOn(fx.sandbox, 'provision')
      // The next round runs without any worker failure, so nothing on its path
      // needs fake time to move — awaiting it directly keeps a refusal a clean
      // rejection instead of a gate timeout.
      const result = await fx.engine.runRound(run.id, { goalMd: 'replacement goal', criteriaMd: null })
      expect(result.roundIdx).toBe(2)
      const provisioned = provision.mock.calls.map((c) => c[0])
      expect(provisioned).toContain(survivor)
      expect(provisioned).toContain(clone.id)
      expect(provisioned).not.toContain(victim)
      const survivorHandle = { agentId: survivor, workspacePath: `/work/${survivor}`, baseUrl: '' }
      expect(await fx.sandbox.readFile(survivorHandle, 'GOAL.md')).toBe('replacement goal')
      // No spurious failed round was left behind by the first attempt.
      expect(fx.repos.rounds.listForRun(run.id).filter((r) => r.status === 'failed')).toEqual([])
    } finally {
      await fx.close()
    }
  })

  test('cull the dead agent through ordinary selection: the next round still proceeds', async () => {
    const fx = await oomFixture()
    try {
      const { run, victim, survivor } = await firstRoundWithOomVictim(fx)

      const activeIds = fx.repos.agents.listActive(run.id).map((a) => a.id)
      expect(activeIds).not.toContain(victim)
      expect(activeIds).toContain(survivor)

      fx.daemon.set('fake-cid-0', { running: true, oomKilled: false })
      fx.failDirs.clear()
      const provision = vi.spyOn(fx.sandbox, 'provision')
      const result = await fx.engine.runRound(run.id, { goalMd: 'replacement goal', criteriaMd: null })
      expect(result.roundIdx).toBe(2)
      expect(provision.mock.calls.map((c) => c[0])).not.toContain(victim)
      expect(provision.mock.calls).toHaveLength(2)
    } finally {
      await fx.close()
    }
  })

  test('a refused preflight consumes no round number and leaves no failed round', async () => {
    const fx = await oomFixture({ bottomPct: 0 })
    try {
      const { run } = await firstRoundWithOomVictim(fx, { oom: false })
      // The worker never actually died: its original container is still running.
      await expect(fx.engine.runRound(run.id, { goalMd: 'replacement goal', criteriaMd: null }))
        .rejects.toThrow(/still running/)
      expect(fx.repos.rounds.lastIdx(run.id)).toBe(1)
      expect(fx.repos.rounds.listForRun(run.id)).toHaveLength(1)
    } finally {
      await fx.close()
    }
  })
})
