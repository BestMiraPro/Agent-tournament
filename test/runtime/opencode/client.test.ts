import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, test, afterEach } from 'vitest'
import {
  OpenCodeClient,
  OpenCodeHttpError,
  extractReasoning,
  extractStructured,
  extractText,
  type HttpTransport,
} from '../../../src/runtime/opencode/client.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.closeAllConnections()
    s.close(() => resolve())
  })))
})

/** A loopback server answering every request with `respond`; records each request's url and body. */
async function serve(respond: (res: ServerResponse, url: string, body: string) => void) {
  const seen: { url: string; body: string }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body })
      respond(res, req.url ?? '', body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const ok = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const status = (res: ServerResponse, code: number, text: string) => {
  res.writeHead(code)
  res.end(text)
}

describe('OpenCodeClient', () => {
  test('createSession passes the directory as a query parameter', async () => {
    const srv = await serve((res) => ok(res, { id: 'ses_1' }))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    const s = await c.createSession('/work/agent-01', 'title')
    expect(s.id).toBe('ses_1')
    expect(srv.seen[0]!.url).toContain('directory=%2Fwork%2Fagent-01')
  })

  test('version reads the runtime version from the health endpoint', async () => {
    const srv = await serve((res) => ok(res, { healthy: true, version: '1.18.21' }))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    expect(await c.version()).toBe('1.18.21')
    expect(srv.seen[0]!.url).toContain('/global/health')
  })

  test('version is null when the server reports no usable version', async () => {
    let reply: (res: ServerResponse) => void = (res) => ok(res, { healthy: true })
    const srv = await serve((res) => reply(res))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    expect(await c.version()).toBeNull()
    reply = (res) => ok(res, { healthy: true, version: `1.0 ${'x'.repeat(80)}` })
    expect(await c.version()).toBeNull()
    reply = (res) => status(res, 503, 'down')
    expect(await c.version()).toBeNull()
  })

  test('throws a descriptive error on a non-2xx response', async () => {
    const srv = await serve((res) => status(res, 500, 'nope'))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    await expect(c.createSession('/w', 't')).rejects.toThrow(/500/)
  })

  test('aborts a request that exceeds the timeout', async () => {
    const srv = await serve(() => { /* never answers */ })
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 30 })
    await expect(c.createSession('/w', 't')).rejects.toMatchObject({ name: 'OpenCodeTimeoutError' })
  })

  test('normalizes its own deadline but preserves an unrelated AbortError', async () => {
    const hanging: HttpTransport = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
    const c = new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 5, transport: hanging })
    await expect(c.createSession('/w', 't')).rejects.toMatchObject({ name: 'OpenCodeTimeoutError' })
    const unrelated = new DOMException('other cancellation', 'AbortError')
    const throwing: HttpTransport = async () => { throw unrelated }
    const d = new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 1000, transport: throwing })
    await expect(d.createSession('/w', 't')).rejects.toBe(unrelated)
  })

  test('a 500 with an OpenCode error body keeps its status, name and ref structured', async () => {
    // The exact body stored for run 6eb22c7c: the ref is what maps a generic 500 to the
    // ProviderModelNotFoundError in the shard's own log, so it must survive as data.
    const body = '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_0672e772"}}'
    const srv = await serve((res) => status(res, 500, body))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    const error = await c.prompt('ses_1', '/w', { model: { providerID: 'p', modelID: 'm' }, parts: [] })
      .then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpenCodeHttpError)
    expect(error).toMatchObject({ httpStatus: 500, errorName: 'UnknownError', ref: 'err_0672e772' })
    expect(String(error)).toMatch(/500/)
  })

  test('a non-JSON error body still reports the status, with no name or ref', async () => {
    const srv = await serve((res) => status(res, 503, 'nope'))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    const error = await c.createSession('/w', 't').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpenCodeHttpError)
    expect(error).toMatchObject({ httpStatus: 503 })
    expect((error as OpenCodeHttpError).errorName).toBeUndefined()
    expect((error as OpenCodeHttpError).ref).toBeUndefined()
  })

  test('a transport failure reaches the caller with its cause intact', async () => {
    const failure = new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
    const transport: HttpTransport = async () => { throw failure }
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000, transport })
    const error = await c.createSession('/w', 't').then(() => null, (e: unknown) => e)
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT')
  })

  test('prompt sends model, system and parts', async () => {
    const srv = await serve((res) => ok(res, { info: {}, parts: [] }))
    const c = new OpenCodeClient({ baseUrl: srv.baseUrl, timeoutMs: 1000 })
    await c.prompt('ses_1', '/w', {
      model: { providerID: 'p', modelID: 'm' },
      system: 'STRATEGY',
      parts: [{ type: 'text', text: 'hello' }],
    })
    const body = JSON.parse(srv.seen[0]!.body)
    expect(body.model).toEqual({ providerID: 'p', modelID: 'm' })
    expect(body.system).toBe('STRATEGY')
    expect(body.parts[0].text).toBe('hello')
  })
})

describe('extractStructured', () => {
  const withPart = (part: unknown) => ({ info: {}, parts: [part] }) as any

  test('reads the validated object from a StructuredOutput tool part', () => {
    const res = withPart({
      type: 'tool', tool: 'StructuredOutput',
      state: { status: 'completed', input: { a: 1 }, metadata: { valid: true } },
    })
    expect(extractStructured(res)).toEqual({ a: 1 })
  })

  test('returns null when there is no StructuredOutput part', () => {
    expect(extractStructured(withPart({ type: 'text', text: 'hi' }))).toBeNull()
  })

  test('returns null when the server marked the output invalid', () => {
    const res = withPart({
      type: 'tool', tool: 'StructuredOutput',
      state: { status: 'completed', input: { a: 1 }, metadata: { valid: false } },
    })
    expect(extractStructured(res)).toBeNull()
  })

  test('ignores other tool parts', () => {
    const res = withPart({ type: 'tool', tool: 'Bash', state: { input: { cmd: 'ls' } } })
    expect(extractStructured(res)).toBeNull()
  })
})

describe('extractText', () => {
  test('concatenates text parts in order', () => {
    const res = { info: {}, parts: [
      { type: 'text', text: 'a' },
      { type: 'step-start' },
      { type: 'text', text: 'b' },
    ] } as any
    expect(extractText(res)).toBe('ab')
  })

  test('leaves reasoning parts out', () => {
    const res = { info: {}, parts: [
      { type: 'reasoning', text: 'private thought' },
      { type: 'text', text: 'hi' },
    ] } as any
    expect(extractText(res)).toBe('hi')
  })
})

describe('extractReasoning', () => {
  test('concatenates reasoning parts in order, ignoring everything else', () => {
    const res = { info: {}, parts: [
      { type: 'reasoning', text: 'first thought ' },
      { type: 'text', text: 'hi' },
      { type: 'tool', tool: 'Bash', state: {} },
      { type: 'reasoning', text: 'second thought' },
    ] } as any
    expect(extractReasoning(res)).toBe('first thought second thought')
  })

  test('returns null when no reasoning part carries text', () => {
    expect(extractReasoning({ info: {}, parts: [{ type: 'text', text: 'hi' }] } as any)).toBeNull()
    expect(extractReasoning({ info: {}, parts: [] } as any)).toBeNull()
    expect(extractReasoning({ info: {} } as any)).toBeNull()
  })
})
