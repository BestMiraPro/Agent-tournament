import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { composeRun, pathKind, runConfigFor, type ComposeSeams } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const mockSeams = () => ({
  startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
  attachHostServer: vi.fn(),
  ensureImageFn: vi.fn(async () => {}),
  readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
  sweepFn: vi.fn(async () => [] as string[]),
  validateModels: vi.fn(async () => {}),
  inspectPath: vi.fn((): 'file' | 'directory' | 'missing' => 'file'),
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
          .rejects.toThrow(/C:\\Users\\me\\Crypto-research is a folder, not a credentials file.*Leave "Auth file" blank/)
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
    // Unreadable host → the capacity preflight warns and proceeds.
    seams.readCapacity.mockRejectedValueOnce(new Error('docker info unavailable'))
    const reported: string[] = []
    const c = await composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker',
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
    const ctx = mkdtempSync(join(tmpdir(), 'compose-ctx-folder-'))
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
        expect(startShardContainerFn.mock.calls[0]![0]).toMatchObject({ modelsFile: '/host/opencode/models.json' })
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
        expect(refused.failure!.message).toContain('Auth file')
        expect(shardClient.createSession).not.toHaveBeenCalled()
        expect(c.warnings.some((w) => /no credentials/i.test(w) && w.includes('wandb') && w.includes('Auth file'))).toBe(true)
        await c.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
