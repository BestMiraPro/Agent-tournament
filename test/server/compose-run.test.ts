import { describe, expect, test, vi } from 'vitest'
import { composeRun } from '../../src/server/compose-run.js'
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
})
