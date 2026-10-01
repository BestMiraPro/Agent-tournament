import { afterEach, describe, expect, test } from 'vitest'
import { closeProcessRelay, processRelay } from '../../src/runtime/relay-process.js'

afterEach(async () => {
  await closeProcessRelay()
})

describe('processRelay', () => {
  test('one relay per process, on loopback, shared by every run until closed', async () => {
    const a = await processRelay()
    const b = await processRelay()
    expect(b.policy).toBe(a.policy)
    expect(b.port).toBe(a.port)
    expect(a.port).toBeGreaterThan(0)
    const res = await fetch(`http://127.0.0.1:${a.port}/wandb/chat/completions`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    await closeProcessRelay()
    const c = await processRelay()
    expect(c.policy).not.toBe(a.policy)
  })

  test('listens on the address it is first started with, and refuses to be asked for another', async () => {
    const a = await processRelay({ host: '127.0.0.1' })
    expect(a.host).toBe('127.0.0.1')
    await expect(processRelay({ host: '0.0.0.0' })).rejects.toThrow(/already listens on 127\.0\.0\.1, not 0\.0\.0\.0/)
    expect((await processRelay()).port).toBe(a.port)
  })
})
