import { describe, expect, test } from 'vitest'
import { composeRun } from '../../src/server/compose-run.js'
import { parseRunSpec } from '../../src/server/run-spec.js'

const seams = {
  startHostServer: (async () => ({ client: { id: 'h' }, stop: async () => {} })) as never,
  attachHostServer: (async () => { throw new Error('no server here') }) as never,
  ensureImageFn: (async () => {}) as never,
  readCapacity: (async () => ({ totalMemoryBytes: 32 * 1024 ** 3, usedMemoryBytes: 0, cpus: 8 })) as never,
  sweepFn: (async () => []) as never,
  validateModels: (async () => {}) as never,
}

describe('run matrix', () => {
  test('mock composes without touching any seam', async () => {
    let touched = false
    const c = await composeRun(parseRunSpec({
      name: 'm', goal: 'g', sandbox: 'mock',
      roster: [{ modelId: 'mock/model', count: 2, temperature: 0.7 }],
    }), { ...seams, startHostServer: (async () => { touched = true; throw new Error('x') }) as never })
    expect(touched).toBe(false)
    expect(c.serverHandle).toBeNull()
  })

  test('local composes against the fake host server', async () => {
    const c = await composeRun(parseRunSpec({
      name: 'l', goal: 'g', sandbox: 'local', workspaceRoot: '/tmp/w',
      roster: [{ modelId: 'w/m', count: 1, temperature: 0.7 }],
    }), seams)
    expect(c.serverHandle).toBeTruthy()
    expect(c.planFor).toBeNull()
    await c.cleanup()
  })

  test('docker refusal names the shortage', async () => {
    await expect(composeRun(parseRunSpec({
      name: 'd', goal: 'g', sandbox: 'docker', workspaceRoot: '/tmp/w', authFile: '/tmp/a',
      roster: [{ modelId: 'w/m', count: 32, temperature: 0.7 }],
    }), { ...seams, readCapacity: (async () => ({ totalMemoryBytes: 512 * 1024 ** 2, usedMemoryBytes: 0, cpus: 1 })) as never })
    ).rejects.toThrow(/docker sandbox/i)
  })
})