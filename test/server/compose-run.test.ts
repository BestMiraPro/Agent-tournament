import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { composeRun, runConfigFor, type ComposeSeams } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const mockSeams = () => ({
  startHostServer: vi.fn(async () => ({ client: { id: 'host' }, stop: vi.fn() })),
  attachHostServer: vi.fn(),
  ensureImageFn: vi.fn(async () => {}),
  readCapacity: vi.fn(async () => ({ totalMemoryBytes: 16 * 1024 ** 3, usedMemoryBytes: 1 * 1024 ** 3, cpus: 8 })),
  sweepFn: vi.fn(async () => [] as string[]),
  validateModels: vi.fn(async () => {}),
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
})
