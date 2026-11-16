import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'
import { fetchPage, nodeRequester, type PinnedRequester } from '../../../src/connectors/web/fetch-page.js'
import type { LookupFn } from '../../../src/connectors/web/ssrf.js'

interface Route {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
  /** Never answers: the request waits until it is aborted. */
  hang?: 'headers' | 'body'
}

const PUBLIC = '93.184.216.34'

function fakeNet(routes: Record<string, Route>, dns: Record<string, string[] | (() => string[])> = {}) {
  const calls: { url: string; address: string }[] = []
  const lookups: string[] = []
  const lookup: LookupFn = async (host) => {
    lookups.push(host)
    const entry = dns[host] ?? [PUBLIC]
    const answers = typeof entry === 'function' ? entry() : entry
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 as const : 4 as const }))
  }
  const request: PinnedRequester = async ({ url, address, signal }) => {
    calls.push({ url: url.href, address })
    const route = routes[url.href]
    if (!route) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    if (route.hang === 'headers') {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    const body = route.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body)
    return {
      status: route.status ?? 200,
      headers: route.headers ?? { 'content-type': 'text/html; charset=utf-8' },
      body: (async function* () {
        for (let i = 0; i < body.length; i += 64 * 1024) yield body.subarray(i, i + 64 * 1024)
        if (route.hang === 'body') await new Promise(() => {})
      })(),
    }
  }
  return { lookup, request, calls, lookups }
}

