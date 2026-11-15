import Fastify from 'fastify'
import { describe, expect, test } from 'vitest'
import { allowedHostsFor, isLocalRequest, registerLocalOriginGuard } from '../../src/server/local-origin.js'

describe('local origin guard', () => {
  const loopback = allowedHostsFor(null)

  test('loopback hosts pass on any port, with or without a same-machine Origin', () => {
    for (const host of ['127.0.0.1:4300', 'localhost:4301', '[::1]:4300', 'LOCALHOST']) {
      expect(isLocalRequest({ host }, loopback)).toBe(true)
    }
    expect(isLocalRequest({ host: '127.0.0.1:4300', origin: 'http://localhost:4301' }, loopback)).toBe(true)
  })

  test('a DNS-rebinding Host, a cross-site Origin, an opaque Origin or no Host is refused', () => {
    expect(isLocalRequest({ host: 'evil.example:4300' }, loopback)).toBe(false)
    expect(isLocalRequest({ host: '127.0.0.1:4300', origin: 'https://evil.example' }, loopback)).toBe(false)
    expect(isLocalRequest({ host: '127.0.0.1:4300', origin: 'null' }, loopback)).toBe(false)
    expect(isLocalRequest({}, loopback)).toBe(false)
  })

  test('a specific bind host is allowed besides loopback; other names are not', () => {
    const allowed = allowedHostsFor('192.168.1.20')
    expect(isLocalRequest({ host: '192.168.1.20:4300' }, allowed)).toBe(true)
    expect(isLocalRequest({ host: '192.168.1.21:4300' }, allowed)).toBe(false)
  })

  test('the hook answers 403 before any route runs', async () => {
    const app = Fastify()
    let reached = 0
    registerLocalOriginGuard(app, loopback)
    app.post('/api/runs', async () => { reached++; return { ok: true } })
    const evil = await app.inject({ method: 'POST', url: '/api/runs', headers: { host: 'rebind.evil.example' }, payload: {} })
    const cross = await app.inject({ method: 'POST', url: '/api/runs', headers: { host: '127.0.0.1:4300', origin: 'https://evil.example' }, payload: {} })
    const ok = await app.inject({ method: 'POST', url: '/api/runs', headers: { host: '127.0.0.1:4300' }, payload: {} })
    expect([evil.statusCode, cross.statusCode, ok.statusCode]).toEqual([403, 403, 200])
    expect(reached).toBe(1)
    await app.close()
  })
})
