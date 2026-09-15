import { request } from 'node:http'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RelayPolicy } from '../../src/runtime/provider-relay.js'
import { startProviderRelay, type RelayRecord, type UpstreamCall } from '../../src/runtime/provider-relay-server.js'

const upstreams = [{ providerId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', authStyle: 'bearer' as const, apiKey: 'REAL-KEY' }]
const policyWith = (limits = { maxRequestBytes: 1024, maxResponseBytes: 4096 }) => {
  const p = new RelayPolicy(upstreams, limits)
  p.grant('run-1', { token: 'tok-1', allowedModels: ['wandb/zai-org/GLM-5.2'], maxRequests: 10 })
  return p
}
const body = JSON.stringify({ model: 'zai-org/GLM-5.2', stream: true, messages: [] })
const headers = { authorization: 'Bearer tok-1', 'content-type': 'application/json' }

const post = (port: number, path: string, h: Record<string, string>, payload: string | Buffer) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string; aborted: boolean }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: h }, (res) => {
      const chunks: Buffer[] = []
      let aborted = false
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString(), aborted })
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('aborted', () => { aborted = true })
      res.on('error', () => { aborted = true; done() })
      res.on('close', done)
    })
    req.on('error', reject)
    req.end(payload)
  })

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part)
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const start = async (upstream: UpstreamCall, policy = policyWith()) => {
  const records: RelayRecord[] = []
  const relay = await startProviderRelay({ policy, upstream, onRequest: (r) => records.push(r) })
  closers.push(relay.close)
  return { relay, records }
}

describe('provider relay server', () => {
  test('listens on loopback only unless told otherwise', async () => {
    const { relay } = await start(vi.fn())
    expect(relay.host).toBe('127.0.0.1')
    expect(relay.port).toBeGreaterThan(0)
  })

  test('relays an allowed call with the real key, streams the reply back, and records it', async () => {
    const upstream = vi.fn<UpstreamCall>(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'set-cookie': 'tracking=1' },
      body: chunks('data: {"a":1}\n\n', 'data: [DONE]\n\n'),
    }))
    const { relay, records } = await start(upstream)
    const res = await post(relay.port, '/wandb/chat/completions', headers, body)
    expect(res.status).toBe(200)
    expect(res.body).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(upstream).toHaveBeenCalledWith('https://api.inference.wandb.ai/v1/chat/completions', expect.objectContaining({
      headers: { authorization: 'Bearer REAL-KEY', 'content-type': 'application/json' },
      body: Buffer.from(body),
    }))
    expect(records).toEqual([{
      runId: 'run-1', modelId: 'wandb/zai-org/GLM-5.2', status: 200, outcome: 'relayed',
      requestBytes: Buffer.byteLength(body), responseBytes: Buffer.byteLength('data: {"a":1}\n\ndata: [DONE]\n\n'), error: null,
    }])
  })

  test('a refused request never reaches upstream and says why', async () => {
    const upstream = vi.fn<UpstreamCall>()
    const { relay, records } = await start(upstream)
    const res = await post(relay.port, '/wandb/chat/completions', { ...headers, authorization: 'Bearer wrong' }, body)
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body)).toEqual({ error: 'missing or unknown relay token' })
    expect(upstream).not.toHaveBeenCalled()
    expect(records[0]).toMatchObject({ runId: null, status: 401, outcome: 'refused' })
  })

  test('an oversized body is refused while it is read, not after buffering it all', async () => {
    const upstream = vi.fn<UpstreamCall>()
    const { relay, records } = await start(upstream)
    const res = await post(relay.port, '/wandb/chat/completions', headers, Buffer.alloc(8192, 32))
    expect(res.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
    expect(records[0]).toMatchObject({ status: 413, outcome: 'refused' })
  })

  test('never follows an upstream redirect', async () => {
    const upstream = vi.fn<UpstreamCall>(async () => ({ status: 302, headers: { location: 'https://evil.example/' }, body: chunks() }))
    const { relay, records } = await start(upstream)
    const res = await post(relay.port, '/wandb/chat/completions', headers, body)
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body)).toEqual({ error: 'upstream redirect refused' })
    expect(res.headers.location).toBeUndefined()
    expect(records[0]).toMatchObject({ status: 502, outcome: 'upstream_error', error: 'upstream redirect refused' })
  })

  test('stops a reply that exceeds the response cap and records the truncation', async () => {
    const upstream = vi.fn<UpstreamCall>(async () => ({
      status: 200, headers: { 'content-type': 'text/event-stream' },
      body: chunks('x'.repeat(3000), 'y'.repeat(3000), 'z'.repeat(3000)),
    }))
    const { relay, records } = await start(upstream)
    const res = await post(relay.port, '/wandb/chat/completions', headers, body)
    expect(res.body.length).toBeLessThanOrEqual(4096)
    expect(res.body).not.toContain('z')
    await vi.waitFor(() => expect(records[0]).toMatchObject({ outcome: 'truncated', error: 'response exceeded 4096 bytes' }))
  })

  test('an unreachable upstream is a 502 whose message carries no request detail', async () => {
    const upstream = vi.fn<UpstreamCall>(async () => { throw new Error('getaddrinfo ENOTFOUND api.inference.wandb.ai Bearer REAL-KEY') })
    const { relay, records } = await start(upstream)
    const res = await post(relay.port, '/wandb/chat/completions', headers, body)
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body)).toEqual({ error: 'upstream unreachable' })
    expect(JSON.stringify(records)).not.toContain('REAL-KEY')
  })
})
