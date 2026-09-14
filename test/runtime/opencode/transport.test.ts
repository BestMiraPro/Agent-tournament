import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { describeFailure } from '../../../src/core/failure.js'
import { MockSandbox } from '../../../src/runtime/mock-sandbox.js'
import { OpenCodeAgentRunner } from '../../../src/runtime/opencode/agent-runner.js'
import {
  OpenCodeClient,
  OpenCodeHttpError,
  transportAllowanceMs,
} from '../../../src/runtime/opencode/client.js'

/**
 * Real sockets, short delays. The September 13 Muse Spark prompts failed at ~307s with
 * `TypeError: fetch failed` against a 600s agent deadline: Node's built-in fetch has its own
 * 300s headers deadline, and an OpenCode prompt sends no headers until the agent finishes.
 * These tests pin a transport whose only deadline is the application's.
 */

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections()
    s.close(() => resolve())
  })))
})

interface Seen { method: string; url: string; body: string }

async function serve(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = []
  const closed: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      const seen = { method: req.method ?? '', url: req.url ?? '', body }
      requests.push(seen)
      res.on('close', () => closed.push(seen.url))
      handler(req, res, seen)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, requests, closed }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const promptBody = { model: { providerID: 'p', modelID: 'm' }, parts: [{ type: 'text' as const, text: 'hi' }] }

describe('OpenCode transport lifetime', () => {
  test('the transport allows longer than any application deadline, including the 300s fetch default', () => {
    for (const deadline of [3_000, 300_000, 600_000, 3_600_000]) {
      expect(transportAllowanceMs(deadline)).toBeGreaterThan(deadline)
    }
    expect(transportAllowanceMs(600_000)).toBeGreaterThan(300_000)
  })

  test('headers that arrive late but before the application deadline succeed, with one request', async () => {
    const srv = await serve(async (_req, res) => {
      await sleep(400)
      json(res, 200, { info: { cost: 0.25 }, parts: [{ type: 'text', text: 'done' }] })
    })
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 5_000 })
    const res = await c.prompt('ses_1', '/work/a1', promptBody, 5_000)
    expect(res.info.cost).toBe(0.25)
    expect(srv.requests.filter((r) => r.url.startsWith('/session/ses_1/message'))).toHaveLength(1)
  })

  test('a body that trickles in after early headers still completes', async () => {
    const srv = await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"info":{"cost":')
      await sleep(300)
      res.end('1},"parts":[]}')
    })
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 5_000 })
    expect((await c.prompt('ses_1', '/w', promptBody)).info.cost).toBe(1)
  })

  test('a server that never answers hits the application deadline once and the socket is released', async () => {
    const srv = await serve(() => { /* hold the prompt open, like a still-working agent */ })
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 5_000 })
    const started = Date.now()
    const error = await c.prompt('ses_1', '/w', promptBody, 200).then(() => null, (e: unknown) => e)
    expect(error).toMatchObject({ name: 'OpenCodeTimeoutError' })
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(srv.requests).toHaveLength(1)
    await expect.poll(() => srv.closed.length).toBe(1)
  })

  test('a connection reset after dispatch is a transport failure with its code, not a timeout', async () => {
    const srv = await serve((req) => { req.socket.destroy() })
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 5_000 })
    const error = await c.prompt('ses_1', '/w', promptBody).then(() => null, (e: unknown) => e)
    expect(error).toMatchObject({ name: 'OpenCodeTransportError' })
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('ECONNRESET')
    expect(describeFailure(error)).toMatchObject({ code: 'ECONNRESET' })
    expect(describeFailure(error).message).toMatch(/^Transport failure: .*\(ECONNRESET\)$/)
    expect(srv.requests).toHaveLength(1)
  })

  test('an OpenCode JSON error keeps its structure over the real transport', async () => {
    const srv = await serve((_req, res) => json(res, 500, '{"name":"UnknownError","data":{"ref":"err_0672e772"}}'))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 5_000 })
    const error = await c.prompt('ses_1', '/w', promptBody).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpenCodeHttpError)
    expect(error).toMatchObject({ httpStatus: 500, errorName: 'UnknownError', ref: 'err_0672e772' })
  })

  test('a caller signal is not needed: every request, short or long, is bounded by its own deadline', async () => {
    const srv = await serve(() => {})
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 150 })
    await expect(c.createSession('/w', 't')).rejects.toMatchObject({ name: 'OpenCodeTimeoutError' })
    expect(await c.health()).toBe(false)
  })
})

describe('agent runner over the real transport', () => {
  test('an agent deadline sends one prompt and one abort, and never replays the prompt', async () => {
    const srv = await serve((req, res, seen) => {
      if (seen.url.startsWith('/session?')) return json(res, 200, { id: 'ses_live' })
      if (seen.url.startsWith('/session/ses_live/abort')) return json(res, 200, true)
      // The prompt: held open past the agent deadline.
      void req
    })
    const sandbox = new MockSandbox()
    const handle = await sandbox.provision('a1', {})
    const runner = new OpenCodeAgentRunner(new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 5_000 }), sandbox)
    const result = await runner.run(handle, {
      agentId: 'a1',
      genome: { strategyMd: 's', notesMd: '', modelId: 'p/m', temperature: 0.7 },
      goalMd: 'g',
      timeoutMs: 250,
    })
    expect(result.status).toBe('timeout')
    expect(result.usageKnown).toBe(false)
    await expect.poll(() => srv.requests.filter((r) => r.url.startsWith('/session/ses_live/abort')).length).toBe(1)
    expect(srv.requests.filter((r) => r.url.startsWith('/session/ses_live/message'))).toHaveLength(1)
    // A local deadline is not proof the remote agent stopped.
    expect(await runner.quiesce(handle)).not.toBe('stopped')
  }, 20_000)
})
