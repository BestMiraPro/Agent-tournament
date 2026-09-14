import { describe, expect, test, vi, afterEach } from 'vitest'
import { OpenCodeClient, OpenCodeHttpError, extractStructured, extractText } from '../../../src/runtime/opencode/client.js'

afterEach(() => vi.unstubAllGlobals())

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) =>
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch))

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('OpenCodeClient', () => {
  test('createSession passes the directory as a query parameter', async () => {
    let seen = ''
    stubFetch(async (url) => { seen = url; return ok({ id: 'ses_1' }) })
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000 })
    const s = await c.createSession('/work/agent-01', 'title')
    expect(s.id).toBe('ses_1')
    expect(seen).toContain('directory=%2Fwork%2Fagent-01')
  })

  test('throws a descriptive error on a non-2xx response', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }))
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000 })
    await expect(c.createSession('/w', 't')).rejects.toThrow(/500/)
  })

  test('aborts a request that exceeds the timeout', async () => {
    stubFetch((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    )
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 30 })
    await expect(c.createSession('/w', 't')).rejects.toThrow()
  })

  test('normalizes its own deadline but preserves an unrelated AbortError', async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const c = new OpenCodeClient({ baseUrl: 'http://fake.invalid', timeoutMs: 5 })
    await expect(c.createSession('/w', 't')).rejects.toMatchObject({ name: 'OpenCodeTimeoutError' })
    const unrelated = new DOMException('other cancellation', 'AbortError')
    stubFetch(async () => { throw unrelated })
    await expect(c.createSession('/w', 't')).rejects.toBe(unrelated)
  })

  test('a 500 with an OpenCode error body keeps its status, name and ref structured', async () => {
    // The exact body stored for run 6eb22c7c: the ref is what maps a generic 500 to the
    // ProviderModelNotFoundError in the shard's own log, so it must survive as data.
    const body = '{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_0672e772"}}'
    stubFetch(async () => new Response(body, { status: 500 }))
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000 })
    const error = await c.prompt('ses_1', '/w', { model: { providerID: 'p', modelID: 'm' }, parts: [] })
      .then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpenCodeHttpError)
    expect(error).toMatchObject({ httpStatus: 500, errorName: 'UnknownError', ref: 'err_0672e772' })
    expect(String(error)).toMatch(/500/)
  })

  test('a non-JSON error body still reports the status, with no name or ref', async () => {
    stubFetch(async () => new Response('nope', { status: 503 }))
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000 })
    const error = await c.createSession('/w', 't').then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpenCodeHttpError)
    expect(error).toMatchObject({ httpStatus: 503 })
    expect((error as OpenCodeHttpError).errorName).toBeUndefined()
    expect((error as OpenCodeHttpError).ref).toBeUndefined()
  })

  test('a transport failure reaches the caller with its cause intact', async () => {
    const transport = new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
    stubFetch(async () => { throw transport })
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000 })
    const error = await c.createSession('/w', 't').then(() => null, (e: unknown) => e)
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT')
  })

  test('prompt sends model, system and parts', async () => {
    let body: any = null
    stubFetch(async (_url, init) => { body = JSON.parse(String(init.body)); return ok({ info: {}, parts: [] }) })
    const c = new OpenCodeClient({ baseUrl: 'http://x:1', timeoutMs: 1000 })
    await c.prompt('ses_1', '/w', {
      model: { providerID: 'p', modelID: 'm' },
      system: 'STRATEGY',
      parts: [{ type: 'text', text: 'hello' }],
    })
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
})