describe('fetchPage', () => {
  test('converts HTML and connects to the checked address', async () => {
    const net = fakeNet({ 'https://example.com/a': { body: '<title>T</title><h1>Hello</h1><p>World</p>' } })
    const page = await fetchPage('https://example.com/a', net)
    expect(page).toMatchObject({ url: 'https://example.com/a', status: 200, contentType: 'text/html', title: 'T', text: '# Hello\n\nWorld', redirects: 0, truncated: false })
    expect(net.calls).toEqual([{ url: 'https://example.com/a', address: PUBLIC }])
  })

  test('follows relative redirects and reports the final URL', async () => {
    const net = fakeNet({
      'https://example.com/a': { status: 301, headers: { location: '/b' } },
      'https://example.com/b': { status: 302, headers: { location: 'https://docs.example.org/c' } },
      'https://docs.example.org/c': { headers: { 'content-type': 'text/plain' }, body: 'done' },
    })
    const page = await fetchPage('https://example.com/a', net)
    expect(page).toMatchObject({ url: 'https://docs.example.org/c', text: 'done', redirects: 2 })
  })

  test('a redirect to a private address is refused before connecting to it', async () => {
    const net = fakeNet({ 'https://example.com/a': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } })
    await expect(fetchPage('https://example.com/a', net)).rejects.toMatchObject({ code: 'blocked_address' })
    expect(net.calls.map((c) => c.url)).toEqual(['https://example.com/a'])
  })

  test('a redirect to a name that resolves privately is refused too', async () => {
    const net = fakeNet(
      { 'https://example.com/a': { status: 307, headers: { location: 'http://intranet.example/' } } },
      { 'intranet.example': ['10.1.2.3'] },
    )
    await expect(fetchPage('https://example.com/a', net)).rejects.toMatchObject({ code: 'blocked_address' })
    expect(net.calls).toHaveLength(1)
  })

  test('DNS rebinding: one resolution per hop, the connection pinned to it, every hop re-checked', async () => {
    let answer = 0
    const net = fakeNet(
      { 'http://rebind.example/1': { status: 302, headers: { location: '/2' } }, 'http://rebind.example/2': { body: 'secret' } },
      { 'rebind.example': () => (answer++ === 0 ? [PUBLIC] : ['127.0.0.1']) },
    )
    await expect(fetchPage('http://rebind.example/1', net)).rejects.toMatchObject({ code: 'blocked_address' })
    expect(net.calls).toEqual([{ url: 'http://rebind.example/1', address: PUBLIC }])
    expect(net.lookups).toEqual(['rebind.example', 'rebind.example'])
  })

  test('redirects are capped', async () => {
    const routes: Record<string, Route> = {}
    for (let i = 0; i < 7; i++) routes[`https://example.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } }
    await expect(fetchPage('https://example.com/0', fakeNet(routes))).rejects.toMatchObject({ code: 'too_many_redirects' })
  })

  test('the body is cut at the byte cap, decompressed bytes included', async () => {
    const big = 'a'.repeat(3 * 1024 * 1024)
    const plain = await fetchPage('https://example.com/big', fakeNet({ 'https://example.com/big': { headers: { 'content-type': 'text/plain' }, body: big } }), { maxBytes: 1024 * 1024 })
    expect(plain).toMatchObject({ bytes: 1024 * 1024, truncated: true })
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x61))
    const zipped = await fetchPage(
      'https://example.com/bomb',
      fakeNet({ 'https://example.com/bomb': { headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, body: bomb } }),
      { maxBytes: 1024 * 1024 },
    )
    expect(zipped).toMatchObject({ bytes: 1024 * 1024, truncated: true })
  })

  test('the whole call has a deadline, waiting for headers or for the body', async () => {
    for (const hang of ['headers', 'body'] as const) {
      const net = fakeNet({ 'https://example.com/slow': { hang, body: 'partial' } })
      const started = Date.now()
      await expect(fetchPage('https://example.com/slow', net, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' })
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })

  test('binary content is refused; text, JSON and XML pass through', async () => {
    for (const type of ['application/pdf', 'image/png', 'application/octet-stream', 'application/zip']) {
      const net = fakeNet({ 'https://example.com/f': { headers: { 'content-type': type }, body: '%PDF-1.7' } })
      await expect(fetchPage('https://example.com/f', net), type).rejects.toMatchObject({ code: 'unsupported_content_type' })
    }
    const json = '{"a": [1, 2]}'
    for (const type of ['application/json', 'application/vnd.api+json', 'text/markdown', 'application/atom+xml']) {
      const net = fakeNet({ 'https://example.com/f': { headers: { 'content-type': type }, body: json } })
      expect((await fetchPage('https://example.com/f', net)).text, type).toBe(json)
    }
  })

  test('without a content type, NUL bytes mean binary and an html tag means HTML', async () => {
    const binary = fakeNet({ 'https://example.com/f': { headers: {}, body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]) } })
    await expect(fetchPage('https://example.com/f', binary)).rejects.toMatchObject({ code: 'unsupported_content_type' })
    const html = fakeNet({ 'https://example.com/f': { headers: {}, body: '<!DOCTYPE html><p>hi</p>' } })
    expect(await fetchPage('https://example.com/f', html)).toMatchObject({ contentType: 'text/html', text: 'hi' })
  })

  test('decodes the declared charset, from the header or a meta tag', async () => {
    const quoted = Buffer.from([0x93, 0x71, 0x94]) // “q” in windows-1252
    const header = fakeNet({ 'https://example.com/f': { headers: { 'content-type': 'text/plain; charset=windows-1252' }, body: quoted } })
    expect((await fetchPage('https://example.com/f', header)).text).toBe('“q”')
    const meta = fakeNet({ 'https://example.com/f': { headers: { 'content-type': 'text/html' }, body: Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>'), quoted]) } })
    expect((await fetchPage('https://example.com/f', meta)).text).toBe('“q”')
  })

  test('returned text is capped and says so', async () => {
    const net = fakeNet({ 'https://example.com/f': { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(10_000) } })
    const page = await fetchPage('https://example.com/f', net, { maxChars: 1000 })
    expect(page.truncated).toBe(true)
    expect(page.text.startsWith('x'.repeat(1000))).toBe(true)
    expect(page.text).toContain('[truncated: 9000 more characters]')
  })

  test('refuses bad URLs and failed connections with fixed codes', async () => {
    await expect(fetchPage('ftp://example.com/', fakeNet({}))).rejects.toMatchObject({ code: 'invalid_url' })
    await expect(fetchPage('https://example.com/nothing', fakeNet({}))).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('ECONNREFUSED') })
  })
})

describe('nodeRequester', () => {
  let close: (() => void) | null = null
  afterEach(() => { close?.(); close = null })

  test('connects to the pinned address, sends no credentials, and streams the reply', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const server = createServer((req, res) => {
      seen = req.headers
      res.setHeader('content-type', 'text/plain')
      res.end('pinned reply')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    close = () => server.close()
    const port = (server.address() as AddressInfo).port
    const res = await nodeRequester({ url: new URL(`http://unresolvable.invalid:${port}/x`), address: '127.0.0.1', family: 4, signal: new AbortController().signal })
    let text = ''
    for await (const chunk of res.body) text += Buffer.from(chunk).toString()
    expect(res.status).toBe(200)
    expect(text).toBe('pinned reply')
    expect(seen.host).toBe(`unresolvable.invalid:${port}`)
    expect(seen.authorization).toBeUndefined()
    expect(seen.cookie).toBeUndefined()
  })
})
