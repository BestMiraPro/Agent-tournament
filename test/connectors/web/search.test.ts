import { describe, expect, test } from 'vitest'
import {
  EXA_MCP_URL,
  HttpTimeoutError,
  LANGSEARCH_URL,
  parseExaText,
  webSearch,
  WebSearchError,
  type HttpPost,
} from '../../../src/connectors/web/search.js'

const LS_KEY = 'ls-SECRET-KEY-123'
const EXA_KEY = 'exa-SECRET-KEY-456'

const langsearchOk = JSON.stringify({
  code: 200,
  data: {
    webPages: {
      value: [
        { name: 'Node net docs', url: 'https://nodejs.org/api/net.html', snippet: 'BlockList rules', datePublished: '2026-10-01' },
        { name: 'No date', url: 'https://example.com/x', snippet: 'second' },
      ],
    },
  },
  usage: { input_tokens: 4, output_tokens: 20 },
})

const exaText = [
  'Title: Exa result one',
  'URL: https://exa.example/one',
  'Published: 2026-04-21T00:00:00.000Z',
  'Author: N/A',
  'Highlights:',
  'first highlight',
  'more of it',
  '',
  '---',
  '',
  'Title: Exa result two',
  'URL: https://exa.example/two',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'second highlight',
].join('\n')
const exaSse = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text: exaText }] }, jsonrpc: '2.0', id: 1 })}\n\n`

type Reply = { status: number; body: string } | Error
function fakePost(replies: Record<string, Reply>) {
  const calls: Parameters<HttpPost>[0][] = []
  const post: HttpPost = async (req) => {
    calls.push(req)
    const reply = replies[req.url]
    if (!reply) throw new Error(`unexpected ${req.url}`)
    if (reply instanceof Error) throw reply
    return reply
  }
  return { post, calls }
}

describe('webSearch', () => {
  test('LangSearch answers when its key is configured', async () => {
    const net = fakePost({ [LANGSEARCH_URL]: { status: 200, body: langsearchOk } })
    const out = await webSearch('node blocklist', 2, { keys: { langsearch: LS_KEY, exa: null }, post: net.post })
    expect(out).toMatchObject({ provider: 'langsearch', fallback: null, status: 200 })
    expect(out.results).toEqual([
      { title: 'Node net docs', url: 'https://nodejs.org/api/net.html', snippet: 'BlockList rules', published: '2026-10-01' },
      { title: 'No date', url: 'https://example.com/x', snippet: 'second', published: null },
    ])
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0]!.headers.authorization).toBe(`Bearer ${LS_KEY}`)
    expect(JSON.parse(net.calls[0]!.body)).toEqual({ query: 'node blocklist', count: 2 })
  })

  const matrix: [string, Reply | null, string][] = [
    ['missing key', null, 'missing_key'],
    ['401', { status: 401, body: '{"code":401,"msg":"bad key"}' }, 'unauthorized'],
    ['403', { status: 403, body: 'forbidden' }, 'unauthorized'],
    ['429 rate', { status: 429, body: '{"code":429,"msg":"Too many requests per second"}' }, 'rate_limited'],
    ['429 allowance', { status: 429, body: '{"code":429,"msg":"Daily token allowance exceeded"}' }, 'quota_exhausted'],
    ['402', { status: 402, body: '' }, 'quota_exhausted'],
    ['432', { status: 432, body: '' }, 'quota_exhausted'],
    ['200 with an error code', { status: 200, body: '{"code":429,"msg":"limit"}' }, 'rate_limited'],
    ['500', { status: 500, body: 'oops' }, 'server_error'],
    ['502', { status: 502, body: '' }, 'server_error'],
    ['503', { status: 503, body: '' }, 'server_error'],
    ['timeout', new HttpTimeoutError(), 'timeout'],
    ['network', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'network'],
    ['not JSON', { status: 200, body: '<html>maintenance</html>' }, 'bad_response'],
    ['wrong shape', { status: 200, body: '{"code":200,"data":{}}' }, 'bad_response'],
    ['400', { status: 400, body: '{"code":400}' }, 'client_error'],
  ]
  test.each(matrix)('falls back to Exa on %s', async (_name, reply, reason) => {
    const net = fakePost({ ...(reply ? { [LANGSEARCH_URL]: reply } : {}), [EXA_MCP_URL]: { status: 200, body: exaSse } })
    const out = await webSearch('q', 5, { keys: { langsearch: reply ? LS_KEY : null, exa: null }, post: net.post })
    expect(out.provider).toBe('exa')
    expect(out.fallback).toEqual({ from: 'langsearch', reason })
    expect(out.results.map((r) => r.url)).toEqual(['https://exa.example/one', 'https://exa.example/two'])
    expect(JSON.stringify(out)).not.toContain(LS_KEY)
  })

  test('Exa is keyless by default, over IPv4, and keyed with x-api-key when EXA_API_KEY is set', async () => {
    const keyless = fakePost({ [EXA_MCP_URL]: { status: 200, body: exaSse } })
    await webSearch('q', 3, { keys: { langsearch: null, exa: null }, post: keyless.post })
    const call = keyless.calls[0]!
    expect(call.headers['x-api-key']).toBeUndefined()
    expect(call.family).toBe(4)
    expect(call.url).toBe('https://mcp.exa.ai/mcp')
    expect(JSON.parse(call.body)).toEqual({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: 'q', numResults: 3, objective: 'q' } },
    })
    const keyed = fakePost({ [EXA_MCP_URL]: { status: 200, body: exaSse } })
    await webSearch('q', 3, { keys: { langsearch: null, exa: EXA_KEY }, post: keyed.post })
    expect(keyed.calls[0]!.headers['x-api-key']).toBe(EXA_KEY)
    expect(keyed.calls[0]!.url).not.toContain(EXA_KEY)
  })

  test('both failing is one error naming both reasons and neither key', async () => {
    const net = fakePost({ [LANGSEARCH_URL]: { status: 429, body: `{"msg":"key ${LS_KEY} over"}` }, [EXA_MCP_URL]: { status: 503, body: `upstream said ${EXA_KEY}` } })
    const err = await webSearch('q', 5, { keys: { langsearch: LS_KEY, exa: EXA_KEY }, post: net.post }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WebSearchError)
    expect(err).toMatchObject({ primary: 'rate_limited', fallback: 'server_error' })
    expect((err as Error).message).toBe('web search failed: langsearch rate_limited, then exa server_error')
    expect(JSON.stringify(err)).not.toContain('SECRET')
  })

  test('an Exa JSON-RPC error or tool error is a bad response', async () => {
    for (const body of [
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad args' } }),
      `data: ${JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: 'failed' }] } })}\n\n`,
    ]) {
      const net = fakePost({ [EXA_MCP_URL]: { status: 200, body } })
      await expect(webSearch('q', 5, { keys: { langsearch: null, exa: null }, post: net.post })).rejects.toMatchObject({ primary: 'missing_key', fallback: 'bad_response' })
    }
  })

  test('snippets are capped and results limited to what was asked', async () => {
    const long = JSON.stringify({ code: 200, data: { webPages: { value: Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, url: `https://e.example/${i}`, snippet: 'y'.repeat(5000) })) } } })
    const net = fakePost({ [LANGSEARCH_URL]: { status: 200, body: long } })
    const out = await webSearch('q', 3, { keys: { langsearch: LS_KEY, exa: null }, post: net.post })
    expect(out.results).toHaveLength(3)
    expect(out.results[0]!.snippet.length).toBeLessThanOrEqual(1001)
  })
})

describe('parseExaText', () => {
  test('reads Title/URL/Published/Highlights blocks; N/A dates are null', () => {
    expect(parseExaText(exaText)).toEqual([
      { title: 'Exa result one', url: 'https://exa.example/one', published: '2026-04-21T00:00:00.000Z', snippet: 'first highlight\nmore of it' },
      { title: 'Exa result two', url: 'https://exa.example/two', published: null, snippet: 'second highlight' },
    ])
  })

  test('blocks without a URL are dropped', () => {
    expect(parseExaText('No results found.')).toEqual([])
  })
})
