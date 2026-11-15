import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, test } from 'vitest'
import { describeWebCall, fetchTarget, searchTarget, webCallEvent, type WebCallRecord } from '../../../src/connectors/web/evidence.js'
import { WebLimiter } from '../../../src/connectors/web/limits.js'
import { createWebMcpServer, webConnector, type WebServerDeps } from '../../../src/connectors/web/mcp-server.js'
import { EXA_MCP_URL, LANGSEARCH_URL, type HttpPost } from '../../../src/connectors/web/search.js'
import type { PinnedRequester } from '../../../src/connectors/web/fetch-page.js'

const LS_KEY = 'ls-SECRET-0001'

const langsearchBody = JSON.stringify({ code: 200, data: { webPages: { value: [{ name: 'A result', url: 'https://a.example/x', snippet: 'about a' }] } } })
const post: HttpPost = async (req) => {
  if (req.url === LANGSEARCH_URL) return { status: 200, body: langsearchBody }
  if (req.url === EXA_MCP_URL) return { status: 503, body: '' }
  throw new Error('unexpected')
}
const request: PinnedRequester = async ({ url }) => ({
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: (async function* () { yield Buffer.from(`<title>Page</title><p>Body of ${url.pathname}</p>`) })(),
})

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  return client
}

function harness(over: Partial<WebServerDeps> = {}) {
  const records: WebCallRecord[] = []
  let t = 1000
  const deps: WebServerDeps = {
    runId: 'run-1',
    agentId: 'agent-a',
    evidence: (r) => records.push(r),
    limiter: new WebLimiter(),
    keys: () => ({ langsearch: LS_KEY, exa: null }),
    post,
    fetchDeps: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request },
    now: () => (t += 5),
    ...over,
  }
  return { deps, records, server: createWebMcpServer(deps) }
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text)

describe('createWebMcpServer', () => {
  test('lists web_search and web_fetch with bounded input schemas', async () => {
    const client = await connect(harness().server)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search'])
    const search = tools.find((t) => t.name === 'web_search')!
    expect(search.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 400 },
        maxResults: { type: 'integer', minimum: 1, maximum: 10 },
      },
    })
    expect(search.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true })
    const fetch = tools.find((t) => t.name === 'web_fetch')!
    expect(fetch.inputSchema).toMatchObject({ type: 'object', required: ['url'], properties: { url: { type: 'string', maxLength: 2048 } } })
  })

  test('a search answers with the provider named and records one evidence entry', async () => {
    const h = harness()
    const client = await connect(h.server)
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'what is a', maxResults: 3 } })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('via LangSearch')
    expect(text(result)).toContain('1. A result\n   https://a.example/x\n   about a')
    expect(h.records).toEqual([{
      id: 'W1', runId: 'run-1', agentId: 'agent-a', tool: 'web_search', target: 'what is a',
      outcome: 'completed', provider: 'langsearch', status: 200, bytes: Buffer.byteLength(langsearchBody), results: 1,
      startedAt: 1005, durationMs: 5,
    }])
  })

  test('a fetch returns readable text; the record keeps host and path only', async () => {
    const h = harness()
    const client = await connect(h.server)
    const result = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://docs.example/guide/intro?token=abc#part' } })
    expect(text(result)).toContain('URL: https://docs.example/guide/intro?token=abc#part')
    expect(text(result)).toContain('Title: Page')
    expect(text(result)).toContain('Body of /guide/intro')
    expect(h.records[0]).toMatchObject({ tool: 'web_fetch', target: 'docs.example/guide/intro', outcome: 'completed', status: 200 })
    expect(JSON.stringify(h.records)).not.toContain('token=abc')
  })

  test('a blocked address is denied and recorded as such', async () => {
    const h = harness()
    const client = await connect(h.server)
    const result = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/not on the public internet/)
    expect(h.records[0]).toMatchObject({ outcome: 'denied', error: 'blocked_address', target: '169.254.169.254/latest/meta-data/' })
  })

  test('limits refuse further calls, and every refusal is recorded', async () => {
    const h = harness({ limiter: new WebLimiter({ searchesPerAgent: 1 }) })
    const client = await connect(h.server)
    await client.callTool({ name: 'web_search', arguments: { query: 'one' } })
    const refused = await client.callTool({ name: 'web_search', arguments: { query: 'two' } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/1 web searches/)
    expect(h.records.map((r) => [r.id, r.outcome, r.error ?? null])).toEqual([['W1', 'completed', null], ['W2', 'denied', 'agent_limit']])
  })

  test('a stopped run refuses everything', async () => {
    const h = harness()
    h.deps.limiter.close()
    const client = await connect(h.server)
    const result = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://a.example/' } })
    expect(result.isError).toBe(true)
    expect(h.records[0]).toMatchObject({ outcome: 'denied', error: 'run_stopped' })
  })

  test('both providers failing is a failed call with fixed reasons and no key', async () => {
    const failing: HttpPost = async (req) => ({ status: req.url === LANGSEARCH_URL ? 401 : 500, body: `echo ${LS_KEY}` })
    const h = harness({ post: failing })
    const client = await connect(h.server)
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'q' } })
    expect(result.isError).toBe(true)
    expect(h.records[0]).toMatchObject({ outcome: 'failed', fallbackReason: 'unauthorized', error: 'exa_server_error' })
    expect(JSON.stringify([result, h.records])).not.toContain(LS_KEY)
  })

  test('a broken evidence sink never breaks the tool call', async () => {
    const h = harness({ evidence: () => { throw new Error('sink down') } })
    const client = await connect(h.server)
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'q' } })
    expect(result.isError).toBeFalsy()
  })
})

