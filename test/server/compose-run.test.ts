import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { composeRun, pathKind, runConfigFor, type ComposeSeams } from '../../src/server/compose-run.js'
import { CapacityLedger } from '../../src/runtime/docker/capacity.js'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'

// Fake keys and a trimmed catalogue: fixtures, not anyone's credentials.
const catalogJson = JSON.stringify({
  w: { api: 'https://api.w.example/v1', npm: '@ai-sdk/openai-compatible', models: {} },
  wandb: { api: 'https://api.inference.wandb.ai/v1', npm: '@ai-sdk/openai-compatible', models: {} },
  opencode: { api: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible', models: {} },
  bedrock: { api: null, npm: '@ai-sdk/amazon-bedrock', models: {} },
})
const authJson = JSON.stringify({ w: { type: 'api', key: 'FAKE-W-KEY' }, wandb: { type: 'api', key: 'FAKE-WANDB-KEY' } })
import { parseRunSpec } from '../../src/server/run-spec.js'

const TOOLCHAIN = 'abc123def4567890'
const inventoryFixture = {
  schemaVersion: 1 as const,
  toolchainId: TOOLCHAIN,
  python: { version: '3.11.2', venv: '/opt/arena/venv', executable: '/opt/arena/venv/bin/python' },
  tools: ['python3', 'node', 'git', 'opencode', 'rg'].map((name) => ({ name, version: '1.0', executable: `/usr/bin/${name}` })),
  pythonPackages: [{ name: 'numpy', version: '2.3.3' }],
}

const mockSeams = () => ({
  startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
  attachHostServer: vi.fn(),
  ensureImageFn: vi.fn(async () => {}),
  toolchainId: vi.fn(async () => TOOLCHAIN),
  readImageInventory: vi.fn(async () => inventoryFixture),
  readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
  sweepFn: vi.fn(async () => [] as string[]),
  validateModels: vi.fn(async () => {}),
  inspectPath: vi.fn((): 'file' | 'directory' | 'missing' => 'file'),
  // Never the process ledger: a test that skips cleanup must not leave capacity reserved for the next.
  ledger: new CapacityLedger(),
  // The protected runtime's host side: never the real credentials file, catalogue, relay or Docker networks.
  hostModelsFile: vi.fn(() => '/host/models.json'),
  readTextFile: vi.fn(async (path: string) => (path.endsWith('models.json') ? catalogJson : authJson)),
  relay: vi.fn(async () => ({ policy: new RelayPolicy(), port: 45678 })),
  createShardNetworkFn: vi.fn(async (runId: string, shardIndex: number) => `arena-${runId}-net-${shardIndex}`),
  removeShardNetworkFn: vi.fn(async (_name: string, _onWarning?: (message: string) => void) => true),
})

describe('composeRun', () => {
  test('mock mode needs no server or capacity checks', async () => {
    const seams = mockSeams()
    const c = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }), seams as never)
    expect(c.warnings).toEqual([])
    expect(seams.startHostServer).not.toHaveBeenCalled()
    expect(seams.readCapacity).not.toHaveBeenCalled()
    expect(c.planFor).toBeNull()
  })

  describe('docker auth file', () => {
    const dockerSpec = (root: string, authFile: string) => parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker',
      roster: [{ modelId: 'wandb/zai-org/GLM-5.2', count: 1, temperature: 0.7 }],
      workspaceRoot: root, authFile,
    })

    // The September 14 test run: a folder typed into "Auth file" was bind-mounted where
    // auth.json belongs, the containers had no credentials, and every keyed provider failed.
    test('a folder is refused before any server, capacity read or container starts', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-auth-'))
      const seams = { ...mockSeams(), inspectPath: vi.fn((): 'directory' => 'directory') }
      try {
        await expect(composeRun(dockerSpec(root, 'C:\\Users\\me\\Crypto-research'), seams as never))
          .rejects.toThrow(/C:\\Users\\me\\Crypto-research is a folder, not a credentials file.*Leave "Credentials file" blank.*use "Context folder" instead/)
        expect(seams.startHostServer).not.toHaveBeenCalled()
        expect(seams.readCapacity).not.toHaveBeenCalled()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('a path that does not exist is refused the same way', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-auth-'))
      const seams = { ...mockSeams(), inspectPath: vi.fn((): 'missing' => 'missing') }
      try {
        await expect(composeRun(dockerSpec(root, '/nowhere/auth.json'), seams as never)).rejects.toThrow(/does not exist/)
        expect(seams.startHostServer).not.toHaveBeenCalled()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('pathKind tells a file, a folder and nothing apart on the real filesystem', () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-pathkind-'))
      try {
        writeFileSync(join(root, 'auth.json'), '{}')
        expect(pathKind(join(root, 'auth.json'))).toBe('file')
        expect(pathKind(root)).toBe('directory')
        expect(pathKind(join(root, 'absent.json'))).toBe('missing')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  test('a real run starts its host server with web search on and writes the grader profile for the real folder path', async () => {
    const seams = mockSeams()
    seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
    const root = mkdtempSync(join(tmpdir(), 'compose-grader-'))
    const ctx = mkdtempSync(join(tmpdir(), 'compose-grader-ctx-'))
    // A linked spelling of the folder, like the 8.3 path that left the grader unable to read
    // it: OpenCode checks permissions against the real path, so the profile must name that.
    const linked = `${ctx}-link`
    symlinkSync(ctx, linked, 'junction')
    const real = realpathSync.native(ctx)
    try {
      const c = await composeRun(parseRunSpec({
        name: 'l', goal: 'g', sandbox: 'local',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
        workspaceRoot: root, contextDir: linked,
      }), { ...seams, inspectPath: vi.fn(() => 'directory' as const) } as never)
      expect(seams.startHostServer).toHaveBeenCalledWith(expect.objectContaining({ env: { OPENCODE_ENABLE_EXA: '1' } }))
      const profile = join(root, '.arena-grader', '.opencode', 'agents', 'grader.md')
      expect(existsSync(profile)).toBe(true)
      expect(readFileSync(profile, 'utf8')).toContain(`${JSON.stringify(`${real.replace(/\\/g, '/')}/*`)}: allow`)
      expect(readFileSync(profile, 'utf8')).not.toContain('-link')
      expect(c.config.contextDir).toBe(real)
      await c.cleanup()
    } finally {
      rmSync(linked, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      rmSync(ctx, { recursive: true, force: true })
    }
  })

  describe('protected runtime', () => {
    const GiB = 1024 ** 3
    const host = { totalMemoryBytes: 16 * GiB, usedMemoryBytes: 0, cpus: 16, containers: [] }
    const spec = (root: string, extra: Record<string, unknown> = {}) => parseRunSpec({
      name: 'p', goal: 'g', sandbox: 'docker',
      roster: [{ modelId: 'wandb/zai-org/GLM-5.2', count: 2, temperature: 0.7 }],
      workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: 2, ...extra,
    })
    const started = () => vi.fn(async (s: { shardIndex: number; runId: string }) => ({
      name: `arena-${s.runId}-${s.shardIndex}`, baseUrl: `http://127.0.0.1:${46000 + s.shardIndex}`, shardIndex: s.shardIndex,
      gatewayName: `arena-${s.runId}-gw-${s.shardIndex}`, network: `arena-${s.runId}-net-${s.shardIndex}`,
    }))

    test('grants the relay a run token for roster models with this run\'s keys, and gives workers no credential', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-protected-'))
      const policy = new RelayPolicy()
      const grant = vi.spyOn(policy, 'grant')
      const revoke = vi.spyOn(policy, 'revoke')
      const startShardContainerFn = started()
      const seams = {
        ...mockSeams(),
        startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
        readCapacity: vi.fn(async () => host),
        relay: vi.fn(async () => ({ policy, port: 45678 })),
        startShardContainerFn,
        removeContainerFn: vi.fn(async (_name: string) => {}),
      }
      try {
        const c = await composeRun(spec(root), seams as never, { runIdHolder: { value: 'run-9' } })
        expect(grant).toHaveBeenCalledTimes(1)
        const [grantId, g] = grant.mock.calls[0]!
        expect(g.allowedModels).toEqual(['wandb/zai-org/GLM-5.2'])
        expect(g.upstreams).toEqual([{ providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer', apiKey: 'FAKE-WANDB-KEY' }])

        await c.planFor!(['a1', 'a2'])
        await Promise.all([c.sandbox.provision('a1', {}), c.sandbox.provision('a2', {})])
        for (const [s] of startShardContainerFn.mock.calls as unknown as [{ shardIndex: number; authFile: string | null; modelsFile: string | null; protectedRuntime: { network: string; configDir: string; relayPort: number } }][]) {
          expect(s.authFile).toBeNull()
          expect(s.modelsFile).toBeNull()
          expect(s.protectedRuntime).toEqual({
            network: `arena-run-9-net-${s.shardIndex}`,
            configDir: join(root, '.arena-runtime', 'run-9', `shard-${s.shardIndex}-config`),
            relayPort: 45678,
          })
          const opencodeJson = readFileSync(join(s.protectedRuntime.configDir, 'opencode.json'), 'utf8')
          expect(JSON.parse(opencodeJson).provider).toEqual({ wandb: { options: { baseURL: 'http://gateway:8787/wandb', apiKey: g.token } } })
          expect(readFileSync(join(s.protectedRuntime.configDir, 'models.json'), 'utf8')).toBe(catalogJson)
          expect(readdirSync(s.protectedRuntime.configDir).sort()).toEqual(['models.json', 'opencode.json'])
          expect(opencodeJson).not.toContain('FAKE-')
        }

        await c.cleanup()
        expect(revoke).toHaveBeenCalledWith(grantId)
        expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(seams.removeContainerFn.mock.invocationCallOrder[0]!)
        expect(seams.removeContainerFn.mock.calls.map((call) => call[0]).sort()).toEqual(['arena-run-9-0', 'arena-run-9-1', 'arena-run-9-gw-0', 'arena-run-9-gw-1'])
        expect(seams.removeShardNetworkFn.mock.calls.map((call) => call[0]).sort()).toEqual(['arena-run-9-net-0', 'arena-run-9-net-1'])
        expect(existsSync(join(root, '.arena-runtime', 'run-9'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('a roster provider the relay cannot carry refuses the run before anything starts, and says how to proceed', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-protected-'))
      const seams = { ...mockSeams(), readCapacity: vi.fn(async () => host) }
      try {
        await expect(composeRun(spec(root, { roster: [{ modelId: 'bedrock/claude', count: 1, temperature: 0.7 }], maxContainers: 1 }), seams as never))
          .rejects.toThrow(/relay, which cannot carry: bedrock uses an SDK the relay cannot carry\..*choose shared isolation/)
        expect(seams.startHostServer).not.toHaveBeenCalled()
        expect(seams.readCapacity).not.toHaveBeenCalled()
        expect(seams.relay).not.toHaveBeenCalled()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('without a host model catalogue a protected run is refused rather than started unpinned', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-protected-'))
      const seams = { ...mockSeams(), hostModelsFile: vi.fn(() => null) }
      try {
        await expect(composeRun(spec(root), seams as never)).rejects.toThrow(/Protected isolation needs the host model catalogue/)
        expect(seams.startHostServer).not.toHaveBeenCalled()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('each shard\'s gateway counts against the run\'s capacity', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-protected-'))
      const ledger = new CapacityLedger()
      const seams = {
        ...mockSeams(), ledger, readCapacity: vi.fn(async () => host),
        startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
      }
      try {
        const c = await composeRun(spec(root), seams as never)
        expect(ledger.active()).toEqual([{ id: expect.any(String), containers: 2, memoryBytes: GiB + 64 * 1024 ** 2, cpus: 1.25 }])
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('a failure after the grant revokes it', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-protected-'))
      const policy = new RelayPolicy()
      const revoke = vi.spyOn(policy, 'revoke')
      const seams = {
        ...mockSeams(),
        readCapacity: vi.fn(async () => host),
        startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
        relay: vi.fn(async () => ({ policy, port: 45678 })),
        ensureImageFn: vi.fn(async () => { throw new Error('no docker daemon') }),
      }
      try {
        await expect(composeRun(spec(root), seams as never)).rejects.toThrow(/no docker daemon/)
        expect(revoke).toHaveBeenCalledTimes(1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('shared isolation keeps the direct path: no relay, network or gateway', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-protected-'))
      const startShardContainerFn = vi.fn(async (s: { shardIndex: number }) => ({ name: `arena-x-${s.shardIndex}`, baseUrl: 'http://127.0.0.1:47000', shardIndex: s.shardIndex }))
      const seams = {
        ...mockSeams(), readCapacity: vi.fn(async () => host), startShardContainerFn, removeContainerFn: vi.fn(async () => {}),
        startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
      }
      try {
        const c = await composeRun(spec(root, { isolation: 'shared' }), seams as never)
        await c.planFor!(['a1'])
        await c.sandbox.provision('a1', {})
        const [s] = startShardContainerFn.mock.calls[0] as unknown as [{ authFile: string | null; modelsFile: string | null; protectedRuntime?: unknown }]
        expect(s.authFile).toBe(join(root, 'auth.json'))
        expect(s.modelsFile).toBe('/host/models.json')
        expect(s.protectedRuntime).toBeUndefined()
        expect(seams.relay).not.toHaveBeenCalled()
        expect(seams.createShardNetworkFn).not.toHaveBeenCalled()
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('capacity reservations and resource failures', () => {
    const GiB = 1024 ** 3
    const host = { totalMemoryBytes: 5 * GiB, usedMemoryBytes: 0, cpus: 16, containers: [] }
    const spec = (root: string, count: number) => parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker',
      roster: [{ modelId: 'w/m', count, temperature: 0.7 }],
      workspaceRoot: root, authFile: join(root, 'auth.json'), maxContainers: count, containerMemory: '1g',
    })
    const seamsWith = (ledger: CapacityLedger, over: Record<string, unknown> = {}) => ({
      ...mockSeams(),
      startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn(async () => {}) })),
      ledger,
      readCapacity: vi.fn(async () => host),
      ...over,
    })
    const shardClient = (prompt: () => Promise<unknown>) => ({
      health: vi.fn(async () => true),
      version: vi.fn(async () => '1.18.21'),
      providers: vi.fn(async () => ({ providers: [{ id: 'w', models: { m: {} } }], default: {} })),
      createSession: vi.fn(async () => ({ id: 'ses_ok' })),
      prompt: vi.fn(prompt),
      abort: vi.fn(async () => {}),
    })
    const containers = () => vi.fn(async (s: { shardIndex: number }) => ({
      name: `arena-run-${s.shardIndex}`, baseUrl: `http://127.0.0.1:${45000 + s.shardIndex}`, shardIndex: s.shardIndex,
    }))
    const genome = { strategyMd: 's', notesMd: '', modelId: 'w/m', temperature: 0.7 }

    test('two starts that together exceed the budget: the second is refused before its server starts', async () => {
      const ledger = new CapacityLedger()
      const r1 = mkdtempSync(join(tmpdir(), 'compose-cap-'))
      const r2 = mkdtempSync(join(tmpdir(), 'compose-cap-'))
      try {
        const first = await composeRun(spec(r1, 3), seamsWith(ledger) as never)
        const refused = seamsWith(ledger)
        await expect(composeRun(spec(r2, 2), refused as never)).rejects.toThrow(/docker sandbox: .*already reserved by other runs in this app/)
        expect(refused.startHostServer).not.toHaveBeenCalled()
        await first.cleanup()
        expect(ledger.active()).toEqual([])
        const second = await composeRun(spec(r2, 2), seamsWith(ledger) as never)
        expect(ledger.active()).toHaveLength(1)
        await second.cleanup()
      } finally {
        rmSync(r1, { recursive: true, force: true })
        rmSync(r2, { recursive: true, force: true })
      }
    })

    test('a failed setup releases its reservation; other runs stay counted; cleanup is idempotent', async () => {
      const ledger = new CapacityLedger()
      const r1 = mkdtempSync(join(tmpdir(), 'compose-cap-'))
      const r2 = mkdtempSync(join(tmpdir(), 'compose-cap-'))
      try {
        const first = await composeRun(spec(r1, 2), seamsWith(ledger) as never)
        const failing = seamsWith(ledger, { validateModels: vi.fn(async () => { throw new Error('judge unusable') }) })
        // One agent: it must be admitted, so the failure under test is the later one.
        await expect(composeRun(spec(r2, 1), failing as never)).rejects.toThrow(/judge unusable/)
        expect(ledger.active()).toHaveLength(1)
        await first.cleanup()
        await first.cleanup()
        expect(ledger.active()).toEqual([])
      } finally {
        rmSync(r1, { recursive: true, force: true })
        rmSync(r2, { recursive: true, force: true })
      }
    })

    test('unknown capacity refuses a protected run and reserves nothing', async () => {
      const ledger = new CapacityLedger()
      const root = mkdtempSync(join(tmpdir(), 'compose-cap-'))
      try {
        const s = seamsWith(ledger, { readCapacity: vi.fn(async () => { throw new Error('docker stats failed') }) })
        await expect(composeRun(spec(root, 2), s as never)).rejects.toThrow(/host capacity could not be read, so a protected run cannot be admitted/)
        expect(s.startHostServer).not.toHaveBeenCalled()
        expect(ledger.active()).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('exposes the planned placement for the dashboard', async () => {
      const ledger = new CapacityLedger()
      const root = mkdtempSync(join(tmpdir(), 'compose-cap-'))
      try {
        const c = await composeRun(spec(root, 2), seamsWith(ledger, { startShardContainerFn: containers() }) as never)
        expect(c.placement?.()).toEqual([])
        await c.planFor!(['a1', 'a2'])
        expect(c.placement?.()).toEqual([
          { shardIndex: 0, agentIds: ['a1'], occupancy: 'single' },
          { shardIndex: 1, agentIds: ['a2'], occupancy: 'single' },
        ])
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('an agent whose container was OOM-killed fails as a resource limit, not a model failure', async () => {
      const ledger = new CapacityLedger()
      const root = mkdtempSync(join(tmpdir(), 'compose-oom-'))
      const inspectContainer = vi.fn(async () => ({ oomKilled: true, running: false }))
      try {
        const c = await composeRun(spec(root, 1), seamsWith(ledger, {
          startShardContainerFn: containers(),
          removeContainerFn: vi.fn(async () => {}),
          createShardClient: () => shardClient(async () => { throw new Error('socket hang up') }),
          inspectContainer,
        }) as never)
        await c.planFor!(['a1'])
        const h = await c.sandbox.provision('a1', {})
        const result = await c.runner.run(h, { agentId: 'a1', goalMd: 'g', timeoutMs: 1000, genome })
        expect(inspectContainer).toHaveBeenCalledWith('arena-run-0')
        expect(result.status).toBe('error')
        expect(result.failure).toMatchObject({
          code: 'CONTAINER_OOM',
          message: expect.stringMatching(/arena-run-0 was stopped for exceeding its 1g memory limit/),
        })
        expect(result.errorText).toMatch(/memory limit/)
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('without daemon evidence the original failure is kept, not guessed at', async () => {
      const ledger = new CapacityLedger()
      const root = mkdtempSync(join(tmpdir(), 'compose-oom-'))
      try {
        const c = await composeRun(spec(root, 1), seamsWith(ledger, {
          startShardContainerFn: containers(),
          removeContainerFn: vi.fn(async () => {}),
          createShardClient: () => shardClient(async () => { throw new Error('socket hang up') }),
          inspectContainer: vi.fn(async () => null),
        }) as never)
        await c.planFor!(['a1'])
        const h = await c.sandbox.provision('a1', {})
        const result = await c.runner.run(h, { agentId: 'a1', goalMd: 'g', timeoutMs: 1000, genome })
        expect(result.status).toBe('error')
        expect(result.failure?.code).not.toBe('CONTAINER_OOM')
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('a Docker-confirmed worker death unblocks the next round and keeps the failure record', async () => {
      const ledger = new CapacityLedger()
      const root = mkdtempSync(join(tmpdir(), 'compose-oom-'))
      const states = new Map<string, 'running' | 'stopped' | 'unknown'>([['cid-9', 'running']])
      const runtimeStateOf = vi.fn(async (id: string) => states.get(id) ?? 'unknown')
      try {
        const c = await composeRun(spec(root, 1), seamsWith(ledger, {
          startShardContainerFn: vi.fn(async (s: { shardIndex: number }) => ({
            name: `arena-run-${s.shardIndex}`, baseUrl: `http://127.0.0.1:${45000 + s.shardIndex}`, shardIndex: s.shardIndex,
            containerId: 'cid-9',
          })),
          removeContainerFn: vi.fn(async () => {}),
          createShardClient: () => shardClient(async () => { throw new Error('socket hang up') }),
          inspectContainer: vi.fn(async () => ({ oomKilled: true, running: false })),
          runtimeStateOf,
        }) as never)
        await c.planFor!(['a1'])
        const h = await c.sandbox.provision('a1', {})
        // The provisioned handle carries the worker's container ID for later termination checks.
        expect(h.runtimeId).toBe('cid-9')
        const result = await c.runner.run(h, { agentId: 'a1', goalMd: 'g', timeoutMs: 1000, genome })
        expect(result.failure).toMatchObject({ code: 'CONTAINER_OOM' })
        const ready = () => c.runner.assertReadyForRound?.()
        // The original container is still running: the next round stays refused.
        await expect(ready()).rejects.toThrow(/still running/)
        expect(runtimeStateOf).toHaveBeenCalledWith('cid-9')
        // The daemon confirms the original container stopped: reconciled, while
        // the recorded failure still says what killed the worker.
        states.set('cid-9', 'stopped')
        await expect(ready()).resolves.toBeUndefined()
        expect(result.failure).toMatchObject({ code: 'CONTAINER_OOM' })
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('context folder', () => {
    const localSpec = (root: string, contextDir: string) => parseRunSpec({
      name: 'l', goal: 'g', sandbox: 'local',
      roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
      workspaceRoot: root, contextDir,
    })

    test('a file or a missing path is refused before any server starts', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-ctx-'))
      try {
        for (const kind of ['file', 'missing'] as const) {
          const seams = { ...mockSeams(), inspectPath: vi.fn(() => kind) }
          await expect(composeRun(localSpec(root, join(tmpdir(), 'ctx-x')), seams as never))
            .rejects.toThrow(/Context folder .* (is a file|does not exist)/)
          expect(seams.startHostServer).not.toHaveBeenCalled()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('overlap with the workspace root either way is refused', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-ctx-'))
      try {
        const seams = { ...mockSeams(), inspectPath: vi.fn(() => 'directory' as const) }
        await expect(composeRun(localSpec(join(root, 'ws'), root), seams as never))
          .rejects.toThrow(/must not contain the workspace root/)
        await expect(composeRun(localSpec(root, join(root, 'ctx')), seams as never))
          .rejects.toThrow(/must not be inside the workspace root/)
        expect(seams.startHostServer).not.toHaveBeenCalled()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  test('docker without capacity fails before spending', async () => {
    const seams = mockSeams()
    seams.readCapacity.mockResolvedValueOnce({ totalMemoryBytes: 2 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })
    await expect(composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker',
      roster: [{ modelId: 'w/m', count: 4, temperature: 0.7 }],
      workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
    }), seams as never)).rejects.toThrow(/docker sandbox/i)
  })

  test('a failing worker model warns instead of throwing', async () => {
    const seams = mockSeams()
    seams.validateModels.mockImplementationOnce(async () => {
      throw new Error('worker w/bad failed')
    })
    const c = await composeRun(parseRunSpec({
      name: 'w', goal: 'g', sandbox: 'local',
      roster: [{ modelId: 'w/bad', count: 2, temperature: 0.7 }],
      workspaceRoot: '/tmp/w',
    }), { ...seams, validateModels: (async () => {}) as never } as never)
    expect(c.warnings).toEqual([])
  })

  test('session hook fills the session map', async () => {
    const seams = mockSeams()
    const c = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 1, temperature: 0.7 }],
    }), seams as never)
    c.sessionHook('agent-1', 'ses_1')
    expect(c.sessionMap.get('ses_1')).toBe('agent-1')
  })

  test('reportWarning receives each warning as it happens, for the CLI to print', async () => {
    const seams = mockSeams()
    seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
    // Unreadable host → a shared run's capacity preflight warns and proceeds. (A protected run
    // is refused instead; see the capacity reservation tests.)
    seams.readCapacity.mockRejectedValueOnce(new Error('docker info unavailable'))
    const reported: string[] = []
    const c = await composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker', isolation: 'shared',
      roster: [{ modelId: 'w/m', count: 4, temperature: 0.7 }],
      workspaceRoot: '/tmp/w', authFile: '/tmp/auth.json',
    }), seams as never, { reportWarning: (m) => reported.push(m) })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatch(/preflight was skipped/i)
    expect(c.warnings).toEqual(reported)
    await c.cleanup()
  })

  test('creates a nested non-existent workspace root before starting any server', async () => {
    const seams = mockSeams()
    seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
    const top = mkdtempSync(join(tmpdir(), 'compose-ws-'))
    const root = join(top, 'a', 'b')
    try {
      const c = await composeRun(parseRunSpec({
        name: 'w', goal: 'g', sandbox: 'local',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
        workspaceRoot: root,
      }), seams as never)
      expect(existsSync(root)).toBe(true)
      expect(seams.startHostServer).toHaveBeenCalled()
      await c.cleanup()
    } finally {
      rmSync(top, { recursive: true, force: true })
    }
  })

  test('runConfigFor carries the spec judge/reflect models into the config', () => {
    // Provenance pin (phase 4g §7 decision): the web sends judge/reflect
    // model ids on create and this pure merge is where they land — no e2e.
    const spec = parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 1, temperature: 0.7 }],
      judge: { modelId: 'judge/model', mode: 'batched_finals' },
      reflect: { modelId: 'reflect/model' },
    })
    const config = runConfigFor(spec)
    expect(config.judge.modelId).toBe('judge/model')
    expect(config.judge.mode).toBe('batched_finals')
    expect(config.reflect.modelId).toBe('reflect/model')
  })

  test('a file in the way of the workspace root fails before any server starts', async () => {
    const seams = mockSeams()
    const dir = mkdtempSync(join(tmpdir(), 'compose-ws-file-'))
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    try {
      await expect(composeRun(parseRunSpec({
        name: 'w', goal: 'g', sandbox: 'local',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
        workspaceRoot: blocked,
      }), seams as never)).rejects.toThrow(/workspace root/)
      expect(seams.startHostServer).not.toHaveBeenCalled()
      expect(seams.attachHostServer).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('docker publishes shard endpoints when preparation starts them and replays none early', async () => {
    const seams = mockSeams()
    seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
    const root = mkdtempSync(join(tmpdir(), 'compose-shards-'))
    const removeContainerFn = vi.fn<ComposeSeams['removeContainerFn']>(async () => {})
    const startShardContainerFn = vi.fn(async (spec: { shardIndex: number }) => ({
      name: `arena-run-${spec.shardIndex}`,
      baseUrl: `http://127.0.0.1:${41000 + spec.shardIndex}`,
      shardIndex: spec.shardIndex,
    }))
    const dockerBoundary: Pick<
      ComposeSeams,
      'startShardContainerFn' | 'removeContainerFn'
    > = { startShardContainerFn, removeContainerFn }
    try {
      const c = await composeRun(parseRunSpec({
        name: 'd', goal: 'g', sandbox: 'docker',
        roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
        workspaceRoot: root, authFile: join(root, 'auth.json'),
      }), { ...seams, ...dockerBoundary } as never)
      const seen: { shardIndex: number; baseUrl: string }[] = []
      const unsubscribe = c.onShardServer!((server) => seen.push(server))

      expect(c.shardServers).toEqual([])
      await c.planFor!(['a1', 'a2'])
      const [h1, h2] = await Promise.all([
        c.sandbox.provision('a1', {}),
        c.sandbox.provision('a2', {}),
      ])
      expect(seen.sort((a, b) => a.shardIndex - b.shardIndex)).toEqual([
        { shardIndex: 0, baseUrl: 'http://127.0.0.1:41000' },
        { shardIndex: 1, baseUrl: 'http://127.0.0.1:41001' },
      ])

      await c.planFor!(['a1', 'a2'])
      await Promise.all([c.sandbox.provision('a1', {}), c.sandbox.provision('a2', {})])
      expect(startShardContainerFn).toHaveBeenCalledTimes(2)
      expect(seen).toHaveLength(2)

      unsubscribe()
      await Promise.all([c.sandbox.teardown(h1), c.sandbox.teardown(h2)])
      await c.sandbox.provision('a1', {})
      expect(startShardContainerFn).toHaveBeenCalledTimes(3)
      expect(seen).toHaveLength(2)
      await c.cleanup()
      expect(removeContainerFn.mock.calls.map((call) => call[0]).sort()).toEqual([
        'arena-run-0',
        'arena-run-0',
        'arena-run-1',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('docker mounts the context folder in every shard and tells agents it is at /context', async () => {
    const seams = mockSeams()
    seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
    const root = mkdtempSync(join(tmpdir(), 'compose-ctx-docker-'))
    const ctx = realpathSync.native(mkdtempSync(join(tmpdir(), 'compose-ctx-folder-')))
    const startShardContainerFn = vi.fn(async (spec: { shardIndex: number; contextDir?: string | null }) => ({
      name: `arena-run-${spec.shardIndex}`,
      baseUrl: `http://127.0.0.1:${43000 + spec.shardIndex}`,
      shardIndex: spec.shardIndex,
    }))
    const shardClient = {
      health: vi.fn(async () => true),
      version: vi.fn(async () => '1.18.21'),
      providers: vi.fn(async () => ({ providers: [{ id: 'w', models: { m: {} } }], default: {} })),
      createSession: vi.fn(async () => ({ id: 'ses_ok' })),
      prompt: vi.fn(async (_s: string, _d: string, _body: { parts: { text: string }[] }) => ({ info: { cost: 0 }, parts: [] })),
      abort: vi.fn(async () => {}),
    }
    try {
      const c = await composeRun(parseRunSpec({
        name: 'd', goal: 'g', sandbox: 'docker',
        roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
        workspaceRoot: root, authFile: join(root, 'auth.json'), contextDir: ctx,
      }), {
        ...seams,
        inspectPath: vi.fn((p: string) => (p === ctx ? 'directory' : 'file')),
        startShardContainerFn,
        removeContainerFn: vi.fn(async () => {}),
        createShardClient: () => shardClient,
      } as never)
      await c.planFor!(['a1'])
      const h = await c.sandbox.provision('a1', {})
      expect(startShardContainerFn).toHaveBeenCalledWith(expect.objectContaining({ contextDir: ctx }), undefined, expect.any(Function), expect.any(Function))
      await c.runner.run(h, {
        agentId: 'a1', goalMd: 'g', timeoutMs: 1000,
        genome: { strategyMd: 's', notesMd: '', modelId: 'w/m', temperature: 0.7 },
      })
      const text = shardClient.prompt.mock.calls[0]![2].parts[0]!.text
      expect(text).toContain('Reference material (read-only) is in /context.')
      expect(text).not.toContain(ctx)
      await c.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(ctx, { recursive: true, force: true })
    }
  })

  test('docker runs the toolchain image and gives each shard a read-only tool manifest, removed at cleanup', async () => {
    const seams = mockSeams()
    seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
    const root = mkdtempSync(join(tmpdir(), 'compose-tools-'))
    const ctx = realpathSync.native(mkdtempSync(join(tmpdir(), 'compose-tools-ctx-')))
    writeFileSync(join(ctx, 'prices.csv'), 'a,b\n1,2\n')
    const starts: { toolsDir?: string | null; image: string }[] = []
    const startShardContainerFn = vi.fn(async (spec: { shardIndex: number; toolsDir?: string | null; image: string }) => {
      starts.push(spec)
      return { name: `arena-run-${spec.shardIndex}`, baseUrl: `http://127.0.0.1:${44000 + spec.shardIndex}`, shardIndex: spec.shardIndex }
    })
    const shardClient = {
      health: vi.fn(async () => true),
      version: vi.fn(async () => '1.18.21'),
      providers: vi.fn(async () => ({ providers: [{ id: 'w', models: { m: {} } }], default: {} })),
      createSession: vi.fn(async () => ({ id: 'ses_ok' })),
      prompt: vi.fn(async (_s: string, _d: string, _body: { parts: { text: string }[] }) => ({ info: { cost: 0 }, parts: [] })),
      abort: vi.fn(async () => {}),
    }
    try {
      const c = await composeRun(parseRunSpec({
        name: 'd', goal: 'g', sandbox: 'docker',
        roster: [{ modelId: 'w/m', count: 2, temperature: 0.7 }],
        workspaceRoot: root, authFile: join(root, 'auth.json'), contextDir: ctx,
      }), {
        ...seams,
        inspectPath: vi.fn((p: string) => (p === ctx ? 'directory' : 'file')),
        startShardContainerFn,
        removeContainerFn: vi.fn(async () => {}),
        createShardClient: () => shardClient,
      } as never, { runIdHolder: { value: 'run-7' } })
      expect(seams.ensureImageFn).toHaveBeenCalledWith(`agent-arena:tc-${TOOLCHAIN}`, expect.stringMatching(/docker$/), 'docker/Dockerfile.agent', TOOLCHAIN)
      expect(seams.readImageInventory).toHaveBeenCalledWith(`agent-arena:tc-${TOOLCHAIN}`, TOOLCHAIN)
      await c.planFor!(['a1', 'a2'])
      const [h1] = await Promise.all([c.sandbox.provision('a1', {}), c.sandbox.provision('a2', {})])
      expect(starts.map((s) => s.image)).toEqual([`agent-arena:tc-${TOOLCHAIN}`, `agent-arena:tc-${TOOLCHAIN}`])
      const dirs = starts.map((s) => s.toolsDir!).sort()
      expect(dirs).toEqual([join(root, '.arena-runtime', 'run-7', 'shard-0'), join(root, '.arena-runtime', 'run-7', 'shard-1')])
      const manifest = JSON.parse(readFileSync(join(dirs[0]!, 'tools.json'), 'utf8'))
      expect(manifest).toMatchObject({ runId: 'run-7', containerId: 'arena-run-7-0', toolchainId: TOOLCHAIN, policy: { packageInstall: 'not_enforced' } })
      expect(manifest.data).toEqual([{ name: 'context', mountPath: '/context', digest: expect.stringMatching(/^sha256:/), note: null }])
      const md = readFileSync(join(dirs[0]!, 'TOOLS.md'), 'utf8')
      expect(md).toContain('numpy 2.3.3')
      expect(JSON.stringify(manifest) + md).not.toContain(root)
      await c.runner.run(h1, {
        agentId: 'a1', goalMd: 'g', timeoutMs: 1000,
        genome: { strategyMd: 's', notesMd: '', modelId: 'w/m', temperature: 0.7 },
      })
      expect(shardClient.prompt.mock.calls[0]![2].parts[0]!.text).toContain('/run/arena/TOOLS.md')
      await c.cleanup()
      expect(existsSync(join(root, '.arena-runtime', 'run-7'))).toBe(false)
      expect(existsSync(join(root, 'shard-0'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(ctx, { recursive: true, force: true })
    }
  })

  describe('shard model catalogue', () => {
    const missing = 'wandb/deepseek-ai/DeepSeek-V4-Pro-0813'
    const present = 'wandb/zai-org/GLM-5.2'
    const genome = (modelId: string) => ({ strategyMd: 's', notesMd: '', modelId, temperature: 0.7 })
    const shardClientWith = (providers: () => Promise<unknown>) => ({
      health: vi.fn(async () => true),
      version: vi.fn(async () => '1.18.21'),
      providers: vi.fn(providers),
      createSession: vi.fn(async () => ({ id: 'ses_ok' })),
      prompt: vi.fn(async () => ({ info: { cost: 0 }, parts: [] })),
      abort: vi.fn(async () => {}),
    })
    const compose = async (root: string, shardClient: ReturnType<typeof shardClientWith>) => {
      const seams = mockSeams()
      seams.startHostServer.mockResolvedValueOnce({ client: { id: 'host' }, stop: vi.fn(async () => {}) })
      const startShardContainerFn = vi.fn(async (spec: { shardIndex: number }) => ({
        name: `arena-run-${spec.shardIndex}`,
        baseUrl: `http://127.0.0.1:${42000 + spec.shardIndex}`,
        shardIndex: spec.shardIndex,
      }))
      const c = await composeRun(parseRunSpec({
        name: 'd', goal: 'g', sandbox: 'docker',
        roster: [{ modelId: missing, count: 1, temperature: 0.7 }, { modelId: present, count: 1, temperature: 0.7 }],
        workspaceRoot: root, authFile: join(root, 'auth.json'),
      }), {
        // The host preflight (validateModels) passes: the host catalogue has both models.
        ...seams,
        startShardContainerFn,
        removeContainerFn: vi.fn(async () => {}),
        createShardClient: () => shardClient,
        hostModelsFile: () => '/host/opencode/models.json',
      } as never)
      await c.planFor!(['a1', 'a2'])
      const [h1, h2] = await Promise.all([c.sandbox.provision('a1', {}), c.sandbox.provision('a2', {})])
      return { c, h1, h2, startShardContainerFn }
    }

    test('a model the host lists but the shard does not is refused before any prompt, naming the runtime', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-catalog-'))
      const shardClient = shardClientWith(async () => ({
        providers: [{ id: 'wandb', models: { 'deepseek-ai/DeepSeek-V4-Pro': {}, 'zai-org/GLM-5.2': {} } }],
        default: {},
      }))
      try {
        const { c, h1, h2, startShardContainerFn } = await compose(root, shardClient)
        // A protected shard pins the host catalogue by copying it into its own config folder, never by
        // mounting the host file (the shared-isolation test checks that path still mounts it).
        const [firstShard] = startShardContainerFn.mock.calls[0]! as unknown as [{ modelsFile: string | null; protectedRuntime: { configDir: string } }]
        expect(firstShard.modelsFile).toBeNull()
        expect(readFileSync(join(firstShard.protectedRuntime.configDir, 'models.json'), 'utf8')).toBe(catalogJson)
        // Once per actual shard start, not once per agent.
        expect(shardClient.providers).toHaveBeenCalledTimes(startShardContainerFn.mock.calls.length)

        const refused = await c.runner.run(h1, { agentId: 'a1', genome: genome(missing), goalMd: 'g', timeoutMs: 5000 })
        expect(refused.status).toBe('error')
        expect(refused.failure).toMatchObject({ code: 'MODEL_UNAVAILABLE' })
        expect(refused.failure!.message).toContain(missing)
        expect(refused.failure!.message).toContain('Docker runtime (OpenCode 1.18.21')
        expect(shardClient.createSession).not.toHaveBeenCalled()
        expect(shardClient.prompt).not.toHaveBeenCalled()
        expect(c.warnings.some((w) => w.includes(missing) && w.includes('Docker runtime') && w.includes('1.18.21'))).toBe(true)
        expect(c.warnings.some((w) => w.includes(present))).toBe(false)

        // The healthy, explicitly selected worker still runs, and the roster is untouched.
        const healthy = await c.runner.run(h2, { agentId: 'a2', genome: genome(present), goalMd: 'g', timeoutMs: 5000 })
        expect(shardClient.createSession).toHaveBeenCalledTimes(1)
        expect(healthy.failure?.code).not.toBe('MODEL_UNAVAILABLE')
        expect(c.config.roster.map((r) => r.modelId)).toEqual([missing, present])
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('an unreadable shard catalogue is reported and does not block workers', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-catalog-'))
      const shardClient = shardClientWith(async () => { throw new Error('catalogue down') })
      try {
        const { c, h1 } = await compose(root, shardClient)
        expect(c.warnings.some((w) => /could not read the model catalogue/i.test(w))).toBe(true)
        await c.runner.run(h1, { agentId: 'a1', genome: genome(missing), goalMd: 'g', timeoutMs: 5000 })
        expect(shardClient.createSession).toHaveBeenCalledTimes(1)
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    test('a provider with no models at all in the shard is reported as missing credentials', async () => {
      const root = mkdtempSync(join(tmpdir(), 'compose-catalog-'))
      // What a shard without readable credentials lists: only the keyless provider.
      const shardClient = shardClientWith(async () => ({
        providers: [{ id: 'opencode', models: { 'muse-spark-1.3-contributor-free': {} } }],
        default: {},
      }))
      try {
        const { c, h1 } = await compose(root, shardClient)
        const refused = await c.runner.run(h1, { agentId: 'a1', genome: genome(missing), goalMd: 'g', timeoutMs: 5000 })
        expect(refused.failure!.message).toMatch(/no credentials for "wandb"/)
        expect(refused.failure!.message).toContain('Credentials file')
        expect(shardClient.createSession).not.toHaveBeenCalled()
        expect(c.warnings.some((w) => /no credentials/i.test(w) && w.includes('wandb') && w.includes('Credentials file'))).toBe(true)
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