describe('webConnector', () => {
  test('one limiter per run shared by its agents; ending the run refuses its servers', async () => {
    const records: WebCallRecord[] = []
    const web = webConnector({ limits: { searchesPerRun: 1 }, keys: () => ({ langsearch: LS_KEY, exa: null }), post })
    const a = await connect(web.createServer({ runId: 'r', agentId: 'a', evidence: (rec) => records.push(rec) }))
    const b = await connect(web.createServer({ runId: 'r', agentId: 'b', evidence: (rec) => records.push(rec) }))
    const other = await connect(web.createServer({ runId: 'r2', agentId: 'a', evidence: (rec) => records.push(rec) }))
    expect((await a.callTool({ name: 'web_search', arguments: { query: 'x' } })).isError).toBeFalsy()
    expect((await b.callTool({ name: 'web_search', arguments: { query: 'x' } })).isError).toBe(true)
    expect((await other.callTool({ name: 'web_search', arguments: { query: 'x' } })).isError).toBeFalsy()
    web.endRun('r2')
    expect((await other.callTool({ name: 'web_search', arguments: { query: 'x' } })).isError).toBe(true)
    expect(records.map((r) => `${r.runId}/${r.agentId}/${r.id}/${r.outcome}`)).toEqual(['r/a/W1/completed', 'r/b/W2/denied', 'r2/a/W1/completed', 'r2/a/W2/denied'])
  })
})

describe('evidence helpers', () => {
  test('targets are bounded and redacted', () => {
    expect(fetchTarget('https://user@example.com:8443/a/b?q=1#f')).toBe('example.com:8443/a/b')
    expect(fetchTarget('not a url')).toBe('(invalid URL)')
    expect(fetchTarget(`https://e.example/${'p'.repeat(500)}`).length).toBeLessThanOrEqual(201)
    expect(searchTarget('find api_key=sk-123 docs')).toBe('find api_key=[redacted] docs')
    expect(searchTarget('x'.repeat(500)).length).toBe(200)
  })

  test('a record becomes an agent.web event with a one-line summary', () => {
    const record: WebCallRecord = {
      id: 'W3', runId: 'r', agentId: 'a', tool: 'web_search', target: 'rust async', outcome: 'completed',
      provider: 'exa', fallbackReason: 'rate_limited', status: 200, bytes: 900, results: 5, startedAt: 10, durationMs: 300,
    }
    expect(describeWebCall(record)).toEqual({
      summary: 'web_search "rust async" via Exa (LangSearch rate_limited): 5 results',
      detail: 'outcome=completed provider=exa fallback_reason=rate_limited status=200 bytes=900 results=5 duration_ms=300',
    })
    expect(webCallEvent(record)).toEqual({
      type: 'agent.web', runId: 'r', agentId: 'a', callId: 'W3', tool: 'web_search', outcome: 'completed', at: 10,
      ...describeWebCall(record),
    })
  })
})
